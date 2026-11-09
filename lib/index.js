/**
 * dsh-computer-use-pro —— 把 MiniMax 电脑操控驱动接进 DeepSeek Harness
 *
 * 为什么不是「再包一层 MCP client」：
 *   驱动自己在 Windows 上就提供 MCP stdio server（direct runtime），插件只要
 *   起一个常驻子进程、握手、转发就够，不需要宿主侧再挂一个 MCP server 配置。
 *   好处是零配置、能控子进程生命周期（空闲回收 / 超时杀进程重来），
 *   也不占宿主的 MCP 通道。
 *
 * 只用具名导出（`export default` 会被 unwrapExports 折叠，静默丢掉 inject/Config）。
 * `Config` 里的非 volatile 字段改动需要重启 DSH；`enabled` 是 volatile，改完即时生效
 * （工具常驻注册，执行时读开关）。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DriverBridge, findDriverExe } from './driver.js'
import { createTools, toolRoster, ROUTING_RULES } from './tools.js'
import { registerSkill } from './skill.js'
import { buildConfig, SCHEMA_ERROR, SCHEMA_SOURCE } from './schema-kit.js'
import { createInstanceStatus } from './status.js'
import { TOOL_KIT_ERROR, TOOL_KIT_SOURCE } from './tool-kit.js'

export const name = 'dsh-computer-use-pro'
export const version = '0.3.6'

/** 没有工具服务就没有本插件的意义；缺了就不激活，绝不阻断别的插件。 */
export const inject = ['tools']

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOG = '[computer-use]'

export const Config = buildConfig((Schema) =>
  Schema.object({
    enabled: Schema.boolean()
      .description('注册 cu_* 工具并允许它们执行。关掉等于软禁用（即时生效）')
      .default(true)
      .volatile(),
    driverPath: Schema.string()
      .description('电脑操控驱动路径（exe 或目录）。留空自动扫 ~/.minimax/computer-use/components')
      .default(''),
    promptSection: Schema.boolean()
      .description('向系统提示注入一小节「桌面控制工具路由」，解决工具装了但模型不主动用的问题')
      .default(true),
    defaultDelivery: Schema.string()
      .description('点击投递方式：background（默认，不抢前台）或 foreground')
      .default('background'),
    defaultTimeoutMs: Schema.natural().description('单次驱动调用的默认超时（毫秒）').default(20000),
    stateTimeoutMs: Schema.natural().description('观察/点击类调用的超时（毫秒）').default(60000),
    maxElements: Schema.natural().description('一次走查最多取多少个元素').default(400),
    maxChars: Schema.natural().description('元素清单的输出字符预算').default(8000),
    idleShutdownMs: Schema.natural().description('驱动子进程空闲多久自动回收（毫秒，0=不回收）').default(120000),
    screenshotDir: Schema.string().description('截图默认落盘目录').default('~/.dsh/computer-use/shots'),
    keyboardOverlay: Schema.boolean().description('键盘操作时自愈并展示桌面覆盖层，输出带 ⌨ 动作行与视觉状态').default(true),
    keyboardOverlayWindow: Schema.boolean().description('自绘置顶按键浮窗（Ctrl+A / 输入文本），不抢焦点、鼠标穿透').default(true),
    overlayDurationMs: Schema.natural().description('按键浮窗显示时长（毫秒）').default(1400),
    overlayIdleShutdownMs: Schema.natural().description('按键浮窗空闲多久回收进程（毫秒，0=不回收）').default(60000),
    overlayTheme: Schema.string().description('浮窗主题：dark | light | accent').default('dark'),
    overlayFontSize: Schema.natural().description('浮窗键帽字号（10-32）').default(15),
    overlayOpacityPct: Schema.natural().description('浮窗不透明度百分比（40-100）').default(93),
    overlayPosition: Schema.string().description('浮窗位置策略：auto | fixed | center | top | bottom').default('auto'),
    overlayFadeMs: Schema.natural().description('浮窗淡入/淡出时长（毫秒）').default(140),
    targetCacheMs: Schema.natural().description('按 title 解析窗口的结果缓存时长（毫秒，0=不缓存）').default(1500),
    observeProfile: Schema.string().description('点击复核的取样档位：fast | balanced | thorough').default('balanced'),
    screenshotMaxFiles: Schema.natural().description('截图最多保留几张（0=不清理；只清理本插件生成的 PNG）').default(0),
    screenshotMaxAgeDays: Schema.natural().description('截图最多保留几天（0=不清理）').default(0),
    announceOnLoad: Schema.boolean().description('加载时在日志里打印一行概况').default(false),
  }),
)

