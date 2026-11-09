/**
 * lib/tools.js — cu_* 工具族
 *
 * 13 个工具，覆盖「看一眼 → 点一下 → 验一下」的完整闭环，外加三个逃生口
 * （cu_call 通用转发、cu_doctor 体检、cu_recover 一条命令走完诊断阶梯），
 * 以及 0.3.4 的覆盖层诊断（cu_cursor）与三个高频便捷动作（cu_scroll / cu_drag / cu_clipboard）。
 * 仍刻意不做 59 个工具的平铺映射：工具定义本身吃 token，其余冷门能力留给 cu_call 更划算。
 *
 * 0.2.0 修的是实测踩到的三个坑（懒发布 / 键盘只能前台 / 陈旧 UWP 实例）。
 *
 * 0.3.0 修的是「模型老想很久，然后还是不行」的四个根因：
 *   1. **观察太吵**：一次 cu_state 吐 14KB（滚动条三键 + 状态栏四段文字 + 每行 actions/坐标），
 *      模型每轮都要啃一遍 → 默认视图只留可点元素 + 祖先链，行末裸 token。
 *   2. **点错了通道**：`actions=[expand]` 的元素（菜单项 / 树节点）用默认 invoke 是静默空点，
 *      effect 只回 unverifiable → 现在按元素的 actions 自动挑动作，失败还自动升到 foreground。
 *   3. **结果不可判**：点了菜单/对话框，树在**另一个窗口**里长出来，旧逻辑只重读原窗口 → 元素数不变
 *      → 模型以为失败 → 反复重试。现在点击后顺带对比窗口表，新窗口直接点名。
 *   4. **往返太多**：每次都要先 cu_windows 拿 pid/windowId。现在 cu_state / cu_click / cu_key /
 *      cu_verify 都能直接吃 `title`，内部解析，省一整轮。
 */

import path from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { defineTool } from './tool-kit.js'
import { DRIVER_COMPONENTS_ROOT, DriverError } from './driver.js'
import { fmtApps, fmtClick, fmtState, fmtStateRows, fmtTools, fmtVerify, fmtWindowInfo, fmtWindows } from './format.js'
import { attachImage, markPoint, pngSize } from './shot.js'
import { KeyboardOverlay } from './overlay.js'

/** 首读少于此数就认为「可能还在懒发布」，自动重读 */
const SETTLE_MIN_ELEMENTS = 8
/** 点击后附带的迷你快照预算（让模型不必再发一次 cu_state） */
const BRIEF_MAX_CHARS = 1600

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 统一输出形状：文本 +（可选）图片。
 *
 * 为什么不是「只吐一段文本」：截图要真正交给模型看，必须作为 image content block
 * 出现在 render 的返回值里（宿主 attachments 服务给的引用）。value.images 由
 * run() 在 execute 阶段异步换好（saveImage 是异步的，render 是同步的）。
 */
function textOutput(fn) {
  return defineTool({
    name: fn.name,
    description: fn.description,
    parameters: fn.parameters || {},
    ...(fn.timeoutMs ? { timeoutMs: fn.timeoutMs } : {}),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        try {
          const blocks = [{ type: 'text', text: (value && value.text) || JSON.stringify(value) }]
          for (const img of Array.isArray(value?.images) ? value.images : []) {
            if (!img?.attachmentId) continue
            blocks.push({
              type: 'image',
              attachment: {
                attachmentId: img.attachmentId,
                mediaType: img.mediaType || 'image/png',
                bytes: img.bytes,
                width: img.width,
                height: img.height,
                ...(img.name ? { name: img.name } : {}),
              },
            })
          }
          return blocks
        } catch (err) {
          // render 是 execute 之外、由宿主同步调用的一层；execute 里的异常已转成可读文本，
          // 这里再抛出去会变成工具级崩溃（唯一能把异常冒泡给宿主的路径）。
          return [{ type: 'text', text: `✗ ${fn.name} 结果渲染失败：${err instanceof Error ? err.message : String(err)}` }]
        }
      },
    },
    async execute(args, exec) {
      try {
        const out = await fn.run(args || {}, exec)
        return out && typeof out === 'object' ? out : { text: String(out) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const hint = error instanceof DriverError ? `（${error.code}）` : ''
        return { ok: false, error: message, text: `✗ ${fn.name} 失败${hint}：${message}` }
      }
    },
  })
}

function expandHome(p) {
  if (!p) return p
  const s = String(p)
  // `~somebody` 不是本用户主目录；只展开 `~` / `~/` / `~\`
  return s === '~' || s.startsWith('~/') || s.startsWith('~\\') ? path.join(homedir(), s.slice(1)) : s
}

