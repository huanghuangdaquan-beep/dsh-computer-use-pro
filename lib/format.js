/**
 * lib/format.js — 把驱动的结构化结果压成模型真正会读的文本
 *
 * 四条原则（0.3.0 起）：
 *   1. **给 token，但不啰嗦**：真正能点的是 `element_token`（`s00000001:11`）。
 *      `token=` 这种前缀在 100 行里凭空吃掉 600 字，所以改成行末裸 token，
 *      头部统一说明一次。
 *   2. **默认只留「有信息量」的元素**：滚动条的三个按钮、状态栏的四段文字、
 *      没标签的容器对定位毫无用处，却占了输出的一半。默认视图 `interactive`
 *      把可点元素 + 输入框 + 它们的祖先链留下，其余折叠（`mode:"full"` 看全量）。
 *   3. **先给诊断字段**：`truncated` / `nodes_pending` / `degraded_reason` 决定
 *      「树是真的空还是被切断了」，比元素本身更重要。`elements_complete`
 *      在本版驱动恒 false，不再显示（它只会让模型以为树没读全）。
 *   4. **给动作建议**：每个异常分支都写清下一步该干嘛（重读 / 换窗口 / 重拉应用）。
 */

/** 能构成「点击目标」的 UIA 动作；只有这些才值得占一行 */
const STRONG_ACTIONS = new Set(['invoke', 'expand', 'toggle', 'select', 'set_value', 'press', 'click', 'open', 'check', 'uncheck'])

/** 输入类角色：即使没有 actions 也要露出来，否则模型没法定位输入框 */
const INPUT_ROLES = new Set(['edit', 'document', 'combobox', 'spinner', 'slider', 'textbox'])

/** 同层同角色连续兄弟超过这个数就折叠（会话列表 / 工具调用记录） */
const MAX_SIBLINGS = 9

/** 纯装饰角色：没有强动作时一律省略 */
const NOISE_ROLES = new Set([
  'scrollbar',
  'statusbar',
  'titlebar',
  'separator',
  'thumb',
  'progressbar',
  'tooltip',
  'text',
  'statictext',
  'image',
  'pane',
  'group',
  'custom',
  'window',
])

/** 这些角色只要有标签就值得留一行（哪怕没有动作，也是可点的语义控件） */
const LABELLED_ROLES = new Set([
  'button',
  'menuitem',
  'treeitem',
  'listitem',
  'tabitem',
  'hyperlink',
  'splitbutton',
  'checkbox',
  'radiobutton',
  'menu',
  'menubar',
  'tree',
  'list',
  'tab',
])

function clip(text, max) {
  const s = String(text ?? '')
  if (!Number.isFinite(max) || max <= 0) return s
  return s.length <= max ? s : `${s.slice(0, max)}…`
}