const DEFAULTS = {
  enabled: true,
  driverPath: '',
  promptSection: true,
  defaultDelivery: 'background',
  defaultTimeoutMs: 20000,
  stateTimeoutMs: 60000,
  maxElements: 400,
  maxChars: 8000,
  idleShutdownMs: 120000,
  screenshotDir: '~/.dsh/computer-use/shots',
  keyboardOverlay: true,
  keyboardOverlayWindow: true,
  overlayDurationMs: 1400,
  overlayIdleShutdownMs: 60000,
  overlayTheme: 'dark',
  overlayFontSize: 15,
  overlayOpacityPct: 93,
  overlayPosition: 'auto',
  overlayFadeMs: 140,
  targetCacheMs: 1500,
  observeProfile: 'balanced',
  screenshotMaxFiles: 0,
  screenshotMaxAgeDays: 0,
  announceOnLoad: false,
}

/** volatile 字段在插件里读到的是 `{ get() }` 引用，不是裸值 */
function readMaybeVolatile(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'object' && typeof value.get === 'function') {
    try {
      const v = value.get()
      return v === undefined ? fallback : v
    } catch {
      return fallback
    }
  }
  return value
}

/**
 * 布尔字段统一归一化。
 * 无 schema 降级路径下 cordis 会把 patch / 用户值原样透传，字符串 "false" 会被
 * `!== false` 判成「启用」、字符串 "true" 又会被 `=== true` 判成「关闭」—— 两个
 * 字段口径不一致。resolveConfig 与 isEnabled 必须共用同一套判定。
 */
function asBool(value, fallback) {
  const v = readMaybeVolatile(value, fallback)
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  const s = String(v).trim().toLowerCase()
  if (['false', '0', 'no', 'off', 'disabled'].includes(s)) return false
  if (['true', '1', 'yes', 'on', 'enabled'].includes(s)) return true
  return fallback
}

/**
 * 字符串枚举校验：以前写错 `defaultDelivery`（'Front' / 'front' / 空串）会原样
 * 透传给驱动，驱动按未知值处理，用户只看到「点了没反应」，排查时看不出配置错。
 */
function enumValue(value, allowed, fallback, label, logger) {
  const v = String(readMaybeVolatile(value, fallback) ?? '').trim().toLowerCase()
  if (allowed.includes(v)) return v
  if (v && v !== String(fallback)) {
    logger?.warn?.(`${LOG} 配置项 ${label}="${v}" 无效（只允许 ${allowed.join(' / ')}），已回落到 ${fallback}`)
  }
  return fallback
}

/** 数值边界：0 / 负数 / NaN / 超大值都会让驱动行为异常（max_elements:0 直接读成空树） */
function boundedInt(value, fallback, min, max, label, logger) {
  const n = Number(readMaybeVolatile(value, fallback))
  if (!Number.isFinite(n)) return fallback
  const v = Math.min(Math.max(Math.floor(n), min), max)
  if (v !== n) logger?.warn?.(`${LOG} 配置项 ${label}=${n} 超出 [${min}, ${max}]，已收敛为 ${v}`)
  return v
}