/** 把 0/undefined 当成"没给" */
function posInt(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** 允许 0 的整数参数（index 就是从 0 开始的，不能用 posInt） */
function intArg(v) {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

const clipText = (s, max = 30) => {
  const t = String(s ?? '')
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

/**
 * 语义树指纹：数量 + 每行的 role/label/value/selected/enabled。
 *
 * 为什么不能只比元素数：X（Twitter）点「喜欢」后，元素数一个不变，
 * 变的只是那一个按钮的标签（`945 喜欢次数。喜欢` → `948 喜欢次数。喜欢了`）。
 * 只比数量就会把**成功**判成失败，然后按阶梯重投一次 —— toggle 类控件被点回去，
 * 用户看到的就是「点了没反应」。
 */
function treeDigest(sc) {
  const els = Array.isArray(sc?.elements) ? sc.elements : []
  let h = 2166136261
  for (const e of els) {
    const row = `${e.role}\u0001${e.label ?? ''}\u0001${e.value ?? ''}\u0001${e.selected === true ? 1 : 0}\u0001${e.enabled === false ? 0 : 1}\u0002`
    for (let i = 0; i < row.length; i++) {
      h ^= row.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
  }
  return `${els.length}/${(h >>> 0).toString(16)}`
}

/** 窗口状态串：最小化 / 离屏 / 在屏 */
const winState = (w) => (w ? `${w.minimized === true ? 'min' : 'normal'}/${w.is_on_screen !== false ? 'onscreen' : 'off'}` : 'gone')

/**
 * 点一下「没有可比对状态」的角色：只反映焦点，UIA 里 label/value/selected 一概不动。
 * 模块级常量（不在每次调用里重建）。
 */
const FOCUS_ONLY_ROLES = new Set(['edit', 'text', 'document', 'textbox', 'richedit', 'richtextbox', 'searchbox'])

/** 有这些动作的元素，点一下一定能在树里看出变化（勾选/展开/调用/按下/选择） */
const TOGGLE_ACTIONS = new Set(['toggle', 'expand', 'collapse', 'invoke', 'press', 'select'])

function errText(res) {
  const code = res?.structured?.code ? `（${res.structured.code}）` : ''
  return `✗ 驱动报错${code}：${res.text || '(无内容)'}`
}

function asObject(value, label) {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch (e) {
      throw new Error(`${label} 不是合法 JSON：${e.message}`)
    }
  }
  return value
}

/**
 * @param {object} deps
 * @param {import('./driver.js').DriverBridge} deps.bridge
 * @param {object} deps.config 已合并默认值
 */
/**
 * 截图保留策略（默认关闭）。只在显式设置 maxFiles / maxAgeDays 后才生效，
 * 且**只删本插件自己命名的 PNG**，每批最多 50 个；目录里其它文件一律不碰。
 * 抽成模块级纯函数是为了能离线验证「不会误删用户文件」这条安全边界。
 */
export function pruneShotFiles(dir, { maxFiles = 0, maxAgeDays = 0 } = {}) {
  if (!maxFiles && !maxAgeDays) return 0
  const OWN = /^(state|click|click-before|shot)-[\w-]+\.png$/
  let removed = 0
  try {
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && OWN.test(e.name))
      .map((e) => {
        try {
          return { name: e.name, mtimeMs: statSync(path.join(dir, e.name)).mtimeMs }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    const doomed = []
    if (maxFiles && files.length > maxFiles) doomed.push(...files.slice(maxFiles).map((f) => f.name))
    if (maxAgeDays) {
      const cutoff = Date.now() - maxAgeDays * 86400000
      for (const f of files) if (f.mtimeMs < cutoff && !doomed.includes(f.name)) doomed.push(f.name)
    }
    for (const name of doomed.slice(0, 50)) {
      try {
        unlinkSync(path.join(dir, name))
        removed += 1
      } catch {
        /* 被占用或被外部删了就算了 */
      }
    }
  } catch {
    /* 目录不可读不影响本次截图 */
  }
  return removed
}

/* cursor 是驱动侧「session 级」状态，进程内所有插件实例共享一份配置进度，
 * 不必每个 createTools 都重配一遍（也会让离线自检的 RPC 次数乱掉）。 */
const AGENT_SESSION = 'dsh-computer-use-pro'
const CURSOR_MOTION = {
  timing: 'fixed',
  glide_duration_ms: 120,
  idle_hide_ms: 0, // 关键：0 = 永不自动隐藏
  effects: { glow: true, ripple: true },
}
const CURSOR_RECHECK_MS = 30000
const cursor = {
  configured: false, unsupported: false, checkedAt: 0, attempts: 0,
  enabled: false, idleHideMs: null, position: null, visual: null, lastError: '',
}

export function createTools({ bridge, config: cfg, logger, isEnabled, ctx = null }) {
  /* --------------------------------------------------------- 内部小工具 */

  /** 桌面按键浮窗：懒启动、失败降级；测试可注入假 spawn（见 overlay.js） */
  const overlay = new KeyboardOverlay({
    // 必须显式开启：冒烟测试用的是手写 cfg，不能因为「没写这个键」就弹真浮窗
    enabled: cfg.keyboardOverlayWindow === true && cfg.keyboardOverlay !== false,
    durationMs: Number(cfg.overlayDurationMs) || 1400,
    idleShutdownMs: Number(cfg.overlayIdleShutdownMs ?? 60000),
    theme: cfg.overlayTheme,
    fontSize: cfg.overlayFontSize,
    opacity: (Number(cfg.overlayOpacityPct) || 93) / 100,
    position: cfg.overlayPosition,
    fadeMs: cfg.overlayFadeMs,
    logger,
    ...(cfg.overlaySpawnImpl ? { spawnImpl: cfg.overlaySpawnImpl } : {}),
  })

  /* 性能档位：少一轮 settle = 少一次 readState + 一次 list_windows，
   * 一次 cu_click 本来要 3~7 次 RPC，这是最直接的省法。 */
  const OBSERVE_DELAYS = { fast: [0, 150], balanced: [0, 220, 380], thorough: [0, 220, 380, 600] }
  const settleDelays = OBSERVE_DELAYS[String(cfg.observeProfile ?? 'balanced')] ?? OBSERVE_DELAYS.balanced
  const targetCacheMs = Number(cfg.targetCacheMs ?? 1500)
  const targetCache = new Map()

  /** 保留策略由配置驱动；具体实现抽到模块级，便于离线断言直接验证 */
  const pruneShots = (dir) =>
    pruneShotFiles(dir, {
      maxFiles: posInt(cfg.screenshotMaxFiles),
      maxAgeDays: posInt(cfg.screenshotMaxAgeDays),
    })

  /** 自动截图落盘路径（每次一个文件，方便复现；目录来自 screenshotDir） */
  const shotFile = (kind, pid, windowId) => {
    const dir = expandHome(cfg.screenshotDir || '~/.dsh/computer-use/shots')
    try {
      mkdirSync(dir, { recursive: true })
      pruneShots(dir)
    } catch {
      /* 目录建不出来时让后续写文件失败并如实报出来 */
    }
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    return path.join(dir, `${kind}-${pid}-${windowId}-${stamp}.png`)
  }

  /**
   * 截图与窗口的坐标关系（实测，驱动 0.34.1）：
   *   · PNG 是**原样**的窗口内容（不含 1px 窗口边框），宽高各比 window_bounds 少 2；
   *   · 驱动的 click x,y 与 PNG 像素同源（拿 PNG 上的坐标直接点，实测 1:1 命中）；
   *   · 高 DPI 下 PNG 是设备像素、window_bounds 是屏幕点，换算 scale = pngW / (boundsW - 2)。
   *     click 不用我们换算（驱动自己按截图空间收），这里只用于把点换算成屏幕坐标去摆覆盖层。
   */
  const shotMeta = (sc, file) => {
    let dims = null
    try {
      dims = pngSize(readFileSync(file))
    } catch {
      dims = null
    }
    const wb = sc?.window_bounds ?? null
    const width = Number(sc?.screenshot_width) || dims?.width || 0
    const height = Number(sc?.screenshot_height) || dims?.height || 0
    const raw = wb && Number(wb.width) > 2 ? width / (Number(wb.width) - 2) : 1
    const scale = Number.isFinite(raw) && raw > 0.2 && raw < 4 ? raw : 1
    return { dims, width, height, wb, scale }
  }

  /** 截图像素 → 屏幕点（只用来摆 agent cursor 覆盖层） */
  const shotToScreen = (meta, x, y) =>
    meta?.wb ? { x: Number(meta.wb.x) + 1 + Number(x) * meta.scale, y: Number(meta.wb.y) + 1 + Number(y) * meta.scale } : null

  /** 屏幕点 → 截图像素（把控件矩形换成图上的标记位置） */
  const screenToShot = (meta, x, y) =>
    meta?.wb ? { x: (Number(x) - Number(meta.wb.x) - 1) / meta.scale, y: (Number(y) - Number(meta.wb.y) - 1) / meta.scale } : null

  /**
   * 把落盘的截图交付成模型看得见的图片：
   *   ① 有 marks 就在像素上画标记（agent cursor 覆盖层进不了窗口截图，见 shot.js）；
   *   ② 交给宿主 attachments → ImageBlock；拿不到通道就只落盘并把原因写清楚。
   */
  const deliverShot = async (exec, file, opts = {}) => {
    let buf
    try {
      buf = readFileSync(file)
    } catch {
      return { images: [], text: `⚠ 截图没生成（驱动忽略了 screenshot_out_file，或窗口当前不可捕获）：${file}` }
    }
    const size = pngSize(buf)
    if (!size) return { images: [], text: `⚠ 截图文件不是 PNG（${buf.length} 字节）：${file}` }
    const original = buf
    const marks = Array.isArray(opts.marks) ? opts.marks.filter((m) => Number.isFinite(m?.x) && Number.isFinite(m?.y)) : []
    if (marks.length) {
      const marked = markPoint(buf, marks[0])
      // markPoint 会把整图解码成 RGBA 再重编码，大图常常比驱动优化过的原 PNG 更大。
      // 膨胀太多就别画了 —— 否则可能越过宿主 maxImageBytes，标记反倒把图弄丢了。
      if (marked && marked.length <= original.length * 1.5) {
        // 落盘版本也带标记：用户复现时看到的就是模型看到的那张
        try {
          writeFileSync(file, marked)
          buf = marked
        } catch {
          /* 写回失败不影响交付 */
        }
      }
    }
    const attach = (data) => attachImage({ ctx, exec, data, name: path.basename(file), logger })
    let res = await attach(buf)
    // 兜底：标记后的图真超限时，退回未标记的原图再交一次，别让图片整个消失
    if (!res.image && buf !== original && /超过宿主单图上限/.test(res.reason)) res = await attach(original)
    const lines = [`截图：${file} · ${size.width}x${size.height} px（自然分辨率，未缩放）`]
    if (res.image) lines.push('图片已随本结果一起返回（image content block，可直接看画面）')
    else lines.push(`⚠ 图片没能随结果返回：${res.reason}；只能读本地文件`)
    return { images: res.image ? [res.image] : [], text: lines.join('\n') }
  }

  /* ------------------------------------------------ 鼠标 / 键盘可视化 */
  /**
   * 「鼠标 UI 老是不见」的实测根因（驱动 0.34.1，2026-11-09）：
   *   `get_agent_cursor_state` 回 `enabled:true`、`idle_hide_ms=15000`、`position=null`、
   *   `timing=native / glide=0` —— 闲置 15 秒覆盖层自动隐藏，而且从没被放到屏幕上。
   *   旧实现只设过一次 120ms 直移，既没关 idle_hide，也从不主动启用覆盖层，
   *   所有失败还被 `catch {}` 吞掉，于是「看不见、也查不出原因」。
   *
   * `move_cursor` 的正确形状（实测）：
   *   `{ session, target:{kind:'window',pid,window_id}, x, y }`，**不能带 scope**
   *   （带 `scope:'window'` 回 `invalid_action_target`；带扁平 pid 回 `unknown argument pid`）。
   *   x,y 与驱动其它动作一致 = 窗口局部截图像素，不是屏幕绝对点。
   */
  const cursorState = async () => {
    try {
      const r = await bridge.callTool('get_agent_cursor_state', { session: AGENT_SESSION }, 8000)
      const s = r.structured ?? null
      if (s && typeof s === 'object') {
        cursor.enabled = s.enabled === true
        cursor.idleHideMs = Number(s.motion?.idle_hide_ms)
        cursor.position = s.position ?? null
        cursor.visual = s.visual_state ?? null
      }
      return s
    } catch (err) {
      cursor.lastError = `读光标状态失败：${err instanceof Error ? err.message : err}`
      return null
    }
  }

  /** 保证覆盖层可见；回读驱动状态验证，并把诊断写进输出（失败绝不影响点击/键盘） */
  const ensureCursorVisible = async (force = false) => {
    if (!force && cursor.unsupported) return []
    const now = Date.now()
    if (!force && cursor.configured && now - cursor.checkedAt < CURSOR_RECHECK_MS) return []
    cursor.checkedAt = now
    cursor.attempts += 1

    // 先探活：老驱动 / 假驱动没有这套 cursor 工具面时只花 1 次 RPC，之后永久跳过
    const state = await cursorState()
    if (!state || typeof state.enabled !== 'boolean') {
      if (!cursor.unsupported) {
        cursor.unsupported = true
        return ['（ℹ 当前驱动没有 agent cursor 状态接口，跳过覆盖层自愈；动作本身不受影响）']
      }
      return []
    }
    // 之前因「驱动没有这套接口」被标记过，现在状态又可用了（换了驱动 / 用户手动 show）：恢复自愈
    cursor.unsupported = false

    const notes = []
    const needsEnable = state.enabled !== true
    const needsMotion = Number(state.motion?.idle_hide_ms) !== 0 || state.motion?.timing !== 'fixed'
    if (needsEnable || needsMotion || force) {
      if (needsEnable || force) {
        try {
          await bridge.callTool('set_agent_cursor_enabled', { session: AGENT_SESSION, enabled: true }, 8000)
        } catch (err) {
          notes.push(`（⚠ 启用鼠标覆盖层失败：${err instanceof Error ? err.message : err}）`)
        }
      }
      if (needsMotion || force) {
        try {
          await bridge.callTool('set_agent_cursor_motion', { session: AGENT_SESSION, ...CURSOR_MOTION }, 8000)
        } catch (err) {
          notes.push(`（⚠ 配置光标动效失败：${err instanceof Error ? err.message : err}）`)
        }
      }
      const after = await cursorState()
      cursor.configured = after?.enabled === true && Number(after?.motion?.idle_hide_ms) === 0
      notes.push(
        cursor.configured
          ? '（鼠标覆盖层已自愈：启用 + 关闭 15 秒自动隐藏 + 120ms 直移）'
          : `（⚠ 鼠标覆盖层仍未确认可见：enabled=${after?.enabled ?? '?'} idleHide=${after?.motion?.idle_hide_ms ?? '?'}${cursor.lastError ? ` · ${cursor.lastError}` : ''}）`,
      )
    } else {
      cursor.configured = true
    }
    return notes
  }

  /** 把覆盖层挪到窗口局部坐标；坐标无效时只保证可见 */
  const placeCursor = async (pid, windowId, x, y) => {
    const notes = await ensureCursorVisible()
    if (!Number.isFinite(x) || !Number.isFinite(y)) return notes
    try {
      await bridge.callTool('move_cursor', { session: AGENT_SESSION, target: { kind: 'window', pid, window_id: windowId }, x, y }, 8000)
      cursor.position = { x, y }
    } catch (err) {
      notes.push(`（⚠ 光标定位失败：${err instanceof Error ? err.message : err}；点击本身不受影响）`)
    }
    return notes
  }

  /** 截图坐标落点上的最小元素（用于说明「点到了谁」） */
  const elementAtShot = (sc, x, y, meta) => {
    const pt = shotToScreen(meta, x, y)
    if (!pt) return null
    let best = null
    for (const e of Array.isArray(sc?.elements) ? sc.elements : []) {
      const f = frameOf(e)
      if (!f) continue
      if (pt.x < f.x || pt.y < f.y || pt.x > f.x + f.w || pt.y > f.y + f.h) continue
      if (!best || f.w * f.h < frameOf(best).w * frameOf(best).h) best = e
    }
    return best
  }


  /** 列可见窗口（已过滤驱动自己的光标覆盖层） */
  const listWindows = async () => {
    const res = await bridge.callTool('list_windows', { on_screen_only: true }, 15000)
    const all = Array.isArray(res.structured?.windows) ? res.structured.windows : []
    return all.filter((w) => !/minimax-computer-use\.exe/i.test(String(w.app_name ?? '')))
  }

  /**
   * 列**全部**顶层窗口（含最小化/离屏）。
   * `on_screen_only:true` 会把最小化窗口整个筛掉 —— 只看它就会得出「窗口不见了」，
   * 而真相往往是「窗口在，但最小化了，foreground/像素点击全部静默落空」。
   */
  const listAllWindows = async () => {
    const res = await bridge.callTool('list_windows', { on_screen_only: false }, 15000)
    const all = Array.isArray(res.structured?.windows) ? res.structured.windows : []
    return all.filter((w) => !/minimax-computer-use\.exe/i.test(String(w.app_name ?? '')))
  }

  /**
   * 目标窗口最小化/离屏时先恢复。
   *
   * 实测（驱动 0.34.1）：最小化窗口的 `bounds` 是 `146x28@-31993,-32000`（图标占位符），
   * UIA 树照样能读、`invoke` 也能生效，但 `foreground`/像素点击会被投递到那个占位符上，
   * 结果 `effect=unverifiable` + 元素数不变 —— 看起来就像「点不到」。
   * 驱动自己只会在某些元素上明确回 `window_minimized`，多数时候是静默空点。
   */
  const ensureWindowVisible = async (pid, windowId, opts = {}) => {
    const wins = Array.isArray(opts.wins) ? opts.wins : await listAllWindows().catch(() => [])
    const w =
      wins.find((x) => x.pid === pid && x.window_id === windowId) ??
      (windowId ? wins.find((x) => x.window_id === windowId) : null) ??
      (windowId ? null : wins.find((x) => x.pid === pid))
    if (!w) return { wins, note: '', restored: false, state: 'gone' }
    const state = winState(w)
    const looksMin = w.minimized === true || w.is_on_screen === false
    // 驱动亲口说 window_minimized 时传 force：以驱动为准，别被 list_windows 的假象挡住
    if (!opts.force && !looksMin) return { wins, note: '', restored: false, state }

    const wid = Number(w.window_id)
    let detail = ''
    let ok = false
    try {
      const r = await bridge.callTool('bring_to_front', Number.isFinite(wid) ? { pid, window_id: wid } : { pid }, 15000)
      // `!r.isError` 不能当成功：驱动没报错 ≠ 窗口真恢复了。误报会让 cu_click 把
      // restoredInLadder 置真，之后回 window_minimized 也不再恢复重投，点击静默落空。
      ok = r?.structured?.restored === true || r?.structured?.landed_on_target === true
      detail = r?.structured ? `restored=${r.structured.restored === true} raised=${r.structured.raised === true}` : clipText(r?.text, 80)
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err)
    }
    const after = await listAllWindows().catch(() => wins)
    const w2 = after.find((x) => x.window_id === wid) ?? null
    const state2 = winState(w2)
    // 以复核后的窗口表为准：只有真正在屏且未最小化才算恢复成功。
    // 表暂时查不到该窗口（gone）时保留驱动自报，避免 list_windows 快照延迟误判。
    if (state2 === 'normal/onscreen') ok = true
    else if (state2 !== 'gone') ok = false
    const why = looksMin ? (w.minimized === true ? '最小化' : '离屏') : '被驱动报为最小化'
    const note = ok
      ? `（目标窗口原本${why}（${state}），已 bring_to_front 恢复 → ${state2}${detail ? ` · ${detail}` : ''}。不恢复的话 foreground / 像素点击会落到窗口图标占位符上，静默无效）`
      : `（目标窗口${why}（${state}），bring_to_front 没成功：${detail}。这种状态下 foreground / 像素点击不会生效：先手动恢复窗口，或只用 background 语义动作）`
    return { wins: after, note, restored: ok, state: state2, before: state }
  }

  /** 驱动这次调用是不是在说「窗口最小化了」 */
  const isMinimizedRefusal = (res) => {
    if (!res) return false
    const blob = `${res.structured?.refusal ?? ''} ${res.structured?.code ?? ''} ${res.text ?? ''}`
    return /window_minimized/i.test(blob)
  }

  /**
   * 目标解析：pid+windowId 直接过；只给 title 就内部找一次（省掉模型一整轮 cu_windows）。
   * 找不到时把候选标题摆在错误里，模型改一次参数就能命中。
   */
  const resolveTarget = async ({ pid, windowId, title }) => {
    const p = posInt(pid)
    const w = posInt(windowId)
    if (p && w) return { pid: p, windowId: w, note: '' }
    if (!title) return { pid: p, windowId: w, note: '' }

    const q = String(title).trim().toLowerCase()
    // 连续用同一个 title 点好几次时，没必要每轮都重列全量窗口表（一次 ~50ms + 一次 RPC）
    if (targetCacheMs > 0) {
      const hit = targetCache.get(q)
      if (hit && Date.now() - hit.at < targetCacheMs) {
        return { ...hit.value, note: `${hit.value.note || ''}（窗口解析命中 ${targetCacheMs}ms 缓存）`.trim() }
      }
    }
    // 一次全量表就够：既覆盖最小化/离屏，也能给 cu_click 直接复用，省掉再列一次
    const wins = await listAllWindows().catch(() => [])
    const hits = wins.filter((x) => String(x.title ?? '').toLowerCase().includes(q))
    if (!hits.length) {
      const list = wins
        .slice(0, 10)
        .map((x) => `"${String(x.title ?? '').slice(0, 40)}"(pid ${x.pid}/${x.window_id})`)
        .join('、')
      throw new Error(`没有标题含「${title}」的窗口。当前窗口：${list || '(无)'} —— 换 title，或直接用 pid+windowId`)
    }
    const exact = hits.find((x) => String(x.title ?? '').toLowerCase() === q)
    const onScreen = hits.find((x) => x.minimized !== true && x.is_on_screen !== false)
    const pick = exact ?? onScreen ?? hits[0]
    const offscreenNote =
      pick.minimized === true || pick.is_on_screen === false ? '（该窗口当前最小化/离屏，cu_click 会先 bring_to_front 恢复）' : ''
    const note = [
      hits.length > 1
        ? `（title 命中 ${hits.length} 个，用最匹配的 pid ${pick.pid}/${pick.window_id}；其余：${hits
            .slice(0, 4)
            .map((x) => `${x.pid}/${x.window_id}`)
            .join('、')}）`
        : '',
      offscreenNote,
    ]
      .filter(Boolean)
      .join('')
    const value = { pid: pick.pid, windowId: pick.window_id, note, wins }
    if (targetCacheMs > 0) targetCache.set(q, { at: Date.now(), value })
    return value
  }

  /** 读一次窗口状态（不 settle），返回 {count, sc} */
  const readState = async (pid, windowId, extra = {}) => {
    // 注意：不能用 `x ?? default` —— posInt 把「没给」归零，0 会原样发给驱动
    // （max_elements:0 会让驱动只走 1 个节点，直接把整棵树读成空）
    const res = await bridge.callTool(
      'get_window_state',
      {
        pid,
        window_id: windowId,
        include_screenshot: false,
        max_elements: posInt(extra.maxElements) || cfg.maxElements,
        timeout_ms: posInt(extra.timeoutMs) || 6000,
        ...(extra.query ? { query: extra.query } : {}),
        // 截图和树必须同一次调用出来：单独再读一次会推进 snapshot，
        // 把刚打印出去的 element_token 全部作废（invalidated_snapshot_ids）。
        // 所以读态时直接带上 screenshot_out_file，一次走查同时拿到树 + 图。
        ...(extra.screenshotOut ? { screenshot_out_file: extra.screenshotOut } : {}),
        // 截图要跟「按像素点击」一一对应，就不能让驱动按 1568 上限缩图（默认会缩）。
        ...(extra.nativeScreenshot ? { max_image_dimension: 0 } : {}),
      },
      cfg.stateTimeoutMs,
    )
    if (res.isError) return { count: -1, sc: null, res }
    const sc = res.structured ?? {}
    // 用「实际回来的行数」而不是 element_count：带 query 时 element_count 仍是整棵树的总数，
    // 拿它当判据会把「投影没命中」误判成「树读到了」，settle 也就永远不会重读。
    // returned_element_count 是驱动给的投影行数，最准；缺了再退回 elements.length。
    const count = Number.isFinite(sc.returned_element_count)
      ? sc.returned_element_count
      : Array.isArray(sc.elements)
        ? sc.elements.length
        : Number.isFinite(sc.element_count)
          ? sc.element_count
          : 0
    return { count, sc, res }
  }

  /** 元素上真正可用的动作：invoke 优先，其次 expand（驱动只对 expand 有专门通道） */
  const pickAction = (el, wanted) => {
    if (wanted) return String(wanted)
    const acts = Array.isArray(el?.actions) ? el.actions.map((a) => String(a).toLowerCase()) : []
    if (acts.includes('invoke')) return undefined // 默认就是 invoke，不必显式传
    if (acts.includes('expand')) return 'expand'
    return undefined
  }

  /* --------------------------------------------------------------- 体检 */

  const doctor = textOutput({
    name: 'cu_doctor',
    timeoutMs: 90000,
    description:
      '电脑操控体检：驱动在哪、哪个版本、MCP 握手通不通、原生工具几个、屏幕多大、当前有几个可见窗口。' +
      '凡是「点不中 / 读不到元素 / 不知道能不能控桌面」，先跑这个确认链路是通的。',
    run: async () => {
      const lines = []
      const d = bridge.describe()
      lines.push(`驱动：${d.exe || '(未找到)'}${d.version ? ` · 版本 ${d.version}` : ''}`)
      if (!bridge.exe) {
        lines.push('✗ 没找到电脑操控驱动（minimax-computer-use.exe）。')
        lines.push(`  扫描位置：${d.searched || DRIVER_COMPONENTS_ROOT}`)
        lines.push('  修法：装 MiniMax Code 的「电脑操控」组件；或在本插件设置里把 driverPath 指到 exe。')
        return { text: lines.join('\n'), ok: false }
      }
      let tools = []
      try {
        tools = await bridge.listTools(true)
        lines.push(`MCP 握手：✅ 正常 · 原生工具 ${tools.length} 个`)
      } catch (err) {
        lines.push(`MCP 握手：✗ 失败 —— ${err.message}`)
        if (d.stderrTail) lines.push(`驱动 stderr 尾部：\n${d.stderrTail}`)
        return { text: lines.join('\n'), ok: false }
      }
      try {
        const size = await bridge.callTool('get_screen_size', {}, 8000)
        lines.push(`屏幕：${size.text.split('\n')[0] || '(未给)'}`)
      } catch (err) {
        lines.push(`屏幕：✗ ${err.message}`)
      }
      try {
        const wins = await listWindows()
        lines.push(`可见窗口：${wins.length} 个`)
      } catch (err) {
        lines.push(`可见窗口：✗ ${err.message}`)
      }
      lines.push('')
      lines.push(`配置：delivery=${cfg.defaultDelivery} · maxElements=${cfg.maxElements} · 空闲回收 ${cfg.idleShutdownMs}ms`)
      lines.push(
        `性能档位：observeProfile=${cfg.observeProfile ?? 'balanced'} · 复核取样 ${settleDelays.join('/')}ms · ` +
          `title 缓存 ${targetCacheMs}ms（已缓存 ${targetCache.size} 个标题）`,
      )
      lines.push(`技能：${cfg.skillRegistered ? 'computer-use-pro 已注册' : '未注册（宿主 skills 服务缺席）'}`)
      // 累计调用画像：一次 cu_click 可能要走 3~7 次 RPC + settle 等待，没有这行
      // 就只能靠猜「为什么这一轮慢 / 是不是驱动在超时重启」。
      const live = bridge.describe()
      const s = live.stats ?? {}
      lines.push(
        `调用统计：${s.calls ?? 0} 次 · 失败 ${s.errors ?? 0} · 超时 ${s.timeouts ?? 0} · ` +
          `平均 ${s.avgMs ?? 0}ms / 最慢 ${s.maxMs ?? 0}ms · 子进程 ${live.running ? `常驻（pid ${live.pid}）` : '未启动'}`,
      )
      if (live.candidatesCount > 1) {
        lines.push(`驱动候选：${live.candidatesCount} 个版本，当前第 ${live.exeIndex + 1} 个（启动失败自动回退到次新版本）`)
      }
      if (live.restarts || live.failureStreak || live.cooldownMs) {
        lines.push(
          `自愈 / 熔断：回退重启 ${live.restarts} 次 · 连续失败 ${live.failureStreak}` +
            (live.cooldownMs ? ` · 熔断剩余 ${Math.ceil(live.cooldownMs / 1000)}s` : ''),
        )
      }
      if (live.platformNote) lines.push(`平台：${live.platformNote}`)
      // 只读盘点截图目录：每次点击都会落盘 PNG，长期会堆积，但插件绝不自动删用户文件。
      try {
        const shotDir = expandHome(cfg.screenshotDir || '~/.dsh/computer-use/shots')
        const names = readdirSync(shotDir)
        let bytes = 0
        for (const n of names) {
          try {
            bytes += statSync(path.join(shotDir, n)).size
          } catch {
            /* 子目录/被占用文件跳过 */
          }
        }
        lines.push(`截图目录：${shotDir} · ${names.length} 个文件 / ${(bytes / 1024 / 1024).toFixed(1)} MiB（只读统计，插件不自动删除）`)
      } catch {
        lines.push('截图目录：尚未产生（或不可读）—— 传 cu_state 的 screenshot:true 后会创建')
      }
      const keepFiles = posInt(cfg.screenshotMaxFiles)
      const keepDays = posInt(cfg.screenshotMaxAgeDays)
      lines.push(
        `截图保留策略：${keepFiles || keepDays ? `最多 ${keepFiles || '∞'} 张 / ${keepDays || '∞'} 天（只清理本插件生成的 PNG）` : '关闭（不自动删除任何文件）'}`,
      )
      // 桌面覆盖层：把「为什么光标老是不见」变成一眼可见的诊断
      try {
        const cs = await bridge.callTool('get_agent_cursor_state', { session: AGENT_SESSION }, 8000)
        const s = cs.structured ?? {}
        const healthy = s.enabled === true && Number(s.motion?.idle_hide_ms) === 0
        lines.push(
          `桌面覆盖层：enabled=${s.enabled ?? '?'} · idle_hide_ms=${s.motion?.idle_hide_ms ?? '?'} · ` +
            `position=${s.position ? `${s.position.x},${s.position.y}` : 'null'} · ` +
            (typeof s.enabled === 'boolean'
              ? healthy ? '✅ 已设「永不自动隐藏」' : '⚠ 会闲置后自动隐藏，用 cu_cursor({action:"show"}) 自愈'
              : '驱动没给状态'),
        )
      } catch (err) {
        lines.push(`桌面覆盖层：✗ 读不到状态（${err instanceof Error ? err.message : err}）`)
      }
      const ov = overlay.describe()
      lines.push(
        `键盘浮窗：${!ov.enabled ? '已关闭' : ov.unavailable ? `不可用（${ov.lastError || '原因未知'}）` : `已启用 · ${ov.running ? '进程常驻' : '待首次按键启动'} · 已显示 ${ov.shows} 次`}`,
      )
      lines.push('下一步：cu_windows 找窗口 → cu_state（可直接传 title）读树 → cu_click 点。')
      return { text: lines.join('\n'), ok: true }
    },
  })

  /* ------------------------------------------------------------- 窗口面 */

  const windows = textOutput({
    name: 'cu_windows',
    timeoutMs: 40000,
    description:
      '列出桌面上的顶层窗口（pid / window_id / 进程 / 标题 / 是否在屏 / 尺寸）。' +
      '同名窗口常有多个（UWP 应用本体 + ApplicationFrameHost 宿主）。' +
      '**多数情况不必调它**：cu_state / cu_click / cu_key 都能直接传 title="<标题子串>" 自行解析窗口。',
    parameters: {
      pid: { type: 'integer', description: '只列某个进程的窗口' },
      query: { type: 'string', description: '按标题/进程名子串过滤' },
      onScreenOnly: { type: 'boolean', description: '只列屏幕上的（默认 true）' },
      includeOverlay: { type: 'boolean', description: '包含驱动自己的光标覆盖层窗口（默认 false）' },
      limit: { type: 'integer', description: '最多显示几行（默认 60）' },
    },
    run: async (args) => {
      const payload = { on_screen_only: args.onScreenOnly !== false }
      const pid = posInt(args.pid)
      if (pid) payload.pid = pid
      const res = await bridge.callTool('list_windows', payload, cfg.defaultTimeoutMs)
      if (res.isError) return { text: errText(res) }
      let text = fmtWindows(res.structured, {
        limit: posInt(args.limit) || 60,
        hideOverlay: args.includeOverlay !== true,
      })
      const q = String(args.query ?? '').trim().toLowerCase()
      if (q) {
        // 只过滤数据行：表头 / 空表提示 / 下一步提示一律保留（以前空表时整份输出只剩表头）。
        // 并且用「原始未截断标题」匹配 —— fmtWindows 里 clip(title,52) 会让长标题尾部关键词永远命中不到。
        const rawWins = Array.isArray(res.structured?.windows) ? res.structured.windows : []
        const useRaw = rawWins.length > 0
        const keep = new Set(
          rawWins
            .filter((w) => `${w.title ?? ''} ${w.app_name ?? ''}`.toLowerCase().includes(q))
            .map((w) => `${w.pid}\t${w.window_id}\t`),
        )
        const out = []
        for (const line of text.split('\n')) {
          const parts = line.split('\t')
          const isData = parts.length >= 3 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])
          if (!isData || (useRaw ? keep.has(`${parts[0]}\t${parts[1]}\t`) : line.toLowerCase().includes(q))) out.push(line)
        }
        text = out.join('\n')
      }
      return { text }
    },
  })

  const windowInfo = textOutput({
    name: 'cu_window_info',
    timeoutMs: 40000,
    description:
      'pid → 窗口归属的一手证据：exe 路径、每个顶层窗口的 class_name / hwnd / title、焦点元素。' +
      'UIA 树为空时**先用它**分清「非渲染面（CoreWindow）」和「真外壳（ApplicationFrameWindow）」。',
    parameters: {
      pid: { type: 'integer', description: '目标进程 pid', required: true },
    },
    run: async (args) => {
      const pid = posInt(args.pid)
      if (!pid) throw new Error('缺 pid')
      const res = await bridge.callTool('debug_window_info', { pid }, cfg.defaultTimeoutMs)
      if (res.isError) return { text: errText(res) }
      return { text: fmtWindowInfo(res.structured) }
    },
  })

  /* --------------------------------------------------------------- 观察 */

  const state = textOutput({
    name: 'cu_state',
    timeoutMs: 90000,
    description:
      '读一个窗口的 UI Automation 语义树，每行末是 element_token（cu_click 的凭据）。' +
      '默认视图只列**可点元素 + 输入框 + 它们的祖先链**，装饰节点（滚动条/状态栏/纯文本）折叠计数；' +
      '要全量传 mode:"full"。' +
      '**自带 settle**：首读元素数 < 8 时自动重读并把每次数量写进输出（越过 Electron/UWP 的懒发布）。' +
      '窗口可以用 pid+windowId，也可以直接给 title（自动解析，省一轮 cu_windows）。' +
      '**要看画面**：传 screenshot:true（或 screenshotFile），截图会作为**图片直接返回**（模型能看见），' +
      '同时落盘一份；图上的像素坐标就是 cu_click 的 x,y（原点左上，自然分辨率）。',
    parameters: {
      pid: { type: 'integer', description: '目标进程 pid' },
      windowId: { type: 'integer', description: '窗口 id（来自 cu_windows）' },
      title: { type: 'string', description: '窗口标题子串（替代 pid+windowId；重名时取最匹配的）' },
      query: { type: 'string', description: '按控件可见文本收窄（树很大时先用它，输出会变成全量投影）' },
      maxElements: { type: 'integer', description: '最多走查多少个元素（默认 400）' },
      maxChars: { type: 'integer', description: '输出字符预算（默认 8000）' },
      mode: { type: 'string', description: 'interactive（默认，只留可点+结构）或 full（原样全量）' },
      showBounds: { type: 'boolean', description: '每行附带窗口内坐标与尺寸（要算像素点击时才需要）' },
      timeoutMs: { type: 'integer', description: '驱动走查超时（默认 6000）' },
      screenshotFile: { type: 'string', description: '把窗口截图写到这个路径（相对路径落在截图目录）；给了它就等于开启图片交付' },
      screenshot: {
        type: 'boolean',
        description: '截图作为图片随结果返回（模型可看画面），并写到截图目录。默认 false（不额外产生负载）；传 screenshotFile 也等于开启',
      },
      settle: { type: 'boolean', description: '首读元素太少时自动重读（默认 true）' },
      settleAttempts: { type: 'integer', description: 'settle 最多读几次（默认 3，上限 5）' },
    },
    run: async (args, exec) => {
      const target = await resolveTarget(args)
      if (!target.pid || !target.windowId) {
        throw new Error('缺 pid+windowId（或给 title）。先 cu_windows 看一遍，或用 title="<窗口标题子串>"')
      }
      const { pid, windowId } = target
      const query = args.query ? String(args.query) : ''
      const settle = args.settle !== false && !query // query 是确定性投影，重读无意义
      const defaultRounds = cfg.observeProfile === 'fast' ? 2 : cfg.observeProfile === 'thorough' ? 4 : 3
      const rounds = settle ? Math.min(posInt(args.settleAttempts) || defaultRounds, 5) : 1
      const shotPath = Boolean(args.screenshotFile)
        ? resolveShotPath(args.screenshotFile, cfg)
        : args.screenshot === true
          ? shotFile('state', pid, windowId)
          : ''
      const counts = []
      let best = null
      let last = null
      for (let k = 0; k < rounds; k++) {
        // 截图并入同一次读取：token 与截图天然同源，也省掉一次整树走查
        const r = await readState(pid, windowId, {
          query,
          maxElements: posInt(args.maxElements),
          timeoutMs: posInt(args.timeoutMs),
          screenshotOut: shotPath,
          nativeScreenshot: Boolean(shotPath),
        })
        if (r.count < 0) return { text: errText(r.res) }
        const sc = r.sc ?? {}
        counts.push(r.count)
        last = { count: r.count, sc }
        const prev = best ? (Array.isArray(best.elements) ? best.elements.length : 0) : -1
        if (!best || r.count > prev) best = sc
        if (r.count >= SETTLE_MIN_ELEMENTS) break
        // 0 元素 + 已判降级：重读救不回来（陈旧实例要靠 relaunch），别再烧 8 秒
        if (r.count === 0 && sc.degraded === true) break
        if (k < rounds - 1) await sleep(k === 0 ? 350 : 600)
      }

      let shotStale = false
      if (shotPath) {
        // 截图由最后一次读取写出，所以输出必须是那份快照，否则打出的 token 已被作废
        if (last?.count > 0 || !best) {
          best = last?.sc ?? best
        } else {
          // 最后一次读意外空树：先补读一次；仍空就保留上一份较好的树（别把「0 元素」当结论）
          const retry = await readState(pid, windowId, {
            query,
            maxElements: posInt(args.maxElements),
            timeoutMs: posInt(args.timeoutMs),
            screenshotOut: shotPath,
            nativeScreenshot: Boolean(shotPath),
          })
          if (retry.count > 0) {
            counts.push(retry.count)
            best = retry.sc
          } else {
            shotStale = true
          }
        }
      }

      let text = fmtState(best, {
        maxChars: posInt(args.maxChars) || cfg.maxChars,
        settle: counts,
        mode: args.mode === 'full' ? 'full' : 'interactive',
        showBounds: args.showBounds === true,
        query: query || undefined,
      })
      if (target.note) text = `${text}\n${target.note}`
      const wb = best?.window_bounds
      if (wb && (Number(wb.x) <= -30000 || Number(wb.y) <= -30000)) {
        // 最小化窗口在 UIA 里照常可读，但输入类动作会落到图标占位符上 —— 这是「点不到」的头号现场
        text += `\n\n⚠ 该窗口当前**最小化/离屏**（bounds ${Number(wb.x)},${Number(wb.y)} 是图标占位符）：UIA 树能读，但 foreground / 像素点击不会生效。\n   cu_click 会先自动 bring_to_front 恢复；手动恢复用 cu_call({ tool: "bring_to_front", args: { pid: ${pid}, window_id: ${windowId} } })。`
      }
      const bestCount = Array.isArray(best?.elements) ? best.elements.length : 0
      if (bestCount === 0 && best?.truncated !== true && !query) {
        text += '\n\n下一步：cu_recover（pid+windowId，relaunch:true 可自动按 AUMID 重拉）——重读 / 换兄弟窗口 / 重拉三步它一次走完。'
      }
      let images = []
      if (shotPath) {
        const shot = await deliverShot(exec, shotPath)
        images = shot.images
        text += `\n\n${shot.text}`
        const meta = shotMeta(best, shotPath)
        const wb = meta.wb
        if (wb && meta.width) {
          text +=
            `\n坐标：原点在截图左上角，单位=截图像素。` +
            `窗口 bounds ${Number(wb.width)}x${Number(wb.height)} @${Number(wb.x)},${Number(wb.y)}（屏幕点），` +
            `PNG 是自然分辨率（不含 1px 窗口边框，所以比 bounds 少 2px；DPI 缩放 ${meta.scale.toFixed(3)}x）。` +
            `\n→ 看图给 cu_click 传 x,y（例如点某按钮就传它在图上的像素中心），驱动按同一截图空间落点，实测 1:1。`
        }
        if (best?.capture_id) {
          text += `\n\n截图 capture_id=${best.capture_id}：隔了一会才按这张图点，就把该值作为 cu_click 的 captureId 传进来，保证坐标与画面同源。`
        }
        if (shotStale && bestCount > 0) {
          text += `\n\n⚠ 截图那次读没有拿到元素（0 或报错），已保留上一次读到的 ${bestCount} 个元素；但这次读取已推进快照，上面的 element_token 可能作废 —— 点击前先重读一次 cu_state。`
        }
      }
      return { text, images }
    },
  })

  /* --------------------------------------------------------------- 动作 */

  const click = textOutput({
    name: 'cu_click',
    timeoutMs: 120000,
    description:
      '语义点击：按**可见标签**找元素 → 取 element_token → 走 UIA 动作 → 自动复核。' +
      '同名元素不止一个时用 index 选第几个（0 起，输出会列出全部候选）。' +
      '目标窗口最小化/离屏时先自动 bring_to_front 恢复（最小化窗口的 foreground/像素点击会静默落空）。' +
      '动作用元素的 actions 自动选；没效果时爬三级阶梯（background → foreground → expand），每级都用最新快照重取 token。' +
      '复核看**三样**：元素数、目标控件自身状态（标签/值/选中）、窗口状态（在屏/最小化 + 新窗口）——' +
      '所以「点喜欢后数字+1、标签变已喜欢」这种元素数不变的成功也能判对，不会重投把 toggle 点回去。' +
      '点击生效时附一份迷你新快照（可直接接着点，不用再发 cu_state）；标签匹配不上会列候选，照着改 label，不要猜坐标。' +
      '**像素点击**：也可以直接给 x,y（= cu_state 截图上的像素坐标，原点左上），按截图画面对点。' +
      '两者都给时优先 x,y。点击后会返回一张**带红圈标记的新截图**（screenshot:false 可关），让画面自己说话。',
    parameters: {
      pid: { type: 'integer', description: '目标进程 pid' },
      windowId: { type: 'integer', description: '窗口 id' },
      title: { type: 'string', description: '窗口标题子串（替代 pid+windowId）' },
      label: { type: 'string', description: '元素的可见标签（先精确匹配，再子串匹配）。与 x,y 二选一：给 x,y 就是像素点击' },
      x: { type: 'number', description: '像素点击 X：截图像素坐标（与 cu_state 的截图同一坐标系，原点左上）。与 y 一起给出' },
      y: { type: 'number', description: '像素点击 Y：同上' },
      captureId: { type: 'string', description: '像素点击时绑定 cu_state 截图给出的 capture_id；留空则自动用本次读树同批截图的 id' },
      role: { type: 'string', description: '限定控件角色，如 ListItem / Button / MenuItem' },
      index: { type: 'integer', description: '同名命中多个时取第几个（0 起）。默认取第一个可点的；输出会列出全部候选及其序号' },
      action: { type: 'string', description: 'UIA 动作，留空自动选（invoke / expand）' },
      deliveryMode: { type: 'string', description: 'background（默认，不抢前台）或 foreground' },
      dryRun: { type: 'boolean', description: '只匹配不点击' },
      reobserve: { type: 'boolean', description: '点击后复核（默认 true）' },
      screenshot: { type: 'boolean', description: '点击后返回带标记的新截图（默认 true；false 关闭以减少负载）' },
      maxElements: { type: 'integer', description: '观察时最多走查多少元素（默认 400）' },
    },
    run: async (args, exec) => {
      const target = await resolveTarget(args)
      const { pid, windowId } = target
      const label = String(args.label ?? '').trim()
      const point = args.x !== undefined && args.y !== undefined ? { x: Number(args.x), y: Number(args.y) } : null
      const pixel = point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null
      if (!pid || !windowId || (!label && !pixel)) {
        throw new Error('缺 pid+windowId（或 title）；再给 label（语义点击）或 x,y（按截图坐标点）')
      }
      const maxElements = posInt(args.maxElements) || cfg.maxElements
      const notes = []
      if (target.note) notes.push(target.note)

      // ① 窗口最小化/离屏就先恢复：这一步不做，后面所有 foreground/像素点击都是静默空点
      //    dryRun 不恢复（只看不点，不该抢前台），但仍然把窗口状态说出来
      let vis
      if (args.dryRun === true) {
        const wins = target.wins ?? (await listAllWindows().catch(() => []))
        const w = wins.find((x) => x.window_id === windowId) ?? wins.find((x) => x.pid === pid) ?? null
        const min = w && (w.minimized === true || w.is_on_screen === false)
        vis = {
          wins,
          note: min ? `（目标窗口当前${w.minimized === true ? '最小化' : '离屏'}（${winState(w)}）：dryRun 不恢复窗口；真点之前 cu_click 会自动 bring_to_front）` : '',
          restored: false,
          state: winState(w),
        }
      } else {
        vis = await ensureWindowVisible(pid, windowId, { wins: target.wins })
      }
      if (vis.note) notes.push(vis.note)

      /* ---------------- 像素点击：按 cu_state 截图上的坐标落点 ---------------- */
      if (pixel) {
        const { x, y } = pixel
        const delivery = String(args.deliveryMode ?? cfg.defaultDelivery)
        const shotBefore = shotFile('click-before', pid, windowId)
        const before = await readState(pid, windowId, { maxElements, screenshotOut: shotBefore, nativeScreenshot: true })
        if (before.count < 0) return { text: errText(before.res) }
        const sc0 = before.sc ?? {}
        const meta0 = shotMeta(sc0, shotBefore)
        const at = elementAtShot(sc0, x, y, meta0)
        const screen = shotToScreen(meta0, x, y)
        const where = at ? `${at.role} "${String(at.label ?? '').slice(0, 40)}"` : '该点没有可识别元素（空白处或自绘内容）'

        if (args.dryRun === true) {
          return {
            text: [
              `（dryRun：只解析未点击）截图坐标 (${x},${y}) → ${where}`,
              meta0.wb
                ? `换算：截图 ${meta0.width}x${meta0.height} px · 窗口 bounds ${Number(meta0.wb.width)}x${Number(meta0.wb.height)} @${Number(meta0.wb.x)},${Number(meta0.wb.y)} · scale=${meta0.scale.toFixed(3)}` +
                  (screen ? ` · 屏幕点 (${Math.round(screen.x)},${Math.round(screen.y)})` : '')
                : '拿不到 window_bounds，无法给屏幕坐标（仍可直接点）',
              ...notes,
            ].join('\n'),
          }
        }

        // 覆盖层坐标用窗口局部截图像素（与驱动动作同源），不是屏幕绝对点
        notes.push(...(await placeCursor(pid, windowId, x, y)))

        const clickArgs = {
          pid,
          window_id: windowId,
          x,
          y,
          ...(args.captureId ? { capture_id: String(args.captureId) } : sc0.capture_id ? { capture_id: sc0.capture_id } : {}),
          delivery_mode: delivery,
        }
        let res = await bridge.callTool('click', clickArgs, cfg.stateTimeoutMs)
        // 像素点击同样会被最小化/离屏窗口静默拒收：恢复窗口后用同一组参数重投一次。
        // 恢复后的这次重投改用 foreground 真鼠标事件 —— 窗口刚从最小化拉回来，
        // background 的合成事件落在刚恢复的窗口上最容易静默空点；
        // 同时记下「foreground 已经用过」，避免后面的升级阶梯再点一次。
        let fgTried = false
        if (isMinimizedRefusal(res)) {
          const fix = await ensureWindowVisible(pid, windowId, { force: true })
          if (fix.note) notes.push(fix.note)
          if (fix.restored) {
            const retryArgs = delivery === 'background' ? { ...clickArgs, delivery_mode: 'foreground' } : clickArgs
            fgTried = retryArgs.delivery_mode === 'foreground'
            res = await bridge.callTool('click', retryArgs, cfg.stateTimeoutMs)
          } else {
            notes.push('（驱动回了 window_minimized，恢复窗口失败：这次像素点击很可能没生效）')
          }
        }

        const focusOnly = unverifiableTarget(at)
        const beforeTarget = at ? targetRow(sc0, at) : null
        const beforeSig = { count: before.count, digest: focusOnly ? '' : treeDigest(sc0), win: String(vis.state ?? '') }
        const known = new Set((vis.wins ?? []).map((w) => `${w.pid}:${w.window_id}`))
        const afterFile = shotFile('click', pid, windowId)
        const wantShot = args.screenshot !== false && args.reobserve !== false
        let obs = null
        let changed = false
        let targetDiff = ''
        let newWin = null
        /** 读一次界面并判断这次点击到底有没有生效（像素路径要跑两次，见下面的升级阶梯） */
        const reobserve = async () => {
          for (const wait of focusOnly ? [0] : settleDelays) {
            if (wait) await sleep(wait)
            // 截图并进这次复核读取：文件最终落的是「最后一次读」的画面，不多花一次 RPC
            obs = await readState(pid, windowId, {
              maxElements,
              ...(wantShot ? { screenshotOut: afterFile, nativeScreenshot: true } : {}),
            })
            if (obs.count < 0) continue
            // 弹出菜单/模态框常长在**另一个窗口**里；每次采样都重列窗口表，
            // settle 期间才出现的窗口不会漏，窗口状态也不再只取第一次的旧值。
            // 文本输入类只取一次样、判不出成败，没必要为它再列一次窗口表
            const winsAfter = focusOnly ? (vis.wins ?? []) : await listAllWindows().catch(() => [])
            const fresh = winsAfter.filter((w) => !known.has(`${w.pid}:${w.window_id}`))
            // 只认同 pid 的新窗口：无关应用弹窗/通知不能算「这次点中了」
            const own = fresh.find((w) => Number(w.pid) === Number(pid)) ?? null
            // 重读会推进 snapshot，旧 element_token 已失效：按 index+role+rect 找回同一控件
            const row = at ? pickAfterRow(obs.sc, at, beforeTarget) : null
            targetDiff = diffRow(beforeTarget ?? at, row)
            changed =
              Boolean(targetDiff) ||
              obs.count !== beforeSig.count ||
              (!focusOnly && treeDigest(obs.sc) !== beforeSig.digest) ||
              Boolean(own)
            if (own) newWin = own
            if (changed) break
          }
        }
        if (args.reobserve !== false) await reobserve()

        /*
         * 升级阶梯 ②（对齐语义点击的同一级）：background 合成事件点不动**原生 Win32 菜单项**。
         *
         * 实测（Chrome 原生「Chrome」菜单 → 「打开新的标签页」）：
         *   · background（route=synthetic_events）：菜单仍开着、命令没执行 ——
         *     元素数 101 → 101，既没开新标签也没关菜单，驱动只回「很可能没生效」。
         *   · foreground（route=global_input，真 SendInput 鼠标事件）：命令真的执行，新标签页开了。
         *
         * 原因：合成事件是把消息 POST 给窗口，原生菜单收到这种消息走「取消」分支，
         * 不是「点中」分支。真鼠标事件才带按下-抬起序列，菜单才会执行命令。
         *
         * 只有「background + 没生效 + 目标不是文本输入类」才升级：
         *   · 文本输入类点一下只是获得焦点，判不出成败，升级是空转（与语义路径一致）；
         *   · 已经生效就绝不重投 —— toggle 控件被点第二下会变回去。
         */
        if (args.reobserve !== false && !changed && delivery === 'background' && !focusOnly && !fgTried) {
          const fgArgs = { ...clickArgs, delivery_mode: 'foreground' }
          res = await bridge.callTool('click', fgArgs, cfg.stateTimeoutMs)
          if (isMinimizedRefusal(res)) {
            const fix = await ensureWindowVisible(pid, windowId, { force: true })
            if (fix.restored) {
              res = await bridge.callTool('click', fgArgs, cfg.stateTimeoutMs)
              await reobserve()
            }
          } else {
            await reobserve()
          }
          notes.push('（background 合成事件没让界面变化：已改用 foreground 真鼠标事件重点一次）')
        }

        const lines = [
          `像素点击：截图坐标 (${x},${y}) → ${where}`,
          meta0.wb
            ? `换算：截图 ${meta0.width}x${meta0.height} px · bounds ${Number(meta0.wb.width)}x${Number(meta0.wb.height)} @${Number(meta0.wb.x)},${Number(meta0.wb.y)} · scale=${meta0.scale.toFixed(3)}` +
              (screen ? ` · 屏幕点 (${Math.round(screen.x)},${Math.round(screen.y)})` : '')
            : '',
          fmtClick({
            matched: {
              hits: 1,
              role: at?.role ?? 'Point',
              label: at?.label ?? `(${x},${y})`,
              token: at?.element_token ?? '',
              enabled: at?.enabled,
              actions: at?.actions,
            },
            click: res,
            after: {
              // fmtClick 里 before/now 是「元素数」，保持与语义点击同一口径
              before: before.count,
              now: obs && obs.count >= 0 ? obs.count : undefined,
              changed,
              focusOnly,
              targetDiff,
              newWindow: newWin ? { pid: newWin.pid, windowId: newWin.window_id, title: newWin.title, app: newWin.app_name } : null,
              snapshot: changed && obs?.sc ? fmtStateRows(obs.sc, { maxChars: BRIEF_MAX_CHARS }) : null,
            },
          }),
          ...notes,
        ].filter(Boolean)

        let images = []
        if (wantShot) {
          const shot = await deliverShot(exec, afterFile, { marks: [{ x, y }] })
          images = shot.images
          lines.push(shot.text)
          lines.push('（红圈=本次点击位置。窗口截图拍不到 agent cursor 覆盖层——它是独立顶层窗口；覆盖层只给真机用户看，图上的标记是插件按同一像素坐标画的）')
        }
        return { text: lines.join('\n'), images }
      }

      const snap = await readState(pid, windowId, { maxElements })
      if (snap.count < 0) return { text: errText(snap.res) }
      const sc = snap.sc ?? {}
      const els = Array.isArray(sc.elements) ? sc.elements : []
      if (!els.length) {
        return {
          text: [
            `✗ window ${windowId} 的语义树是空的（elements=0，degraded=${sc.degraded === true}）`,
            sc.degraded_reason ? `原因：${sc.degraded_reason}` : '',
            '不要转而猜坐标：cu_recover({ pid, windowId, relaunch: true }) 一次走完诊断阶梯。',
            ...notes,
          ]
            .filter(Boolean)
            .join('\n'),
        }
      }

      const norm = (s) => String(s ?? '').trim().toLowerCase()
      const wanted = norm(label)
      let hits = els.filter((e) => norm(e.label) === wanted)
      if (!hits.length) hits = els.filter((e) => norm(e.label).includes(wanted))
      if (args.role) {
        const r = norm(args.role)
        const byRole = hits.filter((e) => norm(e.role) === r)
        if (byRole.length) hits = byRole
      }

      if (!hits.length) {
        const cands = els
          .filter((e) => e.label)
          .slice(0, 40)
          .map((e) => `${e.role}:"${String(e.label).slice(0, 30)}"`)
          .join(' | ')
        return {
          text: [
            `✗ 没有标签为 "${label}" 的元素${args.role ? `（role=${args.role}）` : ''}。`,
            `树里共 ${els.length} 个元素，候选：${cands || '(全都没有 label)'}`,
            sc.truncated === true
              ? `⚠ 这棵树被截断了（${sc.truncation_reason ?? '预算/深度'}），目标可能没走到：调大 maxElements，或先用 cu_state 的 query 投影确认它在不在。`
              : '照着候选改 label（或用 cu_state 的 query 先看一眼），不要切到像素坐标。',
          ].join('\n'),
        }
      }

      // 同一个标签常常命中一片（时间线里每条推文都有「转帖」）：按 index 选，并列出候选
      const actionable = (e) =>
        (e.actions ?? []).some((a) => ['invoke', 'expand', 'toggle', 'select', 'set_value', 'press', 'click'].includes(String(a).toLowerCase()))
      const idxArg = intArg(args.index)
      let pick = null
      if (idxArg !== null) {
        if (idxArg < 0 || idxArg >= hits.length) {
          return { text: `✗ index=${idxArg} 越界：只命中 ${hits.length} 个（index 从 0 起）。\n${hitLines(hits)}` }
        }
        pick = hits[idxArg]
      } else {
        pick = hits.find(actionable) ?? hits[0]
      }
      const matched = {
        hits: hits.length,
        role: pick.role,
        label: pick.label,
        token: pick.element_token,
        enabled: pick.enabled,
        actions: pick.actions,
      }
      const beforeCount = Number.isFinite(sc.returned_element_count)
        ? sc.returned_element_count
        : els.length

      if (args.dryRun === true) {
        return {
          text: [fmtClick({ matched, dryRun: true }), hits.length > 1 ? hitLines(hits, hits.indexOf(pick)) : '', ...notes]
            .filter(Boolean)
            .join('\n'),
        }
      }
      if (!pick.element_token) {
        return { text: [`✗ 命中元素没有 element_token（driver 未给），无法语义点击。\n${fmtClick({ matched, dryRun: true })}`, ...notes].filter(Boolean).join('\n') }
      }

      const delivery0 = String(args.deliveryMode ?? cfg.defaultDelivery)
      const actions0 = (pick.actions ?? []).map((a) => String(a).toLowerCase())
      const primary = pickAction(pick, args.action)
      const beforeTarget = targetRow(sc, pick)
      // 文本输入类元素点一下只是聚焦：界面对比判不出成败，也就不该按「没变 → 升级重投」的阶梯空转
      const focusOnly = unverifiableTarget(beforeTarget)
      const beforeSig = {
        // 判不出成败时指纹毫无用处，别为它整树走一遍（每棵树最多 maxElements 个元素）
        digest: focusOnly ? '' : treeDigest(sc),
        win: winState((vis.wins ?? []).find((w) => w.window_id === windowId)),
        target: beforeTarget,
        // 截断的树每次走查可能切在不同节点上，指纹本身就会抖 —— 这时不能拿它当「变了」的证据
        truncated: sc.truncated === true,
      }

      /** 读一次界面（含全量窗口表）—— 判定「这次到底有没有生效」的原始材料 */
      const observe = async (shot = '', needWindows = true) => {
        // 把截图并进复核读取：文件会被后一次覆盖，最后一次读的画面就是要交付的那张，
        // 不额外多一轮 RPC（像素点击路径同此口径）。
        const r = await readState(pid, windowId, { maxElements, ...(shot ? { screenshotOut: shot, nativeScreenshot: true } : {}) })
        // focusOnly（文本输入类）判不出成败，窗口表对它毫无信息量 —— 直接复用点击前那份
        const wins = needWindows ? await listAllWindows().catch(() => []) : (vis.wins ?? [])
        const known = new Set((vis.wins ?? []).map((w) => `${w.pid}:${w.window_id}`))
        const freshAll = wins.filter((w) => !known.has(`${w.pid}:${w.window_id}`))
        // 同 pid 的弹出窗口优先，别让无关应用的新窗口把「自己弹的菜单」挤掉
        const fresh = freshAll.find((w) => Number(w.pid) === Number(pid)) ?? freshAll[0] ?? null
        const self = wins.find((w) => w.window_id === windowId) ?? null
        return { count: r.count, sc: r.sc ?? {}, newWin: fresh, win: winState(self) }
      }

      /** 三样一起看：元素数 / 整树指纹 / 目标控件自身 / 窗口状态。任一变化即算生效 */
      const judge = (obs) => {
        const afterRow = pickAfterRow(obs.sc, pick, beforeSig.target)
        const targetDiff = diffRow(beforeSig.target, afterRow)
        const countChanged = obs.count !== beforeCount
        const digestChanged = !focusOnly && !beforeSig.truncated && obs.sc?.truncated !== true && treeDigest(obs.sc) !== beforeSig.digest
        const winChanged = obs.win !== beforeSig.win
        // 「窗口表有变化」只是提示，不能单独算生效证据：复核期间别的应用弹个通知、
        // 或目标窗口被外部最小化，都会被误判成点中并提前停掉三级阶梯。
        // 只认「同 pid 的新窗口」和「目标窗口真的恢复在屏」。
        const ownNewWin = obs.newWin && Number(obs.newWin.pid) === Number(pid) ? obs.newWin : null
        const winRecovered =
          winChanged && String(obs.win ?? '').startsWith('normal/onscreen') && !String(beforeSig.win ?? '').startsWith('normal/onscreen')
        return {
          changed: countChanged || digestChanged || Boolean(ownNewWin) || winRecovered || Boolean(targetDiff),
          newWin: ownNewWin,
          targetDiff,
          countChanged,
          digestChanged,
          winChanged,
          afterRow,
        }
      }

      /**
       * 点击后观察 + settle。
       * UI 反应不是瞬时的（Electron / XAML / 客户端渲染尤其），一次读不到就下结论 →
       * 按阶梯重投 → toggle 类控件被点回去 → 用户看到「点了没反应」。
       * 实测 X：点「喜欢」后元素数一动不动，只有那一个按钮的标签变了，且要 ~100ms 才刷新。
       */
      const observeSettled = async (settle = true, shot = '') => {
        let obs = null
        let verdict = null
        // 判不出成败的元素只取一次样：多等 220/380ms 也等不出可对比的状态
        for (const delay of settle ? settleDelays : [0]) {
          if (delay) await sleep(delay)
          obs = await observe(shot, !focusOnly)
          verdict = judge(obs)
          if (verdict.changed) break
        }
        return { obs, verdict }
      }

      /** 重读过的快照里旧 token 失效，必须按 label 重新取一次 */
      const tokenFor = (scLike, wantAction) => {
        const list = Array.isArray(scLike?.elements) ? scLike.elements : []
        const cands = list.filter((e) => norm(e.label) === wanted || norm(e.label).includes(wanted))
        const hit = wantAction ? cands.find((e) => (e.actions ?? []).map((a) => String(a).toLowerCase()).includes(wantAction)) : cands[0]
        return hit?.element_token || ''
      }

      /*
       * 升级阶梯（每级都用最新快照的 token，逐级变强）：
       *   ① 用户/默认投递 + 自动动作
       *   ② background 没改动界面 → 同一动作换 foreground 重投
       *   ③ 仍是 invoke 且元素支持 expand → 换 action:"expand"（Win11 菜单项 invoke 是静默空点）
       * 实测：ExpandCollapse 还会回 0x80040200 这种**误报错误码**，所以判定只看复核结果，不信错误码。
       * 例外：没有可比对状态的元素（文本输入类）判不出「没变」，升级/重投都是空转，只用第 ① 级。
       */
      // 覆盖层先挪到目标控件中心：真机用户能看到「它要点哪」（它进不了窗口截图，见 shot.js）
      const pickFrame = frameOf(pick)
      if (pickFrame) {
        // UIA frame 是屏幕绝对坐标；move_cursor 要的是窗口局部截图像素
        const local = screenToShot({ wb: sc.window_bounds, scale: 1 }, pickFrame.x + pickFrame.w / 2, pickFrame.y + pickFrame.h / 2)
        notes.push(...(await placeCursor(pid, windowId, local?.x, local?.y)))
      } else {
        notes.push(...(await ensureCursorVisible()))
      }

      const ladder = [{ action: primary, delivery: delivery0, why: '' }]
      if (!focusOnly && delivery0 === 'background') {
        ladder.push({ action: primary, delivery: 'foreground', why: 'background 没改动界面，已换 foreground 重投' })
      }
      if (!focusOnly && primary !== 'expand' && actions0.includes('expand')) {
        ladder.push({
          action: 'expand',
          delivery: delivery0 === 'background' ? 'foreground' : delivery0,
          why: 'invoke 是静默空点，已改用 action:"expand" 并生效',
        })
      }

      // 确认截图：并进复核读取（同一文件被后一次覆盖，最后落的就是最终画面）
      const shotPath = args.screenshot !== false && args.reobserve !== false ? shotFile('click', pid, windowId) : ''

      const levelName = (step) => `${step.delivery}${step.action ? ` ${step.action}` : ' invoke'}`
      let res = null
      let obs = null
      let verdict = null
      let winWhy = ''
      let restoredInLadder = vis.restored
      const tried = []
      for (let i = 0; i < ladder.length; i++) {
        const step = ladder[i]
        const token = i === 0 ? pick.element_token : tokenFor(obs?.sc, step.action === 'expand' ? 'expand' : undefined)
        if (!token) break // 界面已经变了/元素没了，没必要继续
        const callArgs = { pid, element_token: token, delivery_mode: step.delivery }
        if (step.action) callArgs.action = step.action
        res = await bridge.callTool('click', callArgs, cfg.stateTimeoutMs)
        tried.push(levelName(step))
        if (args.reobserve === false) break

        // 驱动明确说「窗口最小化了」：恢复后同一级重投一次（这种状态下 foreground 必空点）
        if (!restoredInLadder && isMinimizedRefusal(res)) {
          const fix = await ensureWindowVisible(pid, windowId, { force: true })
          restoredInLadder = true
          notes.push(
            `（驱动回了 window_minimized —— 这种状态下 foreground / 像素点击必空点。${
              fix.restored ? '已 bring_to_front 恢复窗口，并用最新快照的 token 同参数重投' : '恢复窗口失败，停止重投'
            }）`,
          )
          const again = await readState(pid, windowId, { maxElements })
          if (again.count < 0) break
          obs = { count: again.count, sc: again.sc ?? {}, newWin: null, win: winState((fix.wins ?? []).find((w) => w.window_id === windowId)) }
          if (!fix.restored) break // 窗口恢复不了，重投同一级也只是再空点一次
          const tok2 = tokenFor(obs.sc, step.action === 'expand' ? 'expand' : undefined) || token
          res = await bridge.callTool('click', { ...callArgs, element_token: tok2 }, cfg.stateTimeoutMs)
          tried.push(`${levelName(step)}(恢复窗口后重投)`)
        }

        const r = await observeSettled(!focusOnly, shotPath)
        obs = r.obs
        verdict = r.verdict
        if (verdict.changed) {
          if (i > 0) winWhy = step.why
          break
        }
        if (i < ladder.length - 1) await sleep(120)
      }

      const changed = verdict?.changed === true
      let after = null
      if (primary === 'expand') notes.push('（该元素只支持展开，已按 action:"expand" 调用）')
      if (winWhy) notes.push(`（${winWhy}）`)
      if (args.reobserve !== false) {
        after = {
          before: beforeCount,
          now: obs?.count,
          changed,
          focusOnly,
          targetDiff: verdict?.targetDiff ?? '',
          windowChange: verdict?.winChanged ? `${beforeSig.win} → ${obs?.win}` : '',
          newWindow: verdict?.newWin ? { pid: verdict.newWin.pid, windowId: verdict.newWin.window_id, title: verdict.newWin.title, app: verdict.newWin.app_name } : null,
          note: obs?.sc?.degraded === true ? `⚠ 复核时树降级（${obs.sc.degraded_reason ?? ''}）` : '',
          snapshot: changed ? fmtStateRows(obs?.sc, { maxChars: BRIEF_MAX_CHARS }) : null,
        }
        if (!changed && !after.newWindow) {
          const lastIsMin = String(obs?.win ?? '').startsWith('min')
          if (focusOnly) {
            notes.push(
              `（已试过：${tried.join(' → ')}。已发送点击；该元素没有可比对的状态（文本输入类只反映焦点）——` +
                '不能据此判定失败，直接 cu_key 输入后用 cu_state 读回确认）',
            )
          } else {
            notes.push(
              `（已试过：${tried.join(' → ')}。元素数 / 控件状态 / 窗口状态都没变 —— ` +
                (lastIsMin
                  ? '窗口仍处于最小化/离屏：先恢复窗口再来点，或确认目标控件是不是在别的窗口里）'
                  : '换 cu_key 走键盘（Alt+首字母 / 方向键+Enter），别在同一个点上再点）'),
            )
          }
        }
      }

      const tail = []
      let images = []
      // 点击后的新截图：模型据此确认「画面真的变了」。图来自上面最后一次复核读取，
      // token / 快照 / 图片同源，不额外多一轮 RPC。
      if (shotPath) {
        let scForShot = obs?.sc ?? null
        if (!scForShot) {
          const fresh = await readState(pid, windowId, { maxElements, screenshotOut: shotPath, nativeScreenshot: true })
          if (fresh.count < 0) tail.push(`⚠ 点击后没能取到用于确认的截图：${errText(fresh.res)}`)
          else scForShot = fresh.sc ?? {}
        }
        if (scForShot) {
          const meta = shotMeta(scForShot, shotPath)
          const mark = pickFrame ? screenToShot(meta, pickFrame.x + pickFrame.w / 2, pickFrame.y + pickFrame.h / 2) : null
          const shot = await deliverShot(exec, shotPath, { marks: mark ? [mark] : [] })
          images = shot.images
          tail.push(shot.text, '（红圈=本次点击的目标控件；窗口截图拍不到 agent cursor 覆盖层——它是独立顶层窗口，标记由插件按同一像素坐标画上）')
        }
      }
      const text = fmtClick({ matched, click: res, after })
      if (hits.length > 1) tail.unshift(hitLines(hits, hits.indexOf(pick)))
      return { text: [text, ...tail, ...notes].filter(Boolean).join('\n'), images }
    },
  })

  /** 命中候选清单（同名多个时必须给序号，否则模型只能猜） */
  const hitLines = (hits, pickedIndex) =>
    [
      `同名命中 ${hits.length} 个（index 从 0 起；要别的传 index:<序号>）：`,
      ...hits.slice(0, 6).map((e) => {
        const idx = hits.indexOf(e)
        const mark = idx === pickedIndex ? ' ← 本次用这个' : ''
        const f = e.frame ? ` @${e.frame.x ?? e.frame.left ?? 0},${e.frame.y ?? e.frame.top ?? 0}` : ''
        return `  [${idx}] ${e.role} "${clipText(e.label, 28)}"${f} token=${e.element_token}${mark}`
      }),
      hits.length > 6 ? `  …还有 ${hits.length - 6} 个（用 role 收窄）` : '',
    ]
      .filter(Boolean)
      .join('\n')

  /** 元素矩形（frame 的字段名两种都见过） */
  function frameOf(e) {
    const f = e?.frame
    if (!f) return null
    const x = Number(f.x ?? f.left)
    const y = Number(f.y ?? f.top)
    const w = Number(f.w ?? f.width)
    const h = Number(f.h ?? f.height)
    if (![x, y, w, h].every(Number.isFinite)) return null
    return { x, y, w, h }
  }

  const near = (a, b, tol = 2) => Math.abs(a - b) <= tol

  /**
   * 在「点击后」的树里找回**同一个控件**。
   *
   * 不能直接拿 element_index 认人：菜单展开会在前面插一堆节点，index=6 从「文件(F)」
   * 变成「打印(P)」，diff 出来就是一条假变化。顺序是：
   *   ① 同 index + 同角色 + 同矩形 → 就是它
   *   ② 标签精确命中 → 就是它（菜单展开后原元素往后挪了）
   *   ③ 同 index + 同角色 + 同尺寸但标签变了 → 认作同一个（X 的「喜欢」→「喜欢了」）
   */
  function pickAfterRow(scLike, ref, beforeRow) {
    const list = Array.isArray(scLike?.elements) ? scLike.elements : []
    const sameRole = (e) => String(e?.role ?? '').trim().toLowerCase() === String(ref?.role ?? '').trim().toLowerCase()
    const byIdx = Number.isFinite(ref?.element_index) ? list[ref.element_index] : null
    const bf = frameOf(beforeRow)
    const af = frameOf(byIdx)
    if (byIdx && sameRole(byIdx) && bf && af && near(bf.x, af.x) && near(bf.y, af.y) && near(bf.w, af.w) && near(bf.h, af.h)) return byIdx
    const wantLabel = String(ref?.label ?? '').trim().toLowerCase()
    const byLabel = list.find((e) => String(e.label ?? '').trim().toLowerCase() === wantLabel)
    if (byLabel) return byLabel
    if (byIdx && sameRole(byIdx) && bf && af && near(bf.w, af.w) && near(bf.h, af.h)) return byIdx
    return null
  }

  function targetRow(scLike, ref) {
    const list = Array.isArray(scLike?.elements) ? scLike.elements : []
    return (
      list.find((e) => e.element_token && e.element_token === ref.element_token) ??
      list.find((e) => String(e.label ?? '').trim().toLowerCase() === String(ref.label ?? '').trim().toLowerCase()) ??
      null
    )
  }

  /**
   * 这个目标「点一下能不能靠界面对比判定」。
   *
   * 文本输入类（Edit / Document 等）点一下只是获得焦点：label / value / selected 都不会动，
   * 复核必然是「没变化」。把它当成「点了没生效」是误判 —— 实测点记事本的「文本编辑器」
   * 就是这个情况，随后 cu_key 输入正常，但模型已经被告知「别在原路径重试」而放弃点击。
   */
  function unverifiableTarget(row) {
    if (!row) return false
    const acts = (row.actions ?? []).map((a) => String(a).toLowerCase())
    // 自报可勾选/可展开/可调用的控件，点一下一定有可对比的状态
    if (acts.some((a) => TOGGLE_ACTIONS.has(a))) return false
    if (row.checked !== undefined || row.selected !== undefined) return false
    const role = String(row.role ?? '').trim().toLowerCase()
    return FOCUS_ONLY_ROLES.has(role) || acts.includes('set_value')
  }

  /** 目标控件自身状态差异（标签/值/选中）—— 元素数不变时这是最硬的证据 */
  function diffRow(before, after) {
    if (!before || !after) return ''
    const bits = []
    if (String(before.label ?? '') !== String(after.label ?? '')) bits.push(`标签 "${clipText(before.label, 26)}" → "${clipText(after.label, 26)}"`)
    if (String(before.value ?? '') !== String(after.value ?? '')) bits.push(`值 "${clipText(before.value, 18)}" → "${clipText(after.value, 18)}"`)
    if ((before.selected === true) !== (after.selected === true)) bits.push(`选中 ${before.selected === true} → ${after.selected === true}`)
    return bits.join(' · ')
  }

  const verify = textOutput({
    name: 'cu_verify',
    timeoutMs: 90000,
    description:
      '对某个窗口求值结构化谓词，确认状态变了没有。结果只有 satisfied / unsatisfied / unknown 三态，**unknown 不等于成功**。' +
      '实测（驱动 0.34.1）：window 级谓词（window.exists / window.bounds）可用；' +
      'element 级谓词一律回 unknown(untrusted_source) —— 想知道控件在不在，用 cu_state 重读比对标签。',
    parameters: {
      pid: { type: 'integer', description: '目标进程 pid' },
      windowId: { type: 'integer', description: '窗口 id' },
      title: { type: 'string', description: '窗口标题子串（替代 pid+windowId）' },
      expect: {
        type: 'json',
        description:
          '谓词数组（1-8 条，AND 组合），或 JSON 字符串。可用例子：' +
          '{"window":{"exists":true}}；' +
          '{"window":{"bounds":{"x":476,"y":111,"width":800,"height":600,"tolerance_px":8}}}（x/y/width/height 必须给全）。',
        required: true,
      },
      timeoutMs: { type: 'integer', description: '等待满足的超时（默认 5000）' },
      stableSamples: { type: 'integer', description: '需要连续稳定几次采样才算满足' },
    },
    run: async (args) => {
      const target = await resolveTarget(args)
      const { pid, windowId } = target
      if (!pid || !windowId) throw new Error('缺 pid+windowId（或 title）')
      const expect = asObject(args.expect, 'expect')
      const list = Array.isArray(expect) ? expect : [expect]
      if (list.length < 1 || list.length > 8) {
        throw new Error(`expect 谓词条数须在 1-8 之间（实际 ${list.length} 条）`)
      }
      // 声明写的是「1-8 条谓词数组」：以前只要求「至少有一条非空对象」，
      // 20 条或 [1,2,{...}] 这类脏数据会原样喂给驱动。
      if (!list.every((p) => p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length > 0)) {
        throw new Error('expect 是空谓词：每条都必须是非空 JSON 对象，例：{"window":{"exists":true}}')
      }
      const payload = { pid, window_id: windowId, expect: list, timeout_ms: posInt(args.timeoutMs) || 5000 }
      if (args.stableSamples) payload.stable_samples = posInt(args.stableSamples)
      const res = await bridge.callTool('verify_state', payload, cfg.stateTimeoutMs + 5000)
      if (res.isError) return { text: errText(res) }
      return { text: fmtVerify(res.structured) }
    },
  })

  /* --------------------------------------------------------------- 键盘 */

  const key = textOutput({
    name: 'cu_key',
    timeoutMs: 60000,
    description:
      '发键盘给某个进程：单键（Enter / Escape / Tab / Backspace / Delete / 四方向 / Space / Home / End / PageUp / PageDown / F1-F12）、' +
      '组合键（Ctrl+Shift+T 用 + 连接）、或直接输入文本（给 text）。' +
      '**默认 foreground**：Chromium/Electron（Chrome_WidgetWin_1）直接拒收 background 键盘；' +
      'foreground 只在动作期间短暂置前，结束后驱动自己还原。' +
      '菜单项点不动时优先用它（Alt+首字母 / 方向键 + Enter）。pid 必填 —— 驱动按进程投递键盘。',
    parameters: {
      pid: { type: 'integer', description: '目标进程 pid' },
      title: { type: 'string', description: '窗口标题子串（替代 pid，内部解析出进程）' },
      key: { type: 'string', description: '键名或组合键（如 Escape、Ctrl+A）；与 text 二选一' },
      text: { type: 'string', description: '要输入的文本；给了它就改走 type_text' },
      deliveryMode: { type: 'string', description: 'foreground（默认）或 background' },
      windowId: { type: 'integer', description: '限定窗口（可选，多数键盘事件不需要）' },
      observe: { type: 'boolean', description: '发完顺手读一次目标窗口的迷你快照（默认 false）' },
    },
    run: async (args) => {
      let pid = posInt(args.pid)
      let resolvedNote = ''
      // 按标题只解析一次：observe 复核也要 windowId，同一份窗口表不该再查一遍
      // （list_windows 一次 ~50ms，纯重复往返）
      let resolved = null
      if (!pid && args.title) {
        resolved = await resolveTarget({ title: args.title })
        pid = resolved.pid
        resolvedNote = `按标题解析到 pid ${resolved.pid}${resolved.note}`
      }
      if (!pid) throw new Error('缺 pid（键盘按进程投递，必须有 pid；也可以给 title 让它自己找）')
      const delivery = String(args.deliveryMode ?? 'foreground')
      const base = { pid, delivery_mode: delivery }
      const windowId = posInt(args.windowId)
      if (windowId) base.window_id = windowId

      let payload
      let what
      if (args.text !== undefined && args.text !== null && String(args.text).length > 0) {
        what = `输入文本「${String(args.text).slice(0, 24)}」`
        payload = { ...base, text: String(args.text) }
      } else {
        const k = String(args.key ?? 'Enter').trim()
        if (k.includes('+')) {
          what = `组合键 ${k}`
          payload = { ...base, keys: k.split('+').map((s) => s.trim()).filter(Boolean) }
        } else {
          what = `按键 ${k}`
          payload = { ...base, key: k }
        }
      }

      const method = payload.text !== undefined ? 'type_text' : payload.keys ? 'hotkey' : 'press_key'
      // 键盘可视化：旧实现键盘路径完全不碰覆盖层，叠加驱动默认 15 秒自动隐藏，
      // 就是「打字时光标老是不见」。这里先自愈覆盖层，再给一条醒目的键盘动作行。
      const kbNotes = cfg.keyboardOverlay === false ? [] : await ensureCursorVisible()
      const kbLine =
        `⌨ 键盘动作：${what} → pid ${pid}${windowId ? ` / window ${windowId}` : ''} · ` +
        `桌面覆盖层 ${cursor.enabled ? '可见' : '待确认'} · ${overlay.enabled ? '按键浮窗已请求' : '按键浮窗已关闭'}`
      // 桌面按键浮窗：fire-and-forget。首次 PowerShell Add-Type 编译可能要 1 秒，
      // 绝不让它拖慢键盘动作；浮窗进程懒启动、失败也只是「没有浮窗」。
      if (overlay.enabled) {
        const kbText =
          args.text !== undefined && String(args.text).length > 0
            ? `⌨ ${String(args.text).slice(0, 40)}`
            : `⌨ ${String(args.key ?? 'Enter').trim()}`
        let pos = {}
        if (resolved?.wins?.length) {
          const ow = resolved.wins.find((x) => x.window_id === resolved.windowId) ?? resolved.wins.find((x) => x.pid === pid)
          if (ow?.bounds) {
            pos = {
              x: Number(ow.bounds.x) + Number(ow.bounds.width) / 2,
              y: Number(ow.bounds.y) + Number(ow.bounds.height) / 2,
            }
          }
        }
        void overlay.show(kbText, pos).catch(() => {})
      }
      let res = await bridge.callTool(method, payload, cfg.stateTimeoutMs)
      let restoredNote = ''
      // 最小化窗口不收 foreground 键盘（驱动会回 window_minimized 或静默丢事件）：恢复后重投一次
      if (isMinimizedRefusal(res)) {
        const fix = await ensureWindowVisible(pid, windowId || 0)
        if (fix.note) restoredNote = fix.note
        if (fix.restored) res = await bridge.callTool(method, payload, cfg.stateTimeoutMs)
      }
      if (res.isError) return { text: [kbLine, errText(res), ...kbNotes, restoredNote].filter(Boolean).join('\n') }

      const sc = res.structured ?? {}
      const mode = sc.delivery?.mode ?? sc.delivery_mode ?? delivery
      const lines = [
        kbLine,
        `已发送 ${what} · ${method} · delivery=${mode}${sc.effect ? ` · effect=${sc.effect}` : ''}`,
        ...kbNotes,
      ]
      if (cfg.keyboardOverlay !== false && !cursor.unsupported) {
        // 驱动会在动作后更新 cursor 的语义播放状态：这是键盘侧唯一的原生可视化反馈
        const vs = await cursorState()
        const v = vs?.visual_state
        if (v) lines.push(`覆盖层视觉状态：requested=${v.requested_action ?? '?'} resolved=${v.resolved_action ?? '?'} modifiers=[${(v.modifiers ?? []).join(',')}]`)
      }
      if (sc.error) lines.push(`error: ${typeof sc.error === 'string' ? sc.error : JSON.stringify(sc.error)}`)
      if (resolvedNote) lines.push(resolvedNote)
      if (args.observe !== true && (sc.effect === 'unverifiable' || !sc.effect)) {
        lines.push('⚠ 送达 ≠ 生效：要确认界面真的变了，用 cu_state 重读，或传 observe:true 让本工具顺手读一份快照。')
      }

      if (args.observe === true) {
        let wid = windowId
        let why = ''
        if (!wid && args.title) {
          const t = resolved ?? (await resolveTarget({ title: args.title }))
          wid = posInt(t.windowId)
        }
        if (!wid) {
          // 只给 pid 时不能静默跳过 observe：按 pid 找窗口，实在找不到也要如实说明
          const wins = await listAllWindows().catch(() => [])
          const hit = wins.find((w) => w.pid === pid && w.is_on_screen !== false) ?? wins.find((w) => w.pid === pid)
          wid = posInt(hit?.window_id)
          if (!wid) why = `没找到 pid ${pid} 的窗口，无法复核（显式传 windowId 或 title 可修）`
        }
        if (wid) {
          const r = await readState(pid, wid, {})
          if (r.count >= 0) {
            lines.push('', `复核快照（${r.count} 元素）：`)
            lines.push(...fmtStateRows(r.sc, { maxChars: BRIEF_MAX_CHARS }))
          } else why = '复核读树失败，用 cu_state 重读确认'
        }
        if (why) lines.push(`⚠ ${why}`)
      }
      return { text: lines.join('\n') }
    },
  })

  /* ------------------------------------------------- 诊断阶梯一键跑完 */

  const recover = textOutput({
    name: 'cu_recover',
    timeoutMs: 150000,
    description:
      '把「树读不到」一次修好：重读（settle）→ 换同名兄弟窗口 → 按 AUMID 重新拉起应用，每步都报元素数，' +
      '成功时直接告诉你该用哪个 pid/windowId 继续。' +
      '实测：Windows「设置」的两个 pid（SystemSettings.exe / ApplicationFrameHost.exe）同时读 0 元素，' +
      'relaunch 后同一窗口从 0 变 50 个元素。可以只给 title（按标题找候选）。' +
      'relaunch 会重启该应用实例（用户屏幕上看得见），拿不准就先不加。',
    parameters: {
      pid: { type: 'integer', description: '窗口所属进程 pid' },
      windowId: { type: 'integer', description: '窗口 id' },
      title: { type: 'string', description: '窗口标题（不给 pid/windowId 时按它找候选）' },
      relaunch: { type: 'boolean', description: '走完前两步仍为空时，按 AUMID 重新拉起应用（默认 false）' },
      app: { type: 'string', description: '重拉用的应用名 / AUMID / 可执行文件；留空按标题与进程名自动解析' },
      maxAttempts: { type: 'integer', description: '每个窗口最多重读几次（默认 2）' },
    },
    run: async (args) => {
      const steps = []
      const tries = Math.min(Math.max(posInt(args.maxAttempts) || 2, 1), 4)
      const wantTitle = String(args.title ?? '').trim()

      const readOnce = async (pid, windowId) => {
        const r = await readState(pid, windowId, {})
        return { count: r.count, sc: r.sc }
      }

      const readSettled = async (pid, windowId, round) => {
        const counts = []
        let best = { count: 0, sc: null }
        for (let i = 0; i < round; i++) {
          const r = await readOnce(pid, windowId)
          counts.push(r.count)
          if (r.count > best.count) best = r
          if (r.count >= SETTLE_MIN_ELEMENTS) break
          if (r.count === 0 && r.sc?.degraded === true) break
          if (i < round - 1) await sleep(450)
        }
        return { ...best, counts }
      }

      // 1) 候选窗口
      let candidates = []
      let winsAll = null
      const pid0 = posInt(args.pid)
      const wid0 = posInt(args.windowId)
      if (pid0 && wid0) {
        candidates = [{ pid: pid0, window_id: wid0, title: wantTitle }]
      } else if (wantTitle) {
        // 全量表：最小化/离屏窗口也在里面，别把「在但最小化」当成「没找到」
        winsAll = await listAllWindows().catch(() => [])
        candidates = winsAll.filter((w) => String(w.title ?? '').toLowerCase().includes(wantTitle.toLowerCase()))
      } else {
        throw new Error('需要 pid+windowId，或至少给一个 title')
      }
      if (!candidates.length) throw new Error(`没找到标题含「${wantTitle}」的窗口（先 cu_windows 看看）`)

      // 2) 逐个 settle 重读
      for (const c of candidates) {
        const tag = `${c.pid}/${c.window_id}${c.title ? `「${c.title}」` : ''}`
        const r = await readSettled(c.pid, c.window_id, tries)
        const allFailed = r.counts.length > 0 && r.counts.every((n) => n < 0)
        // -1 是「读树报错」的哨兵，不是元素数：混在数组里会打出「-1 → 0 个元素」
        const countsText = r.counts.map((n) => (n < 0 ? '报错' : n)).join(' → ')
        steps.push(`① 重读 ${tag}：${allFailed ? '读取报错（窗口可能已关闭）' : `${countsText} 个元素`}`)
        if (r.count >= SETTLE_MIN_ELEMENTS) {
          return {
            text: [...steps, `✅ 可用：pid=${c.pid} windowId=${c.window_id}（${r.count} 个元素）`, '继续用 cu_state / cu_click 时传这两个值。'].join('\n'),
            pid: c.pid,
            windowId: c.window_id,
            elements: r.count,
          }
        }
      }

      // 3) 同名兄弟窗口（UWP 本体 vs ApplicationFrameHost；应用 vs 启动器）
      const titles = new Set(candidates.map((c) => String(c.title ?? '').trim()).filter(Boolean))
      const exeNames = new Set()
      const winsNow = winsAll ?? (await listAllWindows().catch(() => []))
      if (!titles.size) {
        for (const c of candidates) {
          const hit = winsNow.find((w) => w.pid === c.pid && w.window_id === c.window_id)
          if (hit?.title) titles.add(String(hit.title).trim())
          if (hit?.app_name) exeNames.add(String(hit.app_name).trim())
        }
      }
      const tried = new Set(candidates.map((c) => `${c.pid}:${c.window_id}`))
      const siblings = winsNow.filter((w) => titles.has(String(w.title ?? '').trim()) && !tried.has(`${w.pid}:${w.window_id}`))
      for (const s of siblings) {
        const r = await readSettled(s.pid, s.window_id, tries)
        steps.push(`② 换兄弟窗口 ${s.pid}/${s.window_id}（${s.app_name}）：${r.counts.map((n) => (n < 0 ? '报错' : n)).join(' → ')} 个元素`)
        if (r.count >= SETTLE_MIN_ELEMENTS) {
          return {
            text: [...steps, `✅ 这个才是真外壳：pid=${s.pid} windowId=${s.window_id}（${r.count} 个元素）`, '继续用它；原来那个是同名幽灵窗口（UIA 树恒空）。'].join('\n'),
            pid: s.pid,
            windowId: s.window_id,
            elements: r.count,
          }
        }
      }
      if (!siblings.length) steps.push('② 没有别的同名窗口可换')

      // 4) 重新拉起（可选，最后一步）
      if (args.relaunch !== true) {
        return {
          text: [...steps, '✗ 仍然是 0 元素 —— 典型的陈旧实例（窗口在屏上但界面没渲染）。', '下一步：cu_recover 加 relaunch:true 按 AUMID 重拉一次（实测可恢复）。'].join('\n'),
          recovered: false,
        }
      }

      const appsRes = await bridge.callTool('list_apps', {}, 25000)
      const apps = appsRes.structured?.apps ?? []
      const want = String(args.app ?? '').trim().toLowerCase()
      const titleKeys = [...titles].map((t) => t.toLowerCase())
      const exeKeys = [...candidates.map((c) => String(c.app_name ?? '')), ...exeNames]
        .map((n) => n.toLowerCase().replace(/\.exe$/, ''))
        .filter(Boolean)

      let app = null
      if (want) {
        app =
          apps.find(
            (a) =>
              String(a.name ?? '').toLowerCase() === want ||
              String(a.bundle_id ?? '').toLowerCase() === want ||
              String(a.launch_path ?? '').toLowerCase() === want,
          ) ?? apps.find((a) => `${a.name ?? ''} ${a.bundle_id ?? ''}`.toLowerCase().includes(want))
      }
      if (!app) app = apps.find((a) => titleKeys.includes(String(a.name ?? '').toLowerCase()))
      if (!app) {
        app = apps.find((a) => {
          const n = String(a.name ?? '').toLowerCase()
          return exeKeys.some((k) => k && (n.includes(k) || k.includes(n)))
        })
      }
      if (!app) {
        steps.push('③ 从 list_apps 里找不到对应应用，无法自动重拉')
        steps.push('   手动：cu_call({tool:"launch_app", args:{name:"<显示名>"}})，再 cu_state 读新窗口。')
        return { text: steps.join('\n'), recovered: false }
      }

      const launchPlans = []
      if (String(app.bundle_id ?? '').includes('!')) launchPlans.push({ aumid: app.bundle_id })
      if (app.name) launchPlans.push({ name: app.name })
      // `${bundle_id}!App` 不是真 AUMID（实测必失败），别白搭一次 25s 超时预算；
      // 完整 AUMID 需形如 <bundle_id>!<真实 AppId>。
      if (app.launch_path) launchPlans.push({ launch_path: app.launch_path })
      if (String(app.launch_path ?? '').toLowerCase().endsWith('.exe')) launchPlans.push({ path: app.launch_path })

      const before = new Set(winsNow.map((w) => `${w.pid}:${w.window_id}`))
      let launched = null
      for (const plan of launchPlans) {
        try {
          const res = await bridge.callTool('launch_app', plan, 25000)
          if (!res.isError) {
            launched = plan
            steps.push(`③ 重新拉起 ${JSON.stringify(plan)}：${String(res.text ?? '').split('\n')[0].slice(0, 120)}`)
            break
          }
          steps.push(`③ 拉起失败 ${JSON.stringify(plan)}：${String(res.text ?? '').slice(0, 100)}`)
        } catch (err) {
          steps.push(`③ 拉起异常 ${JSON.stringify(plan)}：${err.message}`)
        }
      }
      if (!launched) {
        steps.push('   → 换 cu_call 的 launch_app 手动指定 aumid（bundle_id!ApplicationId）再试。')
        return { text: steps.join('\n'), recovered: false }
      }

      // 等新窗口出现（UWP 可能沿用同一个 window_id，所以按标题重新枚举）
      const deadline = Date.now() + 9000
      let fresh = []
      while (Date.now() < deadline) {
        await sleep(700)
        // before 来自全量窗口表，这里也必须全量：否则最小化/离屏的新窗口被筛掉，
        // 或沿用旧 window_id 的新实例被当成「没变化」，重拉成功却报失败。
        const now = (await listAllWindows()).filter((w) => titleKeys.includes(String(w.title ?? '').trim().toLowerCase()))
        const changed = now.filter((w) => !before.has(`${w.pid}:${w.window_id}`))
        fresh = changed.length ? changed : now
        if (fresh.length) {
          const probe = await readOnce(fresh[0].pid, fresh[0].window_id)
          if (probe.count >= SETTLE_MIN_ELEMENTS) break
        }
      }
      for (const w of fresh) {
        const r = await readSettled(w.pid, w.window_id, tries)
        steps.push(`④ 新实例 ${w.pid}/${w.window_id}（${w.app_name}）：${r.counts.map((n) => (n < 0 ? '报错' : n)).join(' → ')} 个元素`)
        if (r.count >= SETTLE_MIN_ELEMENTS) {
          return {
            text: [...steps, `✅ 恢复成功：pid=${w.pid} windowId=${w.window_id}（${r.count} 个元素）`, '陈旧实例已被替换，现在可以正常 cu_state / cu_click。'].join('\n'),
            recovered: true,
            pid: w.pid,
            windowId: w.window_id,
            elements: r.count,
          }
        }
      }
      steps.push('✗ 重拉后仍读不到元素：可能该应用禁用了 UIA（canvas/自定义绘制），只能走截图 + 坐标路径。')
      return { text: steps.join('\n'), recovered: false }
    },
  })

  /* ------------------------------------------------------------- 逃生口 */

  const call = textOutput({
    name: 'cu_call',
    timeoutMs: 180000,
    description:
      '直接转发给驱动原生 MCP 面（59 个工具，含 launch_app / invoke_menu / zoom / 录制 / 截图等）。' +
      '滚动、拖拽、剪贴板已有 cu_scroll / cu_drag / cu_clipboard 直连工具，不必再走这里。' +
      '不传 tool 就是列工具清单（可用 query 过滤）；cu_* 没覆盖到的能力都走这里。' +
      '调用 list_apps 时会重排成带 bundle_id / launch_path 的清单 —— 重拉包装应用（UWP/MSIX）就靠这两个字段。',
    parameters: {
      tool: { type: 'string', description: '原生工具名（不传 = 列工具清单）' },
      query: { type: 'string', description: '列清单时按名字/描述过滤' },
      refresh: { type: 'boolean', description: '列清单时强制重拉 tools/list（默认用缓存；query 只做过滤）' },
      args: { type: 'json', description: '该工具的参数对象（也可传 JSON 字符串）' },
      timeoutMs: { type: 'integer', description: '本次调用超时（默认 30000）' },
    },
    run: async (args) => {
      const name = String(args.tool ?? '').trim()
      if (!name) {
        // listTools(force) 的语义是「缓存失效」，和 query 过滤毫无关系：
        // 以前带 query 会白跑一次 tools/list，不带 query 则永远吃缓存。
        const tools = await bridge.listTools(args.refresh === true)
        return { text: fmtTools(tools, args.query) }
      }
      const payload = asObject(args.args, 'args')
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('args 必须是 JSON 对象（例：{"pid":42,"window_id":123}），不能是数字/数组/裸值')
      }
      const res = await bridge.callTool(name, payload, posInt(args.timeoutMs) || 30000)
      if (res.isError) return { text: errText(res) }
      if (name === 'list_apps' && res.structured) {
        return { text: fmtApps(res.structured, { query: payload.query ?? args.query, limit: posInt(payload.limit) || 80 }) }
      }
      const text = res.text || '(驱动返回空内容)'
      return { text: text.length > 20000 ? `${text.slice(0, 20000)}\n…(截断，共 ${text.length} 字)` : text }
    },
  })

  /* ------------------------------------------- 覆盖层诊断 / 便捷动作 */
  const cursorStatusText = () =>
    `插件侧记录：configured=${cursor.configured} unsupported=${cursor.unsupported} attempts=${cursor.attempts}` +
    `${cursor.lastError ? ` · ${cursor.lastError}` : ''}`

  const cursorTool = textOutput({
    name: 'cu_cursor',
    timeoutMs: 30000,
    description:
      '鼠标 / 键盘覆盖层的诊断与控制：status（默认）、show（自愈启用）、hide、place（放到窗口坐标）。' +
      '「鼠标光标老是不见」先跑 status：驱动默认 idle_hide_ms=15000 会闲置 15 秒自动隐藏，' +
      'show 会改成永不自动隐藏 + 120ms 直移，并回读验证。',
    parameters: {
      action: { type: 'string', description: 'status（默认）| show | hide | place' },
      pid: { type: 'integer', description: 'place 时的目标 pid（也可给 title）' },
      windowId: { type: 'integer', description: 'place 时的窗口 id' },
      title: { type: 'string', description: '按标题解析目标窗口' },
      x: { type: 'number', description: 'place 的窗口局部截图像素 X' },
      y: { type: 'number', description: 'place 的窗口局部截图像素 Y' },
    },
    run: async (args) => {
      const action = String(args.action ?? 'status').trim().toLowerCase()
      if (action === 'hide') {
        await bridge.callTool('set_agent_cursor_enabled', { session: AGENT_SESSION, enabled: false }, 8000)
        cursor.enabled = false
        cursor.configured = false
        return { text: '鼠标覆盖层已隐藏；下一次 cu_click / cu_key 会自动重新启用。' }
      }
      if (action === 'show') {
        const notes = await ensureCursorVisible(true)
        // 顺手预热浮窗进程：首次 Add-Type 编译 ~1 秒，别留到用户第一次按键才等
        if (overlay.enabled) void overlay.ensure().catch(() => {})
        return { text: [...notes, cursorStatusText(), `按键浮窗：${JSON.stringify(overlay.describe())}`].join('\n') }
      }
      if (action === 'place') {
        const target = await resolveTarget(args)
        if (!target.pid || !target.windowId) throw new Error('place 需要 pid+windowId，或给 title 让我解析')
        const notes = await placeCursor(target.pid, target.windowId, Number(args.x), Number(args.y))
        return { text: [...notes, cursorStatusText()].join('\n') }
      }
      const s = await cursorState()
      if (!s || typeof s.enabled !== 'boolean') {
        return { text: ['⚠ 读不到 agent cursor 状态（驱动可能没有这套工具面）', cursor.lastError, cursorStatusText()].filter(Boolean).join('\n') }
      }
      return {
        text: [
          `鼠标覆盖层：enabled=${s.enabled} · idle_hide_ms=${s.motion?.idle_hide_ms ?? '?'} · timing=${s.motion?.timing ?? '?'} · glide=${s.motion?.glide_duration_ms ?? '?'}ms`,
          `位置：${s.position ? `${s.position.x},${s.position.y}` : 'null（还没被放到屏幕上）'} · 主题 ${s.theme?.id ?? '?'}`,
          `语义播放：requested=${s.visual_state?.requested_action ?? '?'} resolved=${s.visual_state?.resolved_action ?? '?'} modifiers=[${(s.visual_state?.modifiers ?? []).join(',')}]`,
          '',
          cursorStatusText(),
          s.enabled && Number(s.motion?.idle_hide_ms) === 0
            ? '✅ 已是「永不自动隐藏」，不会再闲置 15 秒后消失。'
            : '⚠ 不是「永不自动隐藏」：传 action:"show" 触发自愈（启用 + idle_hide_ms=0 + 120ms 直移）。',
        ].join('\n'),
      }
    },
  })

  const scrollTool = textOutput({
    name: 'cu_scroll',
    timeoutMs: 60000,
    description:
      '滚动窗口：direction(up/down/left/right) + amount(默认 3) + by(line/page)，可直接传 title 定位。' +
      '以前只能 cu_call({tool:"scroll",...})；注意坐标/焦点仍是驱动侧语义，滚动后要确认界面变化用 cu_state。',
    parameters: {
      pid: { type: 'integer', description: '目标进程 pid' },
      windowId: { type: 'integer', description: '窗口 id' },
      title: { type: 'string', description: '窗口标题子串' },
      direction: { type: 'string', description: 'up | down | left | right（默认 down）' },
      amount: { type: 'integer', description: '滚动格数（默认 3）' },
      by: { type: 'string', description: 'line（默认）| page' },
      deliveryMode: { type: 'string', description: 'background（默认）| foreground' },
    },
    run: async (args) => {
      const target = await resolveTarget(args)
      if (!target.pid) throw new Error('缺 pid（或 title）')
      const dir = String(args.direction ?? 'down').trim().toLowerCase()
      if (!['up', 'down', 'left', 'right'].includes(dir)) throw new Error('direction 只能是 up / down / left / right')
      const payload = { pid: target.pid, direction: dir, amount: posInt(args.amount) || 3 }
      if (posInt(target.windowId)) payload.window_id = target.windowId
      const by = String(args.by ?? '').trim().toLowerCase()
      if (by) payload.by = by
      if (args.deliveryMode) payload.delivery_mode = String(args.deliveryMode)
      const res = await bridge.callTool('scroll', payload, cfg.defaultTimeoutMs)
      if (res.isError) return { text: errText(res) }
      return {
        text: [
          `↕ 滚动 ${dir} ×${payload.amount}${by ? ` (${by})` : ''} → pid ${target.pid}${payload.window_id ? ` / window ${payload.window_id}` : ''}`,
          target.note,
          res.text || '(驱动无附加输出；要确认界面变化请 cu_state 重读)',
        ].filter(Boolean).join('\n'),
      }
    },
  })

  const dragTool = textOutput({
    name: 'cu_drag',
    timeoutMs: 90000,
    description:
      '按住拖动：fromX/fromY → toX/toY（窗口局部截图像素，与 cu_state 截图同源），可给 title。' +
      'durationMs 默认 500、steps 默认 20。以前只能 cu_call({tool:"drag",...})。',
    parameters: {
      pid: { type: 'integer', description: '目标进程 pid' },
      windowId: { type: 'integer', description: '窗口 id' },
      title: { type: 'string', description: '窗口标题子串' },
      fromX: { type: 'number', description: '起点 X（截图像素）' },
      fromY: { type: 'number', description: '起点 Y' },
      toX: { type: 'number', description: '终点 X' },
      toY: { type: 'number', description: '终点 Y' },
      durationMs: { type: 'integer', description: '拖动时长（默认 500）' },
      steps: { type: 'integer', description: '插值步数（默认 20）' },
      button: { type: 'string', description: 'left（默认）| right | middle' },
    },
    run: async (args) => {
      const target = await resolveTarget(args)
      if (!target.pid) throw new Error('缺 pid（或 title）')
      const coords = [args.fromX, args.fromY, args.toX, args.toY].map(Number)
      if (!coords.every(Number.isFinite)) throw new Error('缺 fromX/fromY/toX/toY（都必须是数字，窗口局部截图像素）')
      const payload = {
        pid: target.pid,
        from_x: coords[0], from_y: coords[1], to_x: coords[2], to_y: coords[3],
        duration_ms: posInt(args.durationMs) || 500,
        steps: posInt(args.steps) || 20,
      }
      if (posInt(target.windowId)) payload.window_id = target.windowId
      if (args.button) payload.button = String(args.button)
      const res = await bridge.callTool('drag', payload, cfg.stateTimeoutMs)
      if (res.isError) return { text: errText(res) }
      return {
        text: [
          `↗ 拖动 (${coords[0]},${coords[1]}) → (${coords[2]},${coords[3]}) · ${payload.duration_ms}ms / ${payload.steps} 步`,
          target.note,
          res.text || '(驱动无附加输出)',
        ].filter(Boolean).join('\n'),
      }
    },
  })

  const clipboardTool = textOutput({
    name: 'cu_clipboard',
    timeoutMs: 30000,
    description:
      '读写系统剪贴板：action:"read" 列可用类型（includeText:true 才返回明文，默认不读，避免泄露）、' +
      'action:"write" + text 写入纯文本。以前只能 cu_call({tool:"clipboard_read/clipboard_write",...})。',
    parameters: {
      action: { type: 'string', description: 'read（默认）| write' },
      text: { type: 'string', description: 'write 时写入的纯文本' },
      includeText: { type: 'boolean', description: 'read 时是否返回明文（默认 false）' },
    },
    run: async (args) => {
      const action = String(args.action ?? 'read').trim().toLowerCase()
      if (action === 'write') {
        const text = String(args.text ?? '')
        if (!text) throw new Error('write 需要非空 text')
        const res = await bridge.callTool('clipboard_write', { text }, 15000)
        if (res.isError) return { text: errText(res) }
        return { text: `📋 已写入剪贴板（${text.length} 字）。\n${res.text || ''}`.trim() }
      }
      const res = await bridge.callTool('clipboard_read', { include_text: args.includeText === true }, 15000)
      if (res.isError) return { text: errText(res) }
      return {
        text: [
          '📋 剪贴板类型：',
          res.text || '(驱动无附加输出)',
          args.includeText !== true ? '（未读明文：需要内容时传 includeText:true）' : '',
        ].filter(Boolean).join('\n'),
      }
    },
  })

  const defs = [doctor, windows, windowInfo, state, click, verify, key, recover, call, cursorTool, scrollTool, dragTool, clipboardTool]

  // `enabled` 是 volatile：关掉后工具仍注册但拒绝执行（设置里改完即时生效，不用重启）
  if (typeof isEnabled === 'function') {
    for (const def of defs) {
      const inner = def.execute
      def.execute = async (args, exec) => {
        if (!isEnabled()) {
          return { text: '本插件已在 DSH 设置里关闭（computer-use-pro.enabled=false），cu_* 工具不执行。', disabled: true }
        }
        return inner(args, exec)
      }
    }
  }

  return defs
}
/** 截图路径：相对路径落到配置的截图目录；~ 展开 */
export function resolveShotPath(input, cfg) {
  const raw = expandHome(String(input))
  const dir = expandHome(cfg.screenshotDir || '~/.dsh/computer-use/shots')
  let out = raw
  if (!path.isAbsolute(raw)) out = path.join(dir, raw)
  else if (!path.extname(raw)) out = path.join(raw, `shot-${Date.now()}.png`)
  try {
    mkdirSync(path.dirname(out), { recursive: true })
  } catch {
    /* 目录建不了就让驱动自己去报错 */
  }
  if (existsSync(out) && statSync(out).isDirectory()) {
    out = path.join(out, `shot-${Date.now()}.png`)
  }
  return out
}

/* ------------------------------------------------ 提示节 / 文档单一数据源 */

/** 系统提示节里的工具清单由实际注册的定义生成：加工具不会再漏改提示 */
export function toolRoster(defs) {
  return defs
    .map((d) => `- \`${d.name}\`：${String(d.description ?? '').replace(/\s+/g, ' ').split(/[。；]/)[0].slice(0, 110)}`)
    .join('\n')
}

/** 桌面控制的使用规则（规则本身无法从工具定义推导，集中放在这里供提示节与文档校验复用） */
export const ROUTING_RULES = [
  '- 要操作本机 GUI（点按钮 / 填输入框 / 读某个窗口的控件）→ `cu_state` 直接传 `title:"<窗口标题子串>"`，拿每行末的 `element_token` 再用 `cu_click` 按 label 点。',
  '- 观察输出自带折叠：默认只列可点元素与输入框；树很大用 `query` 收窄，别靠 `maxDepth` 硬截。',
  '- `cu_click` 复核看**三样**：元素数、目标控件状态（标签/值/选中）、窗口状态。「点喜欢 → 数字 +1」这种元素数不变的成功也能判对，**不要**因为元素数没变再点一次。',
  '- 同名命中多个（时间线里每条都有「转帖」）→ 传 `index` 选第几个（0 起），输出会列全部候选；别猜坐标。',
  '- 窗口最小化/离屏时 foreground / 像素点击会静默落空 —— `cu_state` 会警告，`cu_click` 会先 `bring_to_front` 恢复。',
  '- 弹出的菜单/对话框常在**另一个窗口**：`cu_click` 复核会对比窗口表并点名 pid/windowId，用 `cu_state` 读它。',
  '- 元素行末 `▾expand` 表示只支持展开；驱动仍拒绝时改用 `cu_key`（Alt+首字母、方向键+Enter），不要反复重试同一点。',
  '- **要看画面**传 `screenshot:true`：`cu_state` 把窗口截图作为图片直接返回并落盘，图上的像素坐标就是 `cu_click` 的 x,y。`cu_click` 点完会回一张**带红圈的新截图**，先看画面再决定下一步。',
  '- **鼠标光标不见了** → `cu_cursor({action:"status"})` 看诊断，`cu_cursor({action:"show"})` 自愈（驱动默认闲置 15 秒自动隐藏，插件已改为永不自动隐藏 + 120ms 直移）。覆盖层是独立顶层窗口，窗口截图拍不到它，图上的红圈是插件按同一像素坐标画的。',
  '- 键盘 → `cu_key`（默认 foreground；Chromium 拒收 background 键盘），输出里会带 `⌨` 动作行与覆盖层视觉状态。',
  '- 滚动 / 拖拽 / 剪贴板 → `cu_scroll` / `cu_drag` / `cu_clipboard`；更冷门的原生能力（launch_app / invoke_menu / zoom / 录制…）→ `cu_call({tool,args})`，不传 tool 就是列清单。',
  '- 树为空 / 读不到元素 → **不要**猜坐标：`cu_recover`（重读 → 换同名兄弟窗口 → `relaunch:true` 按 AUMID 重拉）一次走完。链路可疑先 `cu_doctor`。',
  '- 键盘动作会在桌面弹一个置顶按键浮窗（`keyboardOverlayWindow:false` 可关）；`cu_cursor({action:"show"})` 可提前预热，避免首次 PowerShell 编译的等待。慢机器可设 `observeProfile:"fast"` 减少复核取样轮数。',
]