function num(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function frameText(frame) {
  if (!frame) return ''
  const x = num(frame.x)
  const y = num(frame.y)
  const w = num(frame.w ?? frame.width)
  const h = num(frame.h ?? frame.height)
  if (!w && !h) return ''
  return ` @${x},${y} ${w}x${h}`
}

const roleOf = (e) => String(e?.role ?? '').toLowerCase()
const actsOf = (e) =>
  Array.isArray(e?.actions) ? e.actions.map((a) => String(a).toLowerCase()).filter(Boolean) : []
const hasStrong = (e) => actsOf(e).some((a) => STRONG_ACTIONS.has(a))

/** 这个元素值不值得单独占一行（interactive 视图） */
export function keepElement(e) {
  if (hasStrong(e)) return true
  const role = roleOf(e)
  if (INPUT_ROLES.has(role) && (e.label || e.value)) return true
  if (LABELLED_ROLES.has(role) && e.label) return true
  return false
}

/** 元素行的紧凑渲染：`树缩进 Role "label" [标记] token` */
function elementLine(e, withToken, opts = {}) {
  const depth = Math.min(num(e.depth, 0), opts.maxDepth ?? 12)
  const parts = [`${'  '.repeat(depth)}${e.role ?? '?'}`]
  if (e.label) parts.push(`"${clip(e.label, opts.labelMax ?? 48)}"`)
  if (withToken) {
    const acts = actsOf(e)
    const flags = []
    // 只有「不支持 invoke、只支持 expand」才必须显式传 action，否则驱动会走 invoke 白点一下
    if (!acts.includes('invoke') && acts.includes('expand')) flags.push('▾expand')
    if (acts.includes('set_value')) flags.push('✎输入')
    if (e.enabled === false) flags.push('disabled')
    if (e.selected === true) flags.push('选中')
    if (e.value && INPUT_ROLES.has(roleOf(e))) parts.push(clip(e.value, 40))
    if (flags.length) parts.push(flags.join(' '))
    if (e.element_token) parts.push(String(e.element_token))
  }
  if (opts.showBounds) {
    const f = frameText(e.frame)
    if (f) parts.push(f.trim())
  }
  return parts.join(' ')
}

/** 把 windows[] 排成一行一条 */
export function fmtWindows(sc, opts = {}) {
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 60
  const hideOverlay = opts.hideOverlay !== false
  const raw = Array.isArray(sc?.windows)
    ? sc.windows
    : Array.isArray(sc?._legacy_windows)
      ? sc._legacy_windows.map((w) => ({
          ...w,
          app_name: '',
          bounds: { x: w.x, y: w.y, width: w.width, height: w.height },
        }))
      : []

  const all = raw.map((w) => ({
    pid: w.pid,
    windowId: w.window_id,
    title: w.title ?? '',
    app: w.app_name ?? '',
    onScreen: w.is_on_screen !== false,
    minimized: w.minimized === true,
    bounds: w.bounds ?? null,
    z: w.z_index,
  }))

  const overlay = (w) => /minimax-computer-use\.exe/i.test(w.app) || /^Cua\.AgentCursorOverlay/.test(w.title)
  const rows = hideOverlay ? all.filter((w) => !overlay(w)) : all
  const shown = rows.slice(0, limit)

  const lines = []
  lines.push(`窗口 ${rows.length} 个${hideOverlay && rows.length !== all.length ? `（已隐藏驱动光标覆盖层 ${all.length - rows.length} 个）` : ''}`)
  if (!rows.length) {
    lines.push('（没有可见窗口）')
    return lines.join('\n')
  }
  lines.push('pid\twindow_id\tapp\t标题\t状态\t尺寸')
  for (const w of shown) {
    const b = w.bounds ? `${num(w.bounds.width)}x${num(w.bounds.height)}@${num(w.bounds.x)},${num(w.bounds.y)}` : ''
    const state = [w.onScreen ? '在屏' : 'off', w.minimized ? 'min' : ''].filter(Boolean).join('/')
    lines.push(`${w.pid}\t${w.windowId}\t${clip(w.app, 32)}\t${clip(w.title, 52) || '(无标题)'}\t${state}\t${b}`)
  }
  if (rows.length > shown.length) lines.push(`…还有 ${rows.length - shown.length} 个未显示（用 limit 或 query 收窄）`)
  lines.push('下一步：cu_state 传 pid + windowId（或直接传 title="<标题子串>"，省一次往返）。')
  return lines.join('\n')
}

/** debug_window_info 的输出解读 */
export function fmtWindowInfo(sc) {
  if (!sc) return '（驱动没有返回结构化内容）'
  const wins = Array.isArray(sc.windows) ? sc.windows : []
  const lines = []
  lines.push(`pid ${sc.pid} · ${sc.exe_basename ?? ''} · ${sc.exe_path ?? ''}`)
  lines.push(
    `session=${sc.session_id ?? '?'} daemon=${sc.daemon_pid ?? '?'}/${sc.daemon_session_id ?? '?'} · xaml_routing=${sc.xaml_routing_recommended === true}`,
  )
  if (sc.exe_xaml_match !== undefined) lines.push(`exe_xaml_match=${sc.exe_xaml_match}`)
  if (wins.length) {
    lines.push('顶层窗口：')
    for (const w of wins) {
      lines.push(`  hwnd ${w.hwnd} ${w.class_name ?? '?'} "${clip(w.title, 60)}"${w.xaml_class_match ? ' xaml_class_match' : ''}`)
    }
  } else {
    lines.push('顶层窗口：无（该 pid 没有可见顶层窗口 —— 进程可能在后台或已挂起）')
  }
  const fe = sc.focused_element
  if (fe) {
    lines.push(
      `焦点元素：${fe.class_name ?? '?'} control_type=${fe.control_type_id ?? '?'} name="${clip(fe.name, 60)}" patterns=[${(fe.supported_patterns ?? []).join(',')}]`,
    )
  }

  // 判定建议 —— 这三条是「树为什么是空的」的一手证据
  const hasCore = wins.some((w) => /CoreWindow$/i.test(String(w.class_name ?? '')))
  const hasFrame = wins.some((w) => /ApplicationFrameWindow/i.test(String(w.class_name ?? '')))
  const advice = []
  if (hasCore && !hasFrame) {
    advice.push('class_name 是 Windows.UI.Core.CoreWindow ⇒ **非渲染面**，UIA 树恒空，别在这里找控件。')
    advice.push('真外壳挂在 ApplicationFrameHost.exe 的同名窗口上 —— cu_windows 找那个 pid 再 cu_state。')
  }
  if (sc.xaml_routing_recommended === true) {
    advice.push('驱动建议走 XAML 路由：元素树由 ApplicationFrameWindow 暴露。')
  }
  if (hasFrame) advice.push('已看到 ApplicationFrameWindow ⇒ 真外壳，优先在它上面读树。')
  if (!advice.length) advice.push('不是 CoreWindow、也没有 xaml 建议：按普通 Win32/Electron 处理，树为空优先按「实例陈旧」查（cu_recover）。')
  lines.push('')
  lines.push('判定：')
  for (const a of advice) lines.push(`- ${a}`)
  return lines.join('\n')
}

/**
 * 元素树：带 element_token 的可点版本
 * @param {object} sc get_window_state 的 structuredContent
 * @param {{maxChars?:number, settle?:number[], mode?:'interactive'|'full', showBounds?:boolean, query?:string}} opts
 */
export function fmtState(sc, opts = {}) {
  if (!sc) return '（驱动没有返回结构化内容）'
  const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? opts.maxChars : 8000
  const mode = opts.mode === 'full' ? 'full' : 'interactive'

  const elements = Array.isArray(sc.elements) ? sc.elements : []
  const b = sc.window_bounds
  const lines = []

  lines.push(
    `窗口 "${clip(sc.window_title, 70)}" · ${sc.app_name ?? ''} · pid ${sc.pid} · window_id ${sc.window_id}${b ? ` · ${num(b.width)}x${num(b.height)}@${num(b.x)},${num(b.y)}` : ''}`,
  )
  const counts = [
    `${num(sc.element_count, elements.length)} 元素`,
    `${num(sc.nodes_visited)} 节点`,
    `walk=${num(sc.walk_elapsed_ms)}ms`,
    `truncated=${sc.truncated === true}`,
    `snapshot=${sc.snapshot_id ?? '?'}`,
  ]
  if (opts.query) counts.push(`投影=${elements.length}`)
  if (num(sc.nodes_pending) > 0) counts.push(`pending=${num(sc.nodes_pending)}`)
  lines.push(counts.join(' · '))

  // 懒发布是常态：把「读了几次、元素数怎么涨的」摆出来，避免把首读的小数字当结论
  if (Array.isArray(opts.settle) && opts.settle.length > 1) {
    lines.push(`settle：读了 ${opts.settle.length} 次，元素数 ${opts.settle.join(' → ')}`)
  }

  if (sc.degraded === true) {
    lines.push(`⚠ 语义树降级：${clip(sc.degraded_reason ?? '(未给原因)', 160)}`)
    const esc = sc.escalation
    if (esc) lines.push(`  驱动建议：${esc.recommended ?? '?'} — ${clip(esc.reason, 160)}`)
    if (sc.truncated === true) {
      // 预算/深度截断跟「树是空的」完全是两回事，修法也不同
      lines.push('  这是**预算截断**（不是读不到）：调大 maxElements，或用 query 直接投影到目标控件。')
    } else {
      lines.push('  别猜坐标：① 重读一次（Electron 懒发布）② cu_window_info 看 class_name 换兄弟窗口 ③ cu_recover relaunch:true 重拉。')
    }
  } else if (elements.length === 0 && opts.query) {
    lines.push(`⚠ query「${opts.query}」没命中任何控件（整棵树 ${num(sc.element_count, 0)} 元素）。换个关键词；标签不一定含你想的词，去掉 query 看全量更快。`)
  } else if (elements.length === 0) {
    lines.push('⚠ 0 个元素且未标降级：先重读一次；仍空走 cu_recover（重读→换兄弟窗口→按 AUMID 重拉一次跑完）。')
  } else if (elements.length <= 3 && !opts.query) {
    lines.push(`⚠ 只回来 ${elements.length} 个元素，懒发布可能还没完成：先重读一次再下结论（settle:false 时尤其常见）。`)
  }

  if (sc.truncated === true && sc.degraded !== true) {
    lines.push(`⚠ 树被截断（${sc.truncation_reason ?? '原因未给'}）：目标可能没回来。用 query 收窄，或调大 maxElements。`)
  }

  if (!elements.length) return lines.join('\n')

  /* ------------------------------------------------ 视图：哪些行值得输出 */

  // 驱动给 element_index / parent_index 的类型并不总是同一种（见过 number 与 string
  // 混用）。Map/Set 用原始值当 key 时，"3" 和 3 会被当成两个节点，祖先链整条断掉、
  // 可点元素被误判成结构行。统一成字符串键，跨驱动版本更稳。
  const keyOf = (e) => String(e?.element_index)
  const byIndex = new Map()
  for (const e of elements) byIndex.set(keyOf(e), e)

  const kept = new Set()
  const visible = new Set()
  if (mode === 'full' || opts.query) {
    for (const e of elements) {
      kept.add(keyOf(e))
      visible.add(keyOf(e))
    }
  } else {
    for (const e of elements) {
      if (!keepElement(e)) continue
      kept.add(keyOf(e))
      // 祖先链保留成「结构行」（不带 token）：没有层次的清单读不出层级关系
      let cur = e
      let guard = 0
      while (cur && guard++ < 40) {
        visible.add(keyOf(cur))
        const parent = cur.parent_index === undefined || cur.parent_index === null ? null : byIndex.get(String(cur.parent_index))
        if (!parent) break
        cur = parent
      }
    }
  }

  const rows = elements.filter((e) => visible.has(keyOf(e)))
  const hiddenCount = elements.length - rows.length
  const keptCount = kept.size

  if (!rows.length) {
    lines.push('')
    lines.push(`本窗口没有可操作元素（${elements.length} 个节点都是装饰/纯文本）。要看原始树传 mode:"full"。`)
    return lines.join('\n')
  }

  lines.push(
    `可点 ${keptCount} · 结构 ${rows.length - keptCount} · 省略 ${hiddenCount}${hiddenCount ? '（滚动条/状态栏/无标签容器；mode:"full" 看全部）' : ''}`,
  )
  lines.push('行末的 sNNNNNNNN:NN 就是 element_token，直接传给 cu_click；▾expand 表示该元素只支持展开，要传 action:"expand"。')

  lines.push('')
  const body = []
  let used = 0
  let dropped = 0
  let firstDropped = -1
  let folded = 0

  // 同层同角色超过阈值就折叠：会话列表 / 工具调用记录这类连续兄弟对定位没有增量信息，
  // 但会占掉一半输出。要跳着找用 query（驱动侧投影，不用整棵树）。
  const seq = []
  for (let i = 0; i < rows.length; ) {
    const cur = rows[i]
    const sameKey = (a, b) =>
      kept.has(keyOf(a)) &&
      kept.has(keyOf(b)) &&
      String(a.parent_index) === String(b.parent_index) &&
      roleOf(a) === roleOf(b)
    if (!kept.has(keyOf(cur))) {
      seq.push({ kind: 'el', e: cur })
      i += 1
      continue
    }
    let j = i
    while (j + 1 < rows.length && sameKey(rows[i], rows[j + 1])) j += 1
    const n = j - i + 1
    // query 已经是投影视图、full 是用户明确要全量 —— 这两种情况都不该再折叠
    const limit = mode === 'full' || opts.query ? n : MAX_SIBLINGS
    if (n > limit && limit <= MAX_SIBLINGS) {
      for (let k = i; k < i + limit; k++) seq.push({ kind: 'el', e: rows[k] })
      seq.push({ kind: 'note', depth: Math.min(num(cur.depth, 0), 12), text: `…同层另有 ${n - limit} 个 ${cur.role}（共 ${n} 个），用 query 收窄再读` })
      folded += n - limit
      i = j + 1
    } else {
      for (let k = i; k <= j; k++) seq.push({ kind: 'el', e: rows[k] })
      i = j + 1
    }
  }

  for (let i = 0; i < seq.length; i++) {
    const item = seq[i]
    const line =
      item.kind === 'note' ? `${'  '.repeat(item.depth)}${item.text}` : elementLine(item.e, kept.has(keyOf(item.e)), { showBounds: opts.showBounds === true })
    if (used + line.length + 1 > maxChars) {
      dropped += 1
      if (firstDropped < 0) firstDropped = i
      continue
    }
    used += line.length + 1
    body.push(line)
  }
  lines.push(...body)
  if (folded) lines.push(`（同层折叠 ${folded} 行，省下的预算留给了别的节点）`)
  if (dropped) {
    lines.push(`…还有 ${dropped} 行因输出预算未显示（从第 ${firstDropped} 行起）。用 query 收窄，或调大 maxChars。`)
  }

  lines.push('')
  lines.push(
    `下一步：cu_click({ pid: ${sc.pid}, windowId: ${sc.window_id}, label: "<上面某一行的标签>" }) 走语义点击，它会顺带回一份新快照。`,
  )
  return lines.join('\n')
}

/**
 * 迷你版元素表：只列可点元素（不带头部/尾部）。
 * 给「点击后的复核快照」和「键盘后的复核」用 —— 让模型能直接接着点，不必再发一次 cu_state。
 */
export function fmtStateRows(sc, opts = {}) {
  const elements = Array.isArray(sc?.elements) ? sc.elements : []
  const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? opts.maxChars : 1600
  const rows = []
  let used = 0
  let dropped = 0
  for (const e of elements) {
    if (!keepElement(e)) continue
    const line = elementLine(e, true, {})
    if (used + line.length + 1 > maxChars) {
      dropped += 1
      continue
    }
    used += line.length + 1
    rows.push(line)
  }
  if (dropped) rows.push(`…还有 ${dropped} 个可点元素未列出（cu_state 看全）`)
  if (!rows.length) rows.push('（没有可点元素）')
  return rows
}

/** click 的结果解读：route / delivery / effect 三件套 + 失败码的修法 */
export function fmtClick({ matched, click, after, dryRun }) {
  const lines = []
  if (matched?.error) return matched.error
  if (matched) {
    lines.push(
      `匹配 ${matched.hits} 个 → ${matched.role} "${clip(matched.label, 50)}" token=${matched.token}${matched.enabled === false ? ' disabled' : ''}${(matched.actions ?? []).length ? ` actions=[${matched.actions.join(',')}]` : ''}`,
    )
  }
  if (dryRun) {
    lines.push('（dryRun：只匹配未点击）')
    return lines.join('\n')
  }
  const sc = click?.structured ?? null
  // 驱动有时「报了错但动作其实生效了」（ExpandCollapse 的 0x80040200 就是典型误报），
  // 所以错误码不能当结论 —— 复核结果优先。
  const changed =
    typeof after?.changed === 'boolean'
      ? after.changed
      : after && after.before !== undefined && after.now !== undefined
        ? after.now !== after.before || Boolean(after.newWindow)
        : Boolean(after?.newWindow)
  if (sc && (sc.code || sc.refusal || sc.status)) {
    const code = sc.code ?? sc.refusal ?? sc.status
    // window_minimized 是「驱动明说这次点击落空」，不能因为复核期间有任何变化就翻案说有效
    if (/window_minimized/i.test(`${code} ${click?.text ?? ''}`)) {
      lines.push(`✗ 驱动拒绝这次点击：${code}${click?.text ? ` — ${clip(click.text, 160)}` : ''}`)
      lines.push('  原因不是「元素没通道」，而是**目标窗口被最小化/离屏**（bounds 是图标占位符）：')
      lines.push('  → 这种状态下 foreground / 像素点击一律空点。先 bring_to_front 恢复窗口再点（cu_click 已尝试自动恢复）。')
    } else if (changed) {
      lines.push(`⚠ 驱动回了 ${code}${click?.text ? `（${clip(click.text, 100)}）` : ''}，但复核显示界面确实变了。`)
      lines.push('  → 以复核为准：这次点击**有效**。该驱动在 ExpandCollapse 等动作上有误报，别因为错误码重试。')
    } else {
      // 驱动拒绝执行：直接给码和修法，别让模型对着 route=? 发呆
      lines.push(`✗ 驱动拒绝这次点击：${code}${click?.text ? ` — ${clip(click.text, 160)}` : ''}`)
      lines.push('  tool_invocation_failed/UIA 错误 通常意味着该元素没有可用的 Invoke/Expand 通道：')
      lines.push('  → 菜单项/系统菜单试 cu_key（Alt+首字母 或 方向键+Enter）；其余试 deliveryMode:"foreground" 或像素点击。')
    }
  } else if (sc) {
    lines.push(`点击结果：route=${sc.route ?? '?'} delivery=${sc.delivery?.mode ?? sc.delivery_mode ?? '?'} effect=${sc.effect ?? '?'}`)
    if (sc.effect === 'unverifiable') {
      lines.push(
        after?.focusOnly
          ? 'ℹ effect=unverifiable：驱动没有独立证据，而该元素本身也没有可比对的状态（文本输入类只反映焦点）——「没变化」不能当成失败。'
          : '⚠ effect=unverifiable：驱动没有独立证据，必须靠「界面对比」判定，下面就是对比结果。',
      )
    } else if (sc.effect === 'suspected_noop') {
      lines.push('✗ suspected_noop：几乎确定没生效 —— 换路径（foreground / 键盘 / 像素）。')
    } else if (sc.effect === 'refused') {
      lines.push('✗ refused：驱动主动拒绝 —— 看 error 字段。')
    }
    if (sc.error) lines.push(`error: ${typeof sc.error === 'string' ? sc.error : JSON.stringify(sc.error)}`)
    const ev = Array.isArray(sc.evidence) ? sc.evidence : []
    for (const e of ev) lines.push(`证据 ${e.kind}${e.detail ? `：${clip(e.detail, 120)}` : ''}`)
  } else if (click?.text) {
    lines.push(click.text)
  }

  if (after) {
    const before = after.before
    const now = after.now
    if (before !== undefined && now !== undefined) {
      const delta = now - before
      const bits = [`复核：元素数 ${before} → ${now}（${delta > 0 ? `+${delta}` : delta}）`]
      if (after.targetDiff) bits.push(`目标控件 ${after.targetDiff}`)
      if (after.windowChange) bits.push(`窗口 ${after.windowChange}`)
      lines.push(bits.join(' · '))
      if (changed) {
        lines.push(after.targetDiff ? '目标控件状态变了 —— 这次点击有效（元素数不变不代表没生效）。' : '界面确实变了 —— 下面这份新快照可以直接接着点。')
      } else if (!after.newWindow) {
        lines.push(
          after.focusOnly
            ? 'ℹ 已发送点击；该元素没有可比对的状态可确认（文本输入类只反映焦点），不能据此判定失败。直接 cu_key 输入后用 cu_state 读回值即可确认。'
            : '⚠ 元素数、控件状态、窗口状态都没变：这次点击很可能没生效，别在原路径上重试。',
        )
      }
    }
    if (after.newWindow) {
      lines.push(`新窗口出现：pid ${after.newWindow.pid} / window_id ${after.newWindow.windowId}「${clip(after.newWindow.title, 50)}」${after.newWindow.app ? ` · ${after.newWindow.app}` : ''}`)
      lines.push('→ 这个新窗口是菜单/对话框本体：用 cu_state 读它（很多应用的弹出菜单是独立 HWND，原窗口树里永远看不到）。')
    }
    if (after.note) lines.push(after.note)
    if (after.snapshot) {
      lines.push('')
      lines.push(...after.snapshot)
    }
  }
  return lines.join('\n')
}

/** verify_state 的谓词结果 */
export function fmtVerify(sc) {
  if (!sc) return '（驱动没有返回结构化内容）'
  if (sc.code && sc.detail) return `✗ 谓词被驱动拒绝：${sc.code} — ${sc.detail}`

  const lines = []
  const status = sc.status ?? sc.verdict ?? '?'
  const samples = typeof sc.samples === 'number' && Number.isFinite(sc.samples) ? sc.samples : '?'
  lines.push(`verdict: ${status} · samples=${samples} · stable=${sc.stable === true} · ${num(sc.elapsed_ms)}ms`)

  const list = Array.isArray(sc.predicates) ? sc.predicates : Array.isArray(sc.results) ? sc.results : []
  let sawUntrusted = false
  for (const p of list) {
    const st = p.status ?? p.result ?? '?'
    const bits = [`#${num(p.index)} ${st}`]
    if (p.unknown_reason) {
      bits.push(`reason=${p.unknown_reason}`)
      if (p.unknown_reason === 'untrusted_source') sawUntrusted = true
    }
    if (p.observed_json) bits.push(`observed=${clip(p.observed_json, 120)}`)
    if (p.reason) bits.push(`(${p.reason})`)
    lines.push(`- ${bits.join('  ')}`)
  }
  if (!list.length) lines.push(JSON.stringify(sc, null, 2).slice(0, 3000))

  if (sawUntrusted) {
    lines.push('')
    lines.push('⚠ `untrusted_source`：本驱动版本（0.34.1）对 **element 级谓词**一律回这个，')
    lines.push('   即「没有可信的捕获源」，不是谓词不成立，也不是元素不存在。')
    lines.push('   可靠做法：window 级谓词（window.exists / window.bounds 全字段）＋ cu_state 重读比对标签。')
  } else if (status === 'unknown') {
    lines.push('⚠ unknown **不等于成功**：缺失证据的谓词按未验证处理。')
  }
  return lines.join('\n')
}

/** 原生工具清单（cu_call 的发现面） */
export function fmtTools(tools, query) {
  const q = String(query ?? '').trim().toLowerCase()
  const hits = q
    ? tools.filter((t) => `${t.name} ${t.description ?? ''}`.toLowerCase().includes(q))
    : tools
  const lines = [`原生工具 ${hits.length}/${tools.length} 个${q ? `（过滤：${q}）` : ''}`]
  for (const t of hits) {
    const props = t.inputSchema?.properties ? Object.keys(t.inputSchema.properties) : []
    const required = Array.isArray(t.inputSchema?.required) ? t.inputSchema.required : []
    const desc = clip(String(t.description ?? '').replace(/\s+/g, ' '), 110)
    lines.push(`- ${t.name}(${required.map((r) => `${r}*`).join(',')}${required.length && props.length > required.length ? ',' : ''}${props.filter((p) => !required.includes(p)).join(',')})`)
    if (desc) lines.push(`    ${desc}`)
  }
  if (!hits.length) lines.push('（没有匹配的工具名）')
  lines.push('')
  lines.push('调用：cu_call({ tool: "<名字>", args: {...} })')
  return lines.join('\n')
}

/** list_apps 的清单：文本里必须出现 bundle_id / launch_path，否则没法按 AUMID 拉起 */
export function fmtApps(sc, opts = {}) {
  const apps = Array.isArray(sc?.apps) ? sc.apps : []
  const q = String(opts.query ?? '').trim().toLowerCase()
  const hits = q
    ? apps.filter((a) => `${a.name ?? ''} ${a.bundle_id ?? ''} ${a.launch_path ?? ''} ${a.pid ?? ''}`.toLowerCase().includes(q))
    : apps
  const running = hits.filter((a) => a.running)
  const rest = hits.filter((a) => !a.running)
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 80

  const line = (a) => {
    const bits = [`- ${a.name ?? '(无名)'}`]
    if (a.running && a.pid) bits.push(`pid=${a.pid}`)
    if (a.kind) bits.push(`kind=${a.kind}`)
    if (a.bundle_id) bits.push(`bundle_id=${a.bundle_id}`)
    if (a.launch_path) bits.push(`launch_path=${a.launch_path}`)
    return bits.join(' · ')
  }

  const lines = [`应用 ${hits.length}/${apps.length} 个（运行中 ${running.length}）`]
  for (const a of running.slice(0, limit)) lines.push(line(a))
  const remain = limit - Math.min(running.length, limit)
  if (remain > 0 && rest.length) {
    lines.push(`— 已安装未运行（前 ${Math.min(remain, rest.length)} 个）—`)
    for (const a of rest.slice(0, remain)) lines.push(line(a))
  }
  if (hits.length > limit) lines.push(`…还有 ${hits.length - limit} 个（用 query 收窄）`)
  lines.push('')
  lines.push('拉起包装应用（UWP/MSIX）用 aumid=<bundle_id>!<ApplicationId>；cu_recover 会自动替你解析这一步。')
  return lines.join('\n')
}