/** 导出给冒烟测试直接验证配置归一化（不影响 apply 的行为） */
export function resolveConfig(raw, logger) {
  const c = raw ?? {}
  return {
    enabled: asBool(c.enabled, DEFAULTS.enabled),
    driverPath: String(readMaybeVolatile(c.driverPath, DEFAULTS.driverPath) || ''),
    promptSection: asBool(c.promptSection, DEFAULTS.promptSection),
    defaultDelivery: enumValue(c.defaultDelivery, ['background', 'foreground'], DEFAULTS.defaultDelivery, 'defaultDelivery', logger),
    defaultTimeoutMs: boundedInt(c.defaultTimeoutMs, DEFAULTS.defaultTimeoutMs, 1000, 600000, 'defaultTimeoutMs', logger),
    stateTimeoutMs: boundedInt(c.stateTimeoutMs, DEFAULTS.stateTimeoutMs, 1000, 600000, 'stateTimeoutMs', logger),
    maxElements: boundedInt(c.maxElements, DEFAULTS.maxElements, 1, 5000, 'maxElements', logger),
    maxChars: boundedInt(c.maxChars, DEFAULTS.maxChars, 200, 100000, 'maxChars', logger),
    idleShutdownMs: boundedInt(c.idleShutdownMs, DEFAULTS.idleShutdownMs, 0, 3600000, 'idleShutdownMs', logger),
    screenshotDir: String(readMaybeVolatile(c.screenshotDir, DEFAULTS.screenshotDir) || DEFAULTS.screenshotDir),
    keyboardOverlay: asBool(c.keyboardOverlay, DEFAULTS.keyboardOverlay),
    keyboardOverlayWindow: asBool(c.keyboardOverlayWindow, DEFAULTS.keyboardOverlayWindow),
    overlayDurationMs: boundedInt(c.overlayDurationMs, DEFAULTS.overlayDurationMs, 250, 10000, 'overlayDurationMs', logger),
    overlayIdleShutdownMs: boundedInt(c.overlayIdleShutdownMs, DEFAULTS.overlayIdleShutdownMs, 0, 3600000, 'overlayIdleShutdownMs', logger),
    overlayTheme: enumValue(c.overlayTheme, ['dark', 'light', 'accent'], DEFAULTS.overlayTheme, 'overlayTheme', logger),
    overlayFontSize: boundedInt(c.overlayFontSize, DEFAULTS.overlayFontSize, 10, 32, 'overlayFontSize', logger),
    overlayOpacityPct: boundedInt(c.overlayOpacityPct, DEFAULTS.overlayOpacityPct, 40, 100, 'overlayOpacityPct', logger),
    overlayPosition: enumValue(c.overlayPosition, ['auto', 'fixed', 'center', 'top', 'bottom'], DEFAULTS.overlayPosition, 'overlayPosition', logger),
    overlayFadeMs: boundedInt(c.overlayFadeMs, DEFAULTS.overlayFadeMs, 40, 600, 'overlayFadeMs', logger),
    targetCacheMs: boundedInt(c.targetCacheMs, DEFAULTS.targetCacheMs, 0, 30000, 'targetCacheMs', logger),
    observeProfile: enumValue(c.observeProfile, ['fast', 'balanced', 'thorough'], DEFAULTS.observeProfile, 'observeProfile', logger),
    screenshotMaxFiles: boundedInt(c.screenshotMaxFiles, DEFAULTS.screenshotMaxFiles, 0, 5000, 'screenshotMaxFiles', logger),
    screenshotMaxAgeDays: boundedInt(c.screenshotMaxAgeDays, DEFAULTS.screenshotMaxAgeDays, 0, 365, 'screenshotMaxAgeDays', logger),
    announceOnLoad: asBool(c.announceOnLoad, DEFAULTS.announceOnLoad),
  }
}

function createLogger(ctx) {
  const base = ctx?.logger
  const emit = (level, message, meta) => {
    const fn = base?.[level]
    if (typeof fn === 'function') {
      try {
        fn.call(base, message, meta)
        return
      } catch {
        /* 落到 console */
      }
    }
    // eslint-disable-next-line no-console
    ;(level === 'error' ? console.error : console.log)(message)
  }
  return {
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    debug: () => {},
  }
}

/**
 * 同一进程内的多份副本共享这两个 Symbol：
 *   - 序号保证每个实例有独立的状态文件名（pid 相同也能区分）
 *   - 协调器记录「谁注册了 cu_*」以及等待接管的实例，前一个卸载后把工具交还给后一个
 *
 * 用 globalThis 而不是模块级变量，是因为「宿主的多个副本」往往是两份代码文件，
 * 它们各自的模块作用域互不可见。
 */
const COORDINATOR = Symbol.for('dsh-computer-use-pro#instance-coordinator')
const INSTANCE_SEQ = Symbol.for('dsh-computer-use-pro#instance-seq')

function nextInstanceId() {
  const g = globalThis
  const seq = Number(g[INSTANCE_SEQ] ?? 0) + 1
  g[INSTANCE_SEQ] = seq
  return `${process.pid}-${seq}`
}

function getCoordinator() {
  const g = globalThis
  if (!g[COORDINATOR]) g[COORDINATOR] = { owner: null, waiters: [] }
  return g[COORDINATOR]
}

/** 取 skills 服务：inject 里没声明，直接 ctx.get 更安全（拿不到就算了） */
function getSkills(ctx) {
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get('skills') : undefined
    if (viaGet) return viaGet
  } catch {
    /* 没声明 inject 时直接访问可能抛，忽略 */
  }
  try {
    return ctx?.skills ?? null
  } catch {
    return null
  }
}

export function apply(ctx, rawConfig) {
  const logger = createLogger(ctx)
  const config = resolveConfig(rawConfig, logger)

  // 每次执行都重新读开关：volatile 字段改完立即生效（归一化口径与 resolveConfig 一致）
  const isEnabled = () => asBool(rawConfig?.enabled, DEFAULTS.enabled)

  const found = findDriverExe(config.driverPath, logger)
  const bridge = new DriverBridge({
    exe: found.exe,
    version: found.version,
    searched: found.searched,
    candidates: found.candidates,
    platformNote: found.platformNote,
    timeoutMs: config.defaultTimeoutMs,
    idleShutdownMs: config.idleShutdownMs,
    logger,
  })

  const coordinator = getCoordinator()
  const instance = {
    id: nextInstanceId(),
    pid: process.pid,
    profile: String(process.env.DSH_PROFILE || ''),
    profileDir: String(process.env.DSH_PROFILE_DIR || ''),
  }
  const instanceStatus = createInstanceStatus(instance)

  const notes = []
  const addNote = (text) => {
    if (text && !notes.includes(text)) notes.push(text)
  }

  const status = {
    plugin: name,
    version,
    instance,
    role: 'pending',
    registered: [],
    skillRegistered: false,
    conflict: '',
    note: '',
    toolKit: TOOL_KIT_SOURCE,
    toolKitError: TOOL_KIT_ERROR || null,
    schema: SCHEMA_SOURCE,
    schemaError: SCHEMA_ERROR || null,
    config,
    driver: {
      exe: found.exe, version: found.version, found: found.found, searched: found.searched,
      candidates: found.candidates?.length ?? 0, platformNote: found.platformNote || '',
    },
    instanceCount: 0,
  }

  const toolConfig = {
    ...config,
    driverComponentsRoot: found.searched,
    skillRegistered: false,
  }

  const tools = createTools({
    bridge,
    config: toolConfig,
    logger,
    isEnabled,
    // 交给 tools.js 去取宿主的 attachments / llm 服务：截图要作为 ImageBlock 交付给模型，
    // 只有插件上下文（ctx.get(...)）能拿到那两个服务。
    ctx,
  })

  let role = 'pending'
  let disposed = false
  let toolDisposers = []
  let skillDisposer = null
  let skillsRegistry = null
  let skillsRequested = false
  let promptDisposer = null
  let pollTimer = null
  let promptRetryTimer = null
  let promptAttempts = 0

  const writeStatus = () => {
    if (disposed) return
    status.role = role
    const { instanceCount, ...payload } = status
    payload.note = [...notes, status.conflict ? `另一实例已注册同名工具，本实例降级为待命（${status.conflict}）` : '']
      .filter(Boolean)
      .join('；')
    const result = instanceStatus.write(payload)
    if (!result.ok) logger.warn(`${LOG} 状态文件写入失败（不影响工具）：${result.error}`)
    else status.instanceCount = result.instanceCount
  }

  const waiter = {
    id: instance.id,
    // 存活探针：owner 是否还活着由它自己回答，不用 pid（同进程里 pid 恒等，判不出死活）
    isAlive: () => !disposed,
    promote: () => activate('takeover'),
    /**
     * 工具层被宿主清空、而本实例其实还活着时，让旧 owner 主动让位。
     * 否则后加载实例会在轮询里直接注册成功，出现两个 primary：两份 role=primary、
     * 两个同名 prompt section、旧 owner 的驱动永不回收。
     */
    demote: () => {
      if (disposed || role !== 'primary') return
      role = 'standby'
      status.registered = []
      if (promptRetryTimer) {
        clearTimeout(promptRetryTimer)
        promptRetryTimer = null
      }
      if (typeof promptDisposer === 'function') {
        try {
          promptDisposer()
        } catch {
          /* 让位不能失败 */
        }
      }
      promptDisposer = null
      if (typeof skillDisposer === 'function') {
        try {
          skillDisposer()
        } catch {
          /* 让位不能失败 */
        }
      }
      skillDisposer = null
      rollbackTools()
      if (coordinator.owner?.id === instance.id) coordinator.owner = null
      if (!coordinator.waiters.some((entry) => entry.id === instance.id)) coordinator.waiters.push(waiter)
      writeStatus()
    },
  }

  /** 当前 owner 是否还在服务：owner 已拆/已死即视为让出。 */
  function ownerAlive() {
    const owner = coordinator.owner
    if (!owner) return false
    if (owner.id === instance.id) return !disposed
    if (typeof owner.isAlive === 'function') return Boolean(owner.isAlive())
    // 老版本 waiter 没有存活探针：保守当作存活，交给只读探测兜底
    return true
  }

  function rollbackTools() {
    const pending = toolDisposers
    toolDisposers = []
    for (const dispose of pending) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* 回滚失败不能影响别人 */
      }
    }
  }

  function tryRegisterTools() {
    const registered = []
    const duplicate = []
    const failed = []
    /** 注册一个工具并归类结果；不抛。 */
    function registerOne(def) {
      try {
        const dispose = ctx.tools.register(def)
        if (typeof dispose === 'function') toolDisposers.push(dispose)
        registered.push(def.name)
      } catch (err) {
        // 一个工具定义有问题不该拖垮整个插件（其余工具与技能照常可用）
        const msg = err instanceof Error ? err.message : String(err)
        // dsh-tools 的全局层同名注册会抛：tool "x" is already registered
        if (/already registered|already exists|duplicate|已存在|已注册/i.test(msg)) duplicate.push(`${def.name}（${msg}）`)
        else {
          failed.push(`${def.name}（${msg}）`)
          logger.warn(`${LOG} 工具 ${def.name} 注册失败（不影响其余工具）：${msg}`)
        }
      }
    }
    // 先只注册第一个工具当探针：它若因同名被拒，说明另一实例正持有整套工具，
    // 此时一个都不再注册 —— 避免「注册一半再回滚」把宿主短暂拆成半套工具
    if (tools.length) {
      registerOne(tools[0])
      if (duplicate.length) return { registered, duplicate, failed }
    }
    for (const def of tools.slice(1)) registerOne(def)
    return { registered, duplicate, failed }
  }

  function startStandbyPoll() {
    if (pollTimer || disposed || role !== 'standby') return
    // 老版本实例（不知道协调器）卸载时不会通知我们：用只读探测兜底
    if (typeof ctx.tools?.get !== 'function') return
    pollTimer = setInterval(() => {
      if (disposed || role !== 'standby') {
        stopStandbyPoll()
        return
      }
      // 只做一次只读探测：owner 死活的判定统一交给 activate()，这里不重复判一遍
      let occupied
      try {
        occupied = Boolean(ctx.tools.get('cu_state'))
      } catch {
        return
      }
      if (!occupied) activate('poll')
    }, 250)
    pollTimer.unref?.()
  }

  function stopStandbyPoll() {
    if (!pollTimer) return
    clearInterval(pollTimer)
    pollTimer = null
  }

  function injectPrompt() {
    if (promptDisposer || !config.promptSection) return
    try {
      const sp = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : null
      if (sp && typeof sp.section === 'function') {
        const base = typeof sp.getSectionOrder === 'function' ? sp.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') : 0
        promptDisposer =
          sp.section({
            name: 'computer-use-pro:routing',
            order: (typeof base === 'number' ? base : 0) + 2,
            text: () => [
              `## 桌面控制（cu_* 前缀，dsh-computer-use-pro 插件 · ${tools.length} 个工具）`,
              '',
              '工具清单（由插件实际注册的定义生成）：',
              toolRoster(tools),
              '',
              ...ROUTING_RULES,
            ].join('\n'),
          }) ?? true
      }
    } catch (error) {
      logger.warn(`${LOG} 注入系统提示节失败（不影响工具）：${error instanceof Error ? error.message : error}`)
    }
    if (promptDisposer) {
      promptAttempts = 0
      if (promptRetryTimer) {
        clearTimeout(promptRetryTimer)
        promptRetryTimer = null
      }
      return
    }
    // 失败最常见的原因是接管时旧 primary 的同名 section 还没拆。以前这里直接吞掉、再不重试，
    // 接管后的实例会永久缺这节路由（模型不知道 cu_* 怎么用）。留几次延时重试，全部 unref。
    if (!disposed && role === 'primary' && promptAttempts < 3 && !promptRetryTimer) {
      promptAttempts += 1
      promptRetryTimer = setTimeout(() => {
        promptRetryTimer = null
        if (!disposed && role === 'primary') injectPrompt()
      }, 1000)
      promptRetryTimer.unref?.()
    }
  }

  function finishSkill(registry) {
    if (disposed || !registry || typeof skillDisposer === 'function') return
    try {
      skillDisposer = registerSkill(registry, PLUGIN_ROOT, logger, config.screenshotDir)
      status.skillRegistered = typeof skillDisposer === 'function'
      toolConfig.skillRegistered = status.skillRegistered
      if (!status.skillRegistered) addNote('宿主 skills 服务不可用，技能未注册（工具不受影响）')
      writeStatus()
    } catch (err) {
      logger.warn(`${LOG} 技能注册失败（不影响工具）：${err instanceof Error ? err.message : err}`)
    }
  }

  function ensureSkill() {
    // 技能与工具同进退：待命实例不注册，接管后再补
    if (role !== 'primary' || typeof skillDisposer === 'function') return
    const skills = skillsRegistry ?? getSkills(ctx)
    if (skills) {
      finishSkill(skills)
      return
    }
    if (skillsRequested || typeof ctx.inject !== 'function') return
    skillsRequested = true
    // skills 服务还没就绪时不能瞎猜顺序：等它 ready 再注册，且**不阻塞**工具注册
    try {
      ctx.inject(['skills'], (inner) => {
        skillsRegistry = inner?.skills ?? inner?.get?.('skills') ?? null
        if (role === 'primary' && skillsRegistry) finishSkill(skillsRegistry)
      })
    } catch (err) {
      logger.warn(`${LOG} 等待 skills 服务失败：${err instanceof Error ? err.message : err}`)
    }
  }

  function activate(reason) {
    if (disposed) return false
    if (role === 'primary') return true
    const owner = coordinator.owner
    if (owner && owner.id !== instance.id && !ownerAlive()) {
      // owner 已死/已拆就当场让出：不让「死掉的上一份」把新实例永久压在待命
      coordinator.owner = null
    } else if (owner && owner.id !== instance.id && ownerAlive() && reason === 'poll') {
      // 轮询只看到「cu_state 不见了」，不等于 owner 让位了：可能只是宿主重建了工具层。
      // 直接注册会造出双 primary（两份 role=primary、两个同名 prompt section、
      // 旧 owner 的驱动永不回收）。先请仍存活的 owner 主动降级，再接管。
      if (typeof owner.demote !== 'function') return false // 老版本实例没有让位能力：宁可继续待命
      try {
        owner.demote()
      } catch (err) {
        logger.warn(`${LOG} 旧实例让位失败（本轮不接管）：${err instanceof Error ? err.message : err}`)
        return false
      }
    }
    const result = tryRegisterTools()
    if (result.duplicate.length) {
      // 注册到一半才发现同名：把自己已注册的那部分回滚，避免半个工具集在宿主里
      rollbackTools()
      role = 'standby'
      status.registered = []
      const conflict = `${result.duplicate.length} 个 cu_* 工具已被另一实例注册（首个：${result.duplicate[0]}）`
      const firstTime = status.conflict !== conflict
      status.conflict = conflict
      if (!coordinator.waiters.some((entry) => entry.id === instance.id)) coordinator.waiters.push(waiter)
      if (firstTime) {
        logger.warn(
          `${LOG} 检测到另一个实例已注册 cu_* 工具（本实例 ${instance.id} 降级为待命，不注册工具；前一实例卸载后会自动接管）：${conflict}`,
        )
      }
      startStandbyPoll()
      writeStatus()
      return false
    }
    role = 'primary'
    status.registered = result.registered
    status.conflict = ''
    if (result.failed.length) addNote(`部分工具注册失败：${result.failed.join('；')}`)
    coordinator.owner = waiter
    coordinator.waiters = coordinator.waiters.filter((entry) => entry.id !== instance.id)
    stopStandbyPoll()
    injectPrompt()
    ensureSkill()
    writeStatus()
    if ((reason === 'takeover' || reason === 'poll') && config.announceOnLoad) {
      logger.info(`${LOG} 已接管桌面控制工具（实例 ${instance.id}，${reason === 'poll' ? '轮询自动接管' : 'owner 卸载后接管'}）`)
    }
    return true
  }

  function dispose() {
    if (disposed) return
    disposed = true
    stopStandbyPoll()
    if (promptRetryTimer) {
      clearTimeout(promptRetryTimer)
      promptRetryTimer = null
    }
    coordinator.waiters = coordinator.waiters.filter((entry) => entry.id !== instance.id)
    const wasOwner = coordinator.owner?.id === instance.id
    if (wasOwner) coordinator.owner = null
    if (typeof promptDisposer === 'function') {
      try {
        promptDisposer()
      } catch {
        /* 拆解不能失败 */
      }
    }
    promptDisposer = null
    if (typeof skillDisposer === 'function') {
      try {
        skillDisposer()
      } catch {
        /* 拆解不能失败 */
      }
    }
    skillDisposer = null
    rollbackTools()
    try {
      bridge.stop()
    } catch {
      /* 拆解不能失败 */
    }
    try {
      instanceStatus.remove()
    } catch {
      /* 诊断写不进去不影响卸载 */
    }
    if (wasOwner) {
      // 后开（通常是更新的那份副本）优先接管；失败就由它自己回到待命
      const next = coordinator.waiters.pop()
      if (next) {
        try {
          next.promote()
        } catch (err) {
          logger.warn(`${LOG} 待命实例接管失败：${err instanceof Error ? err.message : err}`)
        }
      }
    }
  }

  if (!found.found) {
    addNote('未找到电脑操控驱动：cu_* 工具会返回可读的错误与修法；装上组件或配 driverPath 后重启即可')
  }

  activate('load')

  if (config.announceOnLoad) {
    if (role === 'primary') {
      logger.info(
        `${LOG} 已加载：驱动${found.found ? ` ${found.version} (${found.exe})` : ' 未找到'} · 工具 ${tools.length} 个 · 技能${status.skillRegistered ? '已注册' : '未注册'} · 实例 ${instance.id}`,
      )
    } else {
      logger.info(`${LOG} 已加载但降级待命（实例 ${instance.id}）：${status.conflict}`)
    }
  }

  ctx.effect?.(() => dispose)

  return dispose
}
