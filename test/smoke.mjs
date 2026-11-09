#!/usr/bin/env node
/**
 * test/smoke.mjs — 不依赖宿主的冒烟测试
 *
 *   node test/smoke.mjs           离线断言 + （驱动存在时）只读实测
 *   node test/smoke.mjs --offline 只跑离线断言
 *
 * 覆盖：驱动发现与生命周期、格式化器、技能载荷契约、13 个 cu_* 工具的定义与主路径、
 * 0.3.x 的点击/复核/截图/光标可视化回归、多实例协调、韧性 kit、探针入口、文档防漂移，
 * 以及（可选）真实驱动的 tools/list 与 list_windows。
 *
 * 断言数随机器环境浮动：装没装驱动、有没有官方 Schemastery/dsh-tools、
 * ROOT 是否在 homedir 内，都会改变个别条件分支的执行条数。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DriverBridge, findDriverExe } from '../lib/driver.js'
import { fmtClick, fmtState, fmtStateRows, fmtTools, fmtVerify, fmtWindowInfo, fmtWindows } from '../lib/format.js'
import { buildSkill, parseFrontmatter, registerSkill } from '../lib/skill.js'
import { createTools, resolveShotPath } from '../lib/tools.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0

function ok(cond, label, extra) {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

function group(title) {
  console.log(`\n== ${title} ==`)
}

/**
 * 顶层 await 抛错会直接崩掉脚本、连「合计」都不打印，CI 上只看到一段堆栈。
 * 这里把未捕获异常计成一项失败并给出完整汇总（不影响正常路径的 process.exit）。
 */
let crashed = false
function onCrash(err) {
  if (crashed) return
  crashed = true
  fail += 1
  const message = err instanceof Error ? err.stack || err.message : String(err)
  console.log(`\n  ✗ 测试脚本异常中断：${message}`)
  console.log(`\n合计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`)
  process.exit(1)
}
process.on('unhandledRejection', onCrash)
process.on('uncaughtException', onCrash)

/* ------------------------------------------------------------- 离线断言 */

group('驱动发现')
const found = findDriverExe('')
ok(typeof found.exe === 'string', 'findDriverExe 返回 exe 字段')
ok(typeof found.searched === 'string' && found.searched.length > 0, '返回扫描根路径')
if (found.found) {
  ok(existsSync(found.exe), '找到的 exe 真实存在')
  ok(/^\d+\.\d+/.test(found.version), `版本号形态正常（${found.version}）`)
} else {
  console.log('  · 本机未装驱动，跳过 exe 存在性断言')
}

group('格式化器')
const winSc = {
  windows: [
    { pid: 1, window_id: 2, title: '设置', app_name: 'SystemSettings.exe', is_on_screen: true, minimized: false, bounds: { x: 0, y: 8, width: 1600, height: 860 } },
    { pid: 3, window_id: 4, title: 'Cua.AgentCursorOverlay.default', app_name: 'minimax-computer-use.exe', is_on_screen: true, bounds: { x: 0, y: 0, width: 1600, height: 900 } },
  ],
}
const winText = fmtWindows(winSc)
ok(winText.includes('SystemSettings.exe'), '窗口表含进程名')
ok(!winText.includes('AgentCursorOverlay'), '默认过滤驱动光标覆盖层')
ok(fmtWindows(winSc, { hideOverlay: false }).includes('AgentCursorOverlay'), 'includeOverlay 时保留覆盖层')

const degraded = fmtState({
  pid: 1,
  window_id: 2,
  window_title: '设置',
  app_name: 'SystemSettings.exe',
  element_count: 0,
  degraded: true,
  degraded_reason: 'ax_tree_empty: ...',
  escalation: { recommended: 'px', reason: 'non-AX surface' },
  elements: [],
})
ok(degraded.includes('降级'), '空树输出带降级告警')
ok(degraded.includes('重读'), '空树输出给出诊断阶梯')
ok(!degraded.includes('点击凭据'), 'degraded 时不输出元素表小节')

const withEls = fmtState({
  pid: 3108,
  window_id: 132326,
  window_title: 'WorkBuddy',
  app_name: 'WorkBuddy.exe',
  element_count: 2,
  total_element_count: 2,
  returned_element_count: 2,
  nodes_visited: 4,
  elements_complete: false,
  truncated: false,
  walk_elapsed_ms: 1,
  snapshot_id: 's00000001',
  window_bounds: { x: 476, y: 111, width: 800, height: 600 },
  elements: [
    { element_index: 0, depth: 0, role: 'Pane', label: 'WorkBuddy', element_token: 's00000001:0', enabled: true, actions: ['invoke'], frame: { x: 476, y: 111, w: 800, h: 600 } },
    { element_index: 1, depth: 1, role: 'Document', label: 'WorkBuddy', element_token: 's00000001:1', enabled: true, actions: ['set_value'] },
  ],
})
ok(withEls.includes('s00000001:0'), '元素行末带 element_token')
ok(withEls.includes('s00000001') && withEls.includes('walk=1ms'), '头部带快照与走查耗时')
ok(withEls.includes('truncated=false'), '头部带截断标志')
ok(withEls.includes('2 个元素'), '元素数偏少时提示重读')

const info = fmtWindowInfo({
  pid: 13232,
  exe_basename: 'systemsettings.exe',
  exe_path: 'C:\\Windows\\ImmersiveControlPanel\\SystemSettings.exe',
  exe_xaml_match: true,
  xaml_routing_recommended: true,
  windows: [{ class_name: 'Windows.UI.Core.CoreWindow', hwnd: 197142, title: '设置' }],
})
ok(info.includes('CoreWindow'), '窗口信息列出 class_name')
ok(info.includes('非渲染面'), '见到 CoreWindow 时给出判定建议')

ok(fmtTools([{ name: 'launch_app', description: 'launch', inputSchema: { properties: { aumid: {}, pid: {} }, required: ['pid'] } }], 'launch').includes('launch_app'), '工具清单可按 query 过滤')
ok(fmtTools([{ name: 'x', description: 'y', inputSchema: {} }], 'zzz').includes('没有匹配'), '无命中时给出提示')

group('视图压缩（0.3.0）')
{
  // 139 元素里有 27 个装饰节点：默认视图只留可点元素，装饰只报计数
  const big = {
    pid: 1,
    window_id: 2,
    window_title: 'big',
    element_count: 40,
    snapshot_id: 's00000001',
    elements: [
      { element_index: 0, depth: 0, role: 'Pane', label: '', element_token: 's00000001:0', actions: [] },
      ...Array.from({ length: 30 }, (_, i) => ({
        element_index: i + 1,
        depth: 1,
        parent_index: 0,
        role: 'TreeItem',
        label: `会话 ${i}`,
        element_token: `s00000001:${i + 1}`,
        actions: ['select', 'expand'],
      })),
      ...Array.from({ length: 9 }, (_, i) => ({
        element_index: 40 + i,
        depth: 2,
        parent_index: 1,
        role: 'Text',
        label: `装饰 ${i}`,
        element_token: `s00000001:${40 + i}`,
        actions: ['text'],
      })),
    ],
  }
  const t = fmtState(big, { maxChars: 8000 })
  ok(t.includes('省略 9'), '纯文本装饰节点被折叠成计数')
  ok(!t.includes('装饰 0'), '装饰节点不出现在清单里')
  ok(t.includes('同层另有'), '同层同角色过多时折叠（会话列表）')
  ok(t.includes('会话 0') && t.includes('会话 8'), '折叠保留前若干个兄弟')
  ok(fmtState(big, { mode: 'full', maxChars: 80000 }).includes('装饰 0'), 'mode:"full" 时全量输出')

  const refused = fmtClick({
    matched: { hits: 1, role: 'MenuItem', label: '编辑(E)', token: 's1:7', actions: ['expand'] },
    click: { structured: { code: 'tool_invocation_failed' }, text: 'ExpandCollapse.Expand failed' },
    after: { before: 11, now: 11, newWindow: null },
  })
  ok(refused.includes('tool_invocation_failed'), '驱动拒绝点击时暴露错误码（不再 route=?）')
  ok(refused.includes('没生效'), '元素数不变且无新窗口时明确判为没生效')

  const newWin = fmtClick({
    matched: { hits: 1, role: 'MenuItem', label: '编辑(E)', token: 's1:7', actions: ['expand'] },
    click: { structured: { route: 'accessibility', effect: 'unverifiable' } },
    after: { before: 11, now: 11, newWindow: { pid: 1, windowId: 2, title: '编辑' } },
  })
  ok(newWin.includes('新窗口出现'), '弹出菜单/对话框时点名新窗口')
  ok(fmtStateRows({ elements: [{ element_index: 0, depth: 0, role: 'Button', label: 'a', element_token: 's1:0', actions: ['invoke'] }] })[0].includes('s1:0'), '迷你快照带 token')
}

group('技能载荷')
const skill = buildSkill(ROOT)
ok(skill !== null, 'buildSkill 有产出')
ok(skill.name === 'computer-use-pro', `name 是 kebab-case（${skill?.name}）`)
ok(skill.description.length > 20, 'description 非空')
ok(typeof skill.source === 'string' && skill.source.length > 0, 'source 是字符串（加载期强校验）')
ok(typeof skill.content === 'string' && skill.content.length > 1000, 'content 是长字符串')
ok(skill.content.includes(path.join(ROOT, 'skills', 'computer-use-pro', 'references')), '正文里的 references 路径已改写成绝对路径')
ok(!/^references\//m.test(skill.content), '没有残留裸相对路径')
const fm = parseFrontmatter('---\nname: a-b\ndescription: hi\n---\nbody')
ok(fm.meta.name === 'a-b' && fm.body === 'body', 'frontmatter 解析正确')

group('技能注册兼容两种宿主契约')
{
  let registered = null
  const stubRegister = { register: (s) => { registered = s; return () => {} } }
  const d1 = registerSkill(stubRegister, ROOT, null)
  ok(typeof d1 === 'function' && registered?.name === 'computer-use-pro', '走 skills.register 分支')

  let provider = null
  const stubProvider = { registerProvider: (create) => { provider = create({ signal: new AbortController().signal, invalidate() {} }); return () => {} } }
  const d2 = registerSkill(stubProvider, ROOT, null)
  ok(typeof d2 === 'function' && provider?.name === 'dsh-computer-use-pro', '走 registerProvider 兜底分支')

  ok(registerSkill(null, ROOT, null) === null, '无 skills 服务时返回 null（不抛）')
}

group('工具定义')
const stubBridge = {
  exe: 'stub',
  version: '0',
  searched: 'stub',
  describe: () => ({ exe: 'stub', version: '0', searched: 'stub', running: false, calls: 0, stderrTail: '' }),
  listTools: async () => [],
  callTool: async () => ({ structured: null, text: '', isError: false }),
}
const tools = createTools({
  bridge: stubBridge,
  config: { defaultDelivery: 'background', defaultTimeoutMs: 1000, stateTimeoutMs: 1000, maxElements: 10, maxChars: 1000, idleShutdownMs: 0, screenshotDir: '~/.dsh/computer-use/shots', driverComponentsRoot: 'stub', skillRegistered: false },
  logger: null,
  isEnabled: () => true,
})
const names = tools.map((t) => t.name)
/** 工具数以后还会变，所有「注册了几套」的断言都用这个派生值，不再写死 */
const TOOL_COUNT = tools.length
ok(
  TOOL_COUNT >= 13 &&
    ['cu_doctor', 'cu_state', 'cu_click', 'cu_key', 'cu_recover', 'cu_cursor', 'cu_scroll', 'cu_drag', 'cu_clipboard'].every((n) => names.includes(n)),
  `${TOOL_COUNT} 个工具，含 0.3.4 新增的覆盖层与便捷动作（${names.join(', ')}）`,
)
for (const t of tools) {
  ok(typeof t.name === 'string' && t.description.length > 20, `${t.name} 有名字与描述`)
  ok(t.parameters?.type === 'object', `${t.name} 参数是 object schema`)
  ok(typeof t.output?.render === 'function', `${t.name} 有 render`)
  ok(typeof t.execute === 'function', `${t.name} 有 execute`)
}
const stateTool = tools.find((t) => t.name === 'cu_state')
ok(JSON.stringify(stateTool.parameters).includes('"windowId"'), 'cu_state 参数含 windowId')
ok(JSON.stringify(stateTool.parameters).includes('"settle"'), 'cu_state 暴露 settle 开关')
ok(names.includes('cu_key') && names.includes('cu_recover'), '键盘与恢复工具已注册')
const clickTool = tools.find((t) => t.name === 'cu_click')
const clickSchema = JSON.stringify(clickTool.parameters)
ok(!JSON.stringify(clickTool.parameters.required || []).includes('label'), 'cu_click 不再强制 label（label 与 x,y 二选一）')
ok(clickSchema.includes('"x"') && clickSchema.includes('"y"'), 'cu_click 支持按截图像素坐标点（x/y）')
ok(clickSchema.includes('"screenshot"'), 'cu_click 暴露点击后截图开关')
ok(JSON.stringify(stateTool.parameters).includes('"screenshot"'), 'cu_state 暴露截图交付开关')

{
  const gateTools = createTools({
    bridge: stubBridge,
    config: { defaultDelivery: 'background', defaultTimeoutMs: 1000, stateTimeoutMs: 1000, maxElements: 10, maxChars: 1000, idleShutdownMs: 0, screenshotDir: '~', driverComponentsRoot: 'stub', skillRegistered: false },
    logger: null,
    isEnabled: () => false,
  })
  const out = await gateTools[0].execute({})
  ok(out.disabled === true && /关闭/.test(out.text), 'enabled=false 时工具拒绝执行')
}

group('cu_key / cu_recover（可编程假驱动）')
{
  const cfg = {
    defaultDelivery: 'background',
    defaultTimeoutMs: 1000,
    stateTimeoutMs: 2000,
    maxElements: 50,
    maxChars: 2000,
    idleShutdownMs: 0,
    screenshotDir: '~',
    driverComponentsRoot: 'stub',
    skillRegistered: false,
  }
  const makeBridge = (handler) => {
    const calls = []
    return {
      calls,
      exe: 'stub',
      version: '0',
      searched: 'stub',
      describe: () => ({ exe: 'stub', version: '0', searched: 'stub', running: false, calls: 0, stderrTail: '' }),
      listTools: async () => [],
      callTool: async (name, params) => {
        calls.push({ name, params })
        return handler(name, params, calls) ?? { structured: null, text: '', isError: false }
      },
    }
  }
  const pick = (bridge, name) => createTools({ bridge, config: cfg, isEnabled: () => true }).find((t) => t.name === name)

  // 1) 单键：默认 foreground
  let b = makeBridge(() => ({ structured: { delivery: { mode: 'foreground' }, effect: 'unverifiable' }, text: '' }))
  let t = pick(b, 'cu_key')
  const r1 = await t.execute({ pid: 1234, key: 'Escape' }, {})
  const c1 = b.calls.at(-1)
  ok(c1.name === 'press_key' && c1.params.key === 'Escape' && c1.params.delivery_mode === 'foreground', '单键走 press_key，默认 foreground')
  ok(/unverifiable/.test(r1.text), '按键结果带「送达≠生效」提醒')

  // 2) 组合键 → hotkey
  await t.execute({ pid: 1234, key: 'Ctrl+Shift+T' }, {})
  const c2 = b.calls.at(-1)
  ok(c2.name === 'hotkey' && Array.isArray(c2.params.keys) && c2.params.keys.length === 3, '组合键走 hotkey 并拆成数组')

  // 3) 文本 → type_text
  await t.execute({ pid: 1234, text: 'hello' }, {})
  const c3 = b.calls.at(-1)
  ok(c3.name === 'type_text' && c3.params.text === 'hello', '文本走 type_text')

  // 4) 显式 background 不被强行改写
  await t.execute({ pid: 1234, key: 'Tab', deliveryMode: 'background' }, {})
  ok(b.calls.at(-1).params.delivery_mode === 'background', '显式 deliveryMode 生效')

  // 5) 缺 pid → 明确报错（这是实测里模型踩过的坑）
  const r5 = await t.execute({ key: 'Enter' }, {})
  ok(r5.ok === false && /pid/.test(r5.error), '缺 pid 明确报错')

  // 6) cu_recover：第一步重读就有树 → 直接返回可用的 pid/windowId
  b = makeBridge((name) => {
    if (name === 'get_window_state') return { structured: { element_count: 50, returned_element_count: 50, elements: [] }, isError: false }
    return { structured: {} }
  })
  t = pick(b, 'cu_recover')
  const r6 = await t.execute({ pid: 7, windowId: 8 }, {})
  ok(r6.recovered !== false && r6.pid === 7 && r6.windowId === 8 && /✅/.test(r6.text), '重读即可用时直接返回 pid/windowId')

  // 7) cu_recover：空树、未开 relaunch → 给 relaunch 指引
  b = makeBridge((name) => {
    if (name === 'get_window_state') return { structured: { element_count: 0, degraded: true, elements: [] } }
    if (name === 'list_windows') {
      return { structured: { windows: [{ pid: 7, window_id: 8, title: '设置', app_name: 'SystemSettings.exe' }] } }
    }
    return { structured: {} }
  })
  t = pick(b, 'cu_recover')
  const r7 = await t.execute({ pid: 7, windowId: 8, title: '设置' }, {})
  ok(r7.recovered === false && /relaunch:true/.test(r7.text), '空树且未重拉时给出下一步指引')

  // 8) cu_recover：空树 + relaunch → 拉起新实例后读到 50 个元素
  let launched = false
  b = makeBridge((name) => {
    if (name === 'get_window_state') {
      return { structured: { element_count: launched ? 50 : 0, returned_element_count: launched ? 50 : 0, degraded: !launched, elements: [] } }
    }
    if (name === 'list_windows') {
      const windows = [{ pid: 7, window_id: 8, title: '设置', app_name: 'SystemSettings.exe' }]
      if (launched) windows.push({ pid: 9, window_id: 10, title: '设置', app_name: 'ApplicationFrameHost.exe' })
      return { structured: { windows } }
    }
    if (name === 'list_apps') {
      return {
        structured: {
          apps: [{ name: '设置', bundle_id: 'windows.immersivecontrolpanel_cw5n1h2txyewy', kind: 'uwp', running: false, launch_path: 'shell:appsFolder\\windows.immersivecontrolpanel_cw5n1h2txyewy!App' }],
        },
      }
    }
    if (name === 'launch_app') {
      launched = true
      return { structured: { pid: 9 }, text: '✅ Launched' }
    }
    return { structured: {} }
  })
  t = pick(b, 'cu_recover')
  const r8 = await t.execute({ pid: 7, windowId: 8, title: '设置', relaunch: true }, {})
  ok(r8.recovered === true && r8.pid === 9 && r8.elements === 50, 'relaunch 后在新实例上恢复（pid 9 / 50 元素）')
  ok(b.calls.some((c) => c.name === 'launch_app' && (c.params.name === '设置' || String(c.params.aumid ?? '').includes('immersive'))), '拉起时用显示名或 AUMID')

  // 9) 按标题 + observe：窗口表只查一次，复核复用同一个 windowId（旧代码查两次，白等一次 RPC）
  b = makeBridge((name) => {
    if (name === 'list_windows') {
      return { structured: { windows: [{ pid: 4321, window_id: 55, title: '记事本', app_name: 'notepad.exe', is_on_screen: true, minimized: false }] } }
    }
    if (name === 'get_window_state') {
      return { structured: { element_count: 2, returned_element_count: 2, elements: [{ role: 'Edit', label: '文本编辑器', element_token: 's1' }] } }
    }
    return { structured: { delivery: { mode: 'foreground' }, effect: 'unverifiable' }, text: '' }
  })
  t = pick(b, 'cu_key')
  const r9 = await t.execute({ title: '记事本', text: 'x', observe: true }, {})
  const lists9 = b.calls.filter((c) => c.name === 'list_windows')
  // 核心契约是「窗口表只查一次」；总 RPC 数随实现增删会变，不再钉死 ===3
  ok(lists9.length === 1 && b.calls.length >= 3, `按标题 + observe 只查一次窗口表（实际 ${b.calls.length} 次 RPC / ${lists9.length} 次 list_windows）`)
  ok(
    b.calls.some((c) => c.name === 'get_window_state' && c.params.pid === 4321 && c.params.window_id === 55),
    'observe 复用按标题解析出的 windowId',
  )
  ok(/复核快照/.test(r9.text), 'observe 仍然输出复核快照')
}

group('cu_state / cu_click（可编程假驱动，0.3.0 行为）')
{
  const cfg = {
    defaultDelivery: 'background',
    defaultTimeoutMs: 1000,
    stateTimeoutMs: 2000,
    maxElements: 50,
    maxChars: 2000,
    idleShutdownMs: 0,
    screenshotDir: '~',
    driverComponentsRoot: 'stub',
    skillRegistered: false,
  }
  const makeBridge = (handler) => {
    const calls = []
    return {
      calls,
      exe: 'stub',
      version: '0',
      searched: 'stub',
      describe: () => ({ exe: 'stub', version: '0', searched: 'stub', running: false, calls: 0, stderrTail: '' }),
      listTools: async () => [],
      callTool: async (name, params) => {
        calls.push({ name, params })
        return handler(name, params, calls) ?? { structured: {}, text: '', isError: false }
      },
    }
  }
  const pick = (bridge, name) => createTools({ bridge, config: cfg, isEnabled: () => true }).find((t) => t.name === name)
  const wins = { structured: { windows: [{ pid: 42, window_id: 77, title: '记事本 - 无标题', app_name: 'notepad.exe' }] } }
  const tree = {
    structured: {
      pid: 42,
      window_id: 77,
      window_title: '记事本',
      element_count: 3,
      snapshot_id: 's00000001',
      elements: [
        { element_index: 0, depth: 0, role: 'MenuItem', label: '编辑(E)', element_token: 's00000001:0', actions: ['expand'] },
        { element_index: 1, depth: 0, role: 'Button', label: '关闭', element_token: 's00000001:1', actions: ['invoke'] },
        { element_index: 2, depth: 0, role: 'Text', label: '状态', element_token: 's00000001:2', actions: ['text'] },
      ],
    },
  }

  // 1) title 直接定位窗口，省掉一次 cu_windows 往返
  let b = makeBridge((n) => (n === 'list_windows' ? wins : n === 'get_window_state' ? tree : { structured: {} }))
  const r1 = await pick(b, 'cu_state').execute({ title: '记事本' }, {})
  const stateCall = b.calls.find((c) => c.name === 'get_window_state')
  ok(stateCall?.params.pid === 42 && stateCall?.params.window_id === 77, 'cu_state 用 title 解析出 pid/windowId')
  ok(r1.text.includes('s00000001:0'), 'cu_state 输出带 token')

  // 2) title 找不到时把候选摆在错误里（模型改一次参数就能中）
  b = makeBridge((n) => (n === 'list_windows' ? wins : null))
  const r2 = await pick(b, 'cu_state').execute({ title: '不存在的窗口' }, {})
  ok(r2.ok === false && r2.error.includes('记事本'), 'title 未命中时列出候选标题')

  // 3) 只支持 expand 的元素：自动传 action=expand，而不是默认 invoke 白点
  b = makeBridge((n, p) => {
    if (n === 'list_windows') return wins
    if (n === 'get_window_state') return tree
    if (n === 'click') return { structured: { route: 'accessibility', effect: 'confirmed' } }
    return null
  })
  const r3 = await pick(b, 'cu_click').execute({ title: '记事本', label: '编辑(E)' }, {})
  const clickCall = b.calls.find((c) => c.name === 'click')
  ok(clickCall?.params.action === 'expand', 'cu_click 对 expand-only 元素自动挑动作')
  ok(/action:"expand"/.test(r3.text), 'cu_click 说明自动挑了 expand')

  // 4) background 没改动界面 → 自动升 foreground 重投，并按复核结果判定生效
  let fgClicked = false
  b = makeBridge((n, p) => {
    if (n === 'list_windows') return wins
    if (n === 'get_window_state') {
      if (!fgClicked) return tree
      return {
        structured: {
          ...tree.structured,
          snapshot_id: 's00000002',
          element_count: 4,
          returned_element_count: 4,
          elements: [
            { element_index: 0, depth: 0, role: 'MenuItem', label: '另存为', element_token: 's00000002:0', actions: ['invoke'] },
            ...tree.structured.elements,
          ],
        },
      }
    }
    if (n === 'click') {
      if (p.delivery_mode === 'foreground') {
        fgClicked = true
        return { structured: { route: 'global_input', effect: 'confirmed' } }
      }
      return { structured: { code: 'background_unavailable' }, text: 'needs foreground', isError: true }
    }
    return null
  })
  const r4 = await pick(b, 'cu_click').execute({ title: '记事本', label: '关闭' }, {})
  const clicks = b.calls.filter((c) => c.name === 'click')
  ok(clicks.length === 2 && clicks[1].params.delivery_mode === 'foreground', 'background 没生效时自动升 foreground 重投')
  ok(/foreground 重投/.test(r4.text), '结果里说明升级过投递方式')
  ok(/3 → 4/.test(r4.text), '升级后按复核结果判定生效')

  // 5) invoke 静默空点（Win11 菜单项同时暴露 invoke+expand）→ 自动改走 expand
  let expanded = false
  const both = {
    structured: {
      ...tree.structured,
      elements: [
        { element_index: 0, depth: 0, role: 'MenuItem', label: '编辑(E)', element_token: 's00000001:0', actions: ['invoke', 'expand'] },
        { element_index: 1, depth: 0, role: 'Button', label: '关闭', element_token: 's00000001:1', actions: ['invoke'] },
        { element_index: 2, depth: 0, role: 'Text', label: '状态', element_token: 's00000001:2', actions: ['text'] },
      ],
    },
  }
  b = makeBridge((n, p) => {
    if (n === 'list_windows') return wins
    if (n === 'get_window_state') {
      return expanded
        ? { structured: { ...both.structured, snapshot_id: 's00000009', element_count: 12, returned_element_count: 12 } }
        : both
    }
    if (n === 'click') {
      if (p.action === 'expand') expanded = true
      return { structured: { route: 'accessibility', effect: 'unverifiable' } }
    }
    return null
  })
  const r5 = await pick(b, 'cu_click').execute({ title: '记事本', label: '编辑(E)', deliveryMode: 'foreground' }, {})
  const actsTried = b.calls.filter((c) => c.name === 'click').map((c) => c.params.action)
  ok(actsTried.includes('expand'), 'invoke 无效时自动改走 expand')
  ok(/action:"expand" 并生效/.test(r5.text), '说明换 expand 才生效')
}

group('cu_click 点不到（0.3.1 真实现场回归）')
{
  const cfg = {
    defaultDelivery: 'background',
    defaultTimeoutMs: 1000,
    stateTimeoutMs: 2000,
    maxElements: 50,
    maxChars: 2000,
    idleShutdownMs: 0,
    screenshotDir: '~',
    driverComponentsRoot: 'stub',
    skillRegistered: false,
  }
  const makeBridge = (handler) => {
    const calls = []
    return {
      calls,
      exe: 'stub',
      version: '0',
      searched: 'stub',
      describe: () => ({ exe: 'stub', version: '0', searched: 'stub', running: false, calls: 0, stderrTail: '' }),
      listTools: async () => [],
      callTool: async (name, params) => {
        calls.push({ name, params })
        return handler(name, params, calls) ?? { structured: {}, text: '', isError: false }
      },
    }
  }
  const pick = (bridge, name) => createTools({ bridge, config: cfg, isEnabled: () => true }).find((t) => t.name === name)
  const liveWin = { structured: { windows: [{ pid: 42, window_id: 77, title: '主页 / X', app_name: 'chrome.exe', is_on_screen: true, minimized: false }] } }

  /* 1) 现场 A：X 的「喜欢」——元素数一动不动，只有按钮标签变（喜欢 → 喜欢了）。
     旧逻辑判「没生效」→ 按阶梯重投一次 → toggle 被点回去，用户看到的就是「点不到」。 */
  let liked = false
  const likeSnap = () => ({
    structured: {
      pid: 42,
      window_id: 77,
      window_title: '主页 / X',
      element_count: 2,
      returned_element_count: 2,
      snapshot_id: liked ? 's00000002' : 's00000001',
      elements: [
        {
          element_index: 0,
          depth: 0,
          role: 'Button',
          label: liked ? '948 喜欢次数。喜欢了' : '945 喜欢次数。喜欢',
          element_token: `${liked ? 's00000002' : 's00000001'}:0`,
          actions: ['invoke'],
          frame: { x: 640, y: 366, w: 36, h: 20 },
        },
        { element_index: 1, depth: 0, role: 'Button', label: '关闭', element_token: `${liked ? 's00000002' : 's00000001'}:1`, actions: ['invoke'], frame: { x: 770, y: 8, w: 30, h: 30 } },
      ],
    },
  })
  let b = makeBridge((n) => {
    if (n === 'list_windows') return liveWin
    if (n === 'get_window_state') return likeSnap()
    if (n === 'click') {
      liked = !liked // 真的点了才会翻状态
      return { structured: { route: 'global_input', delivery: 'foreground', effect: 'unverifiable' } }
    }
    return null
  })
  const rLike = await pick(b, 'cu_click').execute({ pid: 42, windowId: 77, label: '945 喜欢次数。喜欢' }, {})
  const likeClicks = b.calls.filter((c) => c.name === 'click')
  ok(likeClicks.length === 1, '标签变化即算生效：只点 1 次，不再重投把 toggle 点回去')
  ok(/目标控件/.test(rLike.text) && /喜欢了/.test(rLike.text), '复核点名目标控件标签变化（喜欢 → 喜欢了）')
  ok(/元素数不变不代表没生效|这次点击有效/.test(rLike.text), '明确说「元素数不变 ≠ 没生效」')

  /* 2) 现场 B：时间线里一堆同名「转帖」——index 选第几个，并把候选列出来 */
  const dupTree = {
    structured: {
      pid: 42,
      window_id: 77,
      window_title: '主页 / X',
      element_count: 3,
      returned_element_count: 3,
      snapshot_id: 's00000001',
      elements: [
        { element_index: 0, depth: 0, role: 'Button', label: '转帖', element_token: 's00000001:4', actions: ['invoke'], frame: { x: 10, y: 20 } },
        { element_index: 1, depth: 0, role: 'Button', label: '转帖', element_token: 's00000001:5', actions: ['invoke'], frame: { x: 10, y: 120 } },
        { element_index: 2, depth: 0, role: 'Button', label: '转帖', element_token: 's00000001:6', actions: ['invoke'], frame: { x: 10, y: 220 } },
      ],
    },
  }
  b = makeBridge((n) => {
    if (n === 'list_windows') return liveWin
    if (n === 'get_window_state') return dupTree
    return null
  })
  const rIdx = await pick(b, 'cu_click').execute({ pid: 42, windowId: 77, label: '转帖', index: 1, dryRun: true }, {})
  ok(/同名命中 3 个/.test(rIdx.text) && /\[1\]/.test(rIdx.text), '同名命中时列出带序号的候选')
  b = makeBridge((n) => {
    if (n === 'list_windows') return liveWin
    if (n === 'get_window_state') return dupTree
    return null
  })
  const rIdxOk = await pick(b, 'cu_click').execute({ pid: 42, windowId: 77, label: '转帖', index: 1, dryRun: true }, {})
  ok(/\[1\].*← 本次用这个/.test(rIdxOk.text) && !/✗/.test(rIdxOk.text), 'index=1 真的被采纳（候选表标出本次选中项）')
  const rIdxOut = await pick(b, 'cu_click').execute({ pid: 42, windowId: 77, label: '转帖', index: 9 }, {})
  ok(/越界/.test(rIdxOut.text) && /\[0\]/.test(rIdxOut.text), 'index 越界明确报错并回候选')

  /* 3) 现场 C：窗口最小化 —— foreground/像素点击全部静默落空，必须先把窗口恢复 */
  const minWin = { structured: { windows: [{ pid: 42, window_id: 77, title: '主页 / X', app_name: 'chrome.exe', is_on_screen: false, minimized: true, bounds: { x: -31993, y: -32000, width: 146, height: 28 } }] } }
  const shownWin = { structured: { windows: [{ pid: 42, window_id: 77, title: '主页 / X', app_name: 'chrome.exe', is_on_screen: true, minimized: false }] } }
  let restored = false
  let typed = false
  b = makeBridge((n) => {
    if (n === 'list_windows') return restored ? shownWin : minWin
    if (n === 'get_window_state') {
      return {
        structured: {
          pid: 42,
          window_id: 77,
          window_title: '主页 / X',
          element_count: 1,
          returned_element_count: 1,
          snapshot_id: 's00000001',
          elements: [{ element_index: 0, depth: 0, role: 'Button', label: '发布', element_token: 's00000001:0', actions: ['invoke'] }],
        },
      }
    }
    if (n === 'bring_to_front') {
      restored = true
      return { structured: { restored: true, raised: true, landed_on_target: true } }
    }
    if (n === 'click') {
      typed = true
      return { structured: { route: 'accessibility', effect: 'unverifiable' } }
    }
    return null
  })
  const rMin = await pick(b, 'cu_click').execute({ pid: 42, windowId: 77, label: '发布' }, {})
  const names = b.calls.map((c) => c.name)
  ok(names.indexOf('bring_to_front') >= 0 && names.indexOf('bring_to_front') < names.indexOf('click'), '最小化窗口先 bring_to_front 再点')
  ok(/bring_to_front/.test(rMin.text) && /最小化/.test(rMin.text), '输出说明窗口原本最小化、已恢复')
  ok(typed, '恢复后仍照常点击')

  // dryRun 不能抢前台：只看不点，但要把窗口状态说出来
  restored = false
  const oneBtn = {
    structured: {
      pid: 42,
      window_id: 77,
      window_title: '主页 / X',
      element_count: 1,
      returned_element_count: 1,
      snapshot_id: 's00000001',
      elements: [{ element_index: 0, depth: 0, role: 'Button', label: '发布', element_token: 's00000001:0', actions: ['invoke'] }],
    },
  }
  b = makeBridge((n) => (n === 'list_windows' ? minWin : n === 'get_window_state' ? oneBtn : null))
  const rDry = await pick(b, 'cu_click').execute({ pid: 42, windowId: 77, label: '发布', dryRun: true }, {})
  ok(!b.calls.some((c) => c.name === 'bring_to_front'), 'dryRun 不恢复窗口（不抢前台）')
  ok(/最小化/.test(rDry.text), 'dryRun 也提示窗口当前最小化')

  /* 4) 现场 D：驱动回 window_minimized —— 恢复窗口后同一级重投一次 */
  let tries = 0
  let published = false
  restored = false
  b = makeBridge((n) => {
    if (n === 'list_windows') return shownWin
    if (n === 'get_window_state') {
      return {
        structured: {
          pid: 42,
          window_id: 77,
          window_title: '主页 / X',
          element_count: 1,
          returned_element_count: 1,
          snapshot_id: published ? 's00000002' : 's00000001',
          elements: [
            { element_index: 0, depth: 0, role: 'Button', label: published ? '已发布' : '发布', element_token: `${published ? 's00000002' : 's00000001'}:0`, actions: ['invoke'] },
          ],
        },
      }
    }
    if (n === 'bring_to_front') {
      restored = true
      return { structured: { restored: true } }
    }
    if (n === 'click') {
      tries += 1
      if (tries === 1) return { structured: { refusal: 'window_minimized' }, isError: true, text: 'window_minimized: window is iconic' }
      published = true
      return { structured: { route: 'accessibility', effect: 'unverifiable' } }
    }
    return null
  })
  const rRefuse = await pick(b, 'cu_click').execute({ pid: 42, windowId: 77, label: '发布' }, {})
  const refuseClicks = b.calls.filter((c) => c.name === 'click')
  ok(refuseClicks.length === 2, `window_minimized 后恢复窗口并重投一次（实际 ${refuseClicks.length} 次点击）`)
  ok(b.calls.some((c) => c.name === 'bring_to_front'), 'refusal 后调 bring_to_front 恢复窗口')
  ok(/window_minimized/.test(rRefuse.text), '输出保留驱动的 window_minimized 证据')

  /* -------------------------------------------- 0.3.1 回归：截图读 / 入参校验 */

  group('cu_state 截图 / 入参校验（0.3.1 回归）')

  const manyEls = (n, sid = 's1') =>
    Array.from({ length: n }, (_, i) => ({
      element_index: i,
      depth: 0,
      role: 'Button',
      label: `按钮${i}`,
      element_token: `${sid}:${i}`,
      actions: ['invoke'],
    }))
  const snapWith = (n, sid = 's1') => ({
    structured: { pid: 42, window_id: 77, window_title: 'w', element_count: n, returned_element_count: n, snapshot_id: sid, elements: manyEls(n, sid) },
  })
  const shotFile = path.join(ROOT, 'test', 'shot-regression.png')

  {
    let reads = 0
    const b = makeBridge((n) => {
      if (n !== 'get_window_state') return null
      reads += 1
      return snapWith(8)
    })
    const r = await pick(b, 'cu_state').execute({ pid: 42, windowId: 77, screenshotFile: shotFile }, {})
    const stateCalls = b.calls.filter((c) => c.name === 'get_window_state')
    ok(stateCalls.length === 1 && reads === 1, `带截图只走查 1 次（实际 ${stateCalls.length} 次）`)
    ok(stateCalls[0].params.screenshot_out_file === shotFile, '截图参数并入首读（token 与截图同源）')
    ok(r.text.includes('s1:0'), 'token 仍可用')
  }

  {
    let reads = 0
    const b = makeBridge((n) => {
      if (n !== 'get_window_state') return null
      reads += 1
      if (reads === 1) return snapWith(3, 's1')
      return snapWith(0, 's0')
    })
    const r = await pick(b, 'cu_state').execute({ pid: 42, windowId: 77, settleAttempts: 2, screenshotFile: shotFile }, {})
    ok(reads === 3, `空快照补读 1 次（实际 ${reads} 次）`)
    ok(r.text.includes('3 元素'), '保留上一份 3 元素的树，不把 0 当结论')
    ok(/截图那次读没有拿到元素/.test(r.text), '明确告知截图读失败且 token 可能失效')
  }

  {
    const b = makeBridge(() => ({ structured: { status: 'unknown' } }))
    const r = await pick(b, 'cu_verify').execute({ pid: 42, windowId: 77 }, {})
    ok(!b.calls.some((c) => c.name === 'verify_state'), '空 expect 不再发给驱动')
    ok(/空谓词/.test(r.text), '空 expect 本地直接报错')
  }

  {
    const b = makeBridge(() => ({ structured: {}, text: 'ok' }))
    const r = await pick(b, 'cu_call').execute({ tool: 'x', args: '5' }, {})
    ok(!b.calls.some((c) => c.name === 'x'), 'args 非对象不转发')
    ok(/args 必须是 JSON 对象/.test(r.text), 'args 非对象本地报错')
  }

  {
    // 优化 B：title 定位时复用刚取到的窗口表，不再重复 list_windows
    let clicked = false
    const before = {
      structured: {
        pid: 42,
        window_id: 77,
        window_title: '主页 / X',
        element_count: 2,
        returned_element_count: 2,
        snapshot_id: 'b1',
        elements: [
          { element_index: 0, depth: 0, role: 'Button', label: 'Go', element_token: 'b1:0', actions: ['invoke'], frame: { x: 10, y: 10, w: 20, h: 20 } },
          { element_index: 1, depth: 0, role: 'Button', label: 'X', element_token: 'b1:1', actions: ['invoke'] },
        ],
      },
    }
    const after = {
      structured: {
        pid: 42,
        window_id: 77,
        window_title: '主页 / X',
        element_count: 2,
        returned_element_count: 2,
        snapshot_id: 'b2',
        elements: [
          { element_index: 0, depth: 0, role: 'Button', label: '已开始', element_token: 'b2:0', actions: ['invoke'], frame: { x: 10, y: 10, w: 20, h: 20 } },
          { element_index: 1, depth: 0, role: 'Button', label: 'X', element_token: 'b2:1', actions: ['invoke'] },
        ],
      },
    }
    const b = makeBridge((n) => {
      if (n === 'list_windows') return liveWin
      if (n === 'get_window_state') return clicked ? after : before
      if (n === 'click') {
        clicked = true
        return { structured: { route: 'accessibility', effect: 'confirmed' } }
      }
      return null
    })
    const r = await pick(b, 'cu_click').execute({ title: '主页 / X', label: 'Go', deliveryMode: 'foreground' }, {})
    const lists = b.calls.filter((c) => c.name === 'list_windows').length
    // 5 → 7：+1 set_agent_cursor_motion（把默认 1430ms 滑动改成本 session 的 120ms 直移，只做一次）
    //        +1 move_cursor（把 agent 覆盖层挪到目标控件，给真机用户看）；
    // 点击后的确认截图并进复核读取，不额外多 RPC（screenshot:false 连图都不写）
    // 允许实现增删 RPC（光标 / 复核采样），只钉死「窗口表恰好 2 次」这个语义契约
    ok(b.calls.length >= 5 && b.calls.length <= 10 && lists === 2, `title 定位点击 RPC 数合理且窗口表恰好 2 次（实际 ${b.calls.length}/${lists}）`)
    ok(/目标控件/.test(r.text), 'title 路径仍能点中并复核')
  }
}

ok(path.isAbsolute(resolveShotPath('shot.png', { screenshotDir: '~/.dsh/computer-use/shots' })), '相对路径落到绝对目录')
ok(resolveShotPath('/tmp/x.png', { screenshotDir: '~' }).includes('x.png'), '绝对路径原样保留')

/* ------------------------------------- 0.3.1 回归：配置路径 / 恢复 / 格式化 */

group('配置路径 / 恢复 / 格式化（0.3.1 回归）')
{
  ok(fmtVerify({ status: 'pass', samples: 0, stable: true, elapsed_ms: 3 }).includes('samples=0'), 'samples=0 显示为 0，不再显示 ?')

  const pkg = path.join(ROOT, 'package.json')
  const rel = path.relative(homedir(), pkg)
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    const found = findDriverExe(`~/${rel.split(path.sep).join('/')}`)
    ok(
      found.found && found.version === 'custom' && path.resolve(found.exe) === path.resolve(pkg),
      `driverPath 里的 ~/... 会被展开（实际 ${found.version || found.searched}）`,
    )
  }

  // cu_recover 按标题：最小化窗口在 on_screen_only 表里缺席，但不能判成「没找到」
  const els12 = Array.from({ length: 12 }, (_, i) => ({
    element_index: i,
    depth: 0,
    role: 'Button',
    label: `B${i}`,
    element_token: `s1:${i}`,
    actions: ['invoke'],
  }))
  const localCfg = {
    defaultDelivery: 'background',
    defaultTimeoutMs: 1000,
    stateTimeoutMs: 2000,
    maxElements: 50,
    maxChars: 2000,
    idleShutdownMs: 0,
    screenshotDir: '~',
    driverComponentsRoot: 'stub',
    skillRegistered: true,
  }
  const calls = []
  const bridge = {
    calls,
    exe: 'stub',
    version: '0',
    searched: 'stub',
    describe: () => ({}),
    listTools: async () => [],
    callTool: async (name, params) => {
      calls.push({ name, params })
      if (name === 'list_windows') {
        return params.on_screen_only
          ? { structured: { windows: [] }, text: '', isError: false }
          : {
              structured: { windows: [{ pid: 42, window_id: 77, title: 'notepad', minimized: true, is_on_screen: false, app_name: 'notepad.exe' }] },
              text: '',
              isError: false,
            }
      }
      if (name === 'get_window_state') {
        return {
          structured: { pid: 42, window_id: 77, window_title: 'notepad', element_count: 12, returned_element_count: 12, snapshot_id: 's1', elements: els12 },
          text: '',
          isError: false,
        }
      }
      return { structured: {}, text: '', isError: false }
    },
  }
  const rRecover = await createTools({ bridge, config: localCfg, isEnabled: () => true })
    .find((t) => t.name === 'cu_recover')
    .execute({ title: 'notepad' }, {})
  ok(!/没找到标题/.test(rRecover.text) && /✅ 可用/.test(rRecover.text), '最小化窗口不会被误判为不存在')
  ok(calls.some((c) => c.name === 'list_windows' && c.params.on_screen_only === false), '按标题恢复时查全量窗口表')
}

/* --------------------------------------------- 驱动桥：会话生命周期（假子进程） */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const reply = (proc, msg, result) => proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`)

function makeFakeProc() {
  const em = new EventEmitter()
  const proc = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    exitCode: null,
    writes: [],
    handle: null,
    kill() {
      proc.exitCode = 0
    },
    on(event, fn) {
      em.on(event, fn)
      return proc
    },
    emit(event, ...args) {
      return em.emit(event, ...args)
    },
  }
  // 假 stdin：记录请求并交给脚本应答
  proc.stdin.write = (buf) => {
    let msg
    try {
      msg = JSON.parse(String(buf))
    } catch {
      return true
    }
    proc.writes.push(msg)
    proc.handle?.(msg)
    return true
  }
  return proc
}

function makeFakeSpawn(onSpawn) {
  const procs = []
  const spawnImpl = () => {
    const proc = makeFakeProc()
    onSpawn?.(proc, procs.length)
    procs.push(proc)
    return proc
  }
  return { procs, spawnImpl }
}

group('驱动桥生命周期（假子进程）')
{
  // 驱动桥的请求超时器是 unref 的，测试里需要自己撑住事件循环
  const keepAlive = setInterval(() => {}, 500)
  const { procs, spawnImpl } = makeFakeSpawn((proc) => {
    proc.handle = (msg) => {
      if (msg.method === 'initialize') return reply(proc, msg, { protocolVersion: '2024-11-05', capabilities: {} })
      if (msg.method === 'tools/list') return reply(proc, msg, { tools: [] })
      if (msg.method === 'tools/call') {
        const name = msg.params?.name
        if (name === 'hang') return // 永不回包，逼出超时
        const delay = name === 'slow' ? 140 : 0
        setTimeout(() => {
          reply(proc, msg, { content: [{ type: 'text', text: `ok:${name}` }], structuredContent: { ok: true } })
        }, delay)
        return
      }
      return null
    }
  })

  const bridge = new DriverBridge({
    exe: path.join(ROOT, 'package.json'), // 只需 existsSync 通过，不会被真的启动
    timeoutMs: 400,
    idleShutdownMs: 0,
    spawnImpl,
  })

  const timeoutErr = await bridge.callTool('hang', {}, 300).then(
    () => null,
    (err) => err,
  )
  ok(timeoutErr?.code === 'TIMEOUT', `超时归类为 TIMEOUT（实际 ${timeoutErr?.code}）`)
  ok(procs.length === 1, '超时后旧子进程被弃用')

  const pending = bridge.callTool('slow', {})
  await sleep(10)
  ok(procs.length === 2, `重启 spawn 了第 2 个子进程（实际 ${procs.length}）`)

  // 旧会话的三类迟到事件：exit / stdin error / stdout 数据
  procs[0].emit('exit', 1, null)
  let stdinErrorSurvived = true
  try {
    procs[0].stdin.emit('error', Object.assign(new Error('EOF'), { code: 'EOF' }))
  } catch {
    stdinErrorSurvived = false
  }
  const slowId = procs[1].writes.find((m) => m.params?.name === 'slow')?.id
  if (slowId !== undefined) reply(procs[0], { id: slowId }, { content: [{ type: 'text', text: 'stale' }], structuredContent: { ok: false } })

  const res = await pending.then(
    (r) => r,
    (err) => err,
  )
  ok(stdinErrorSurvived, 'stdin 异步 error 不会抛成 uncaughtException')
  ok(res?.structured?.ok === true, `旧会话 exit/data 不污染新会话在途请求（实际 ${res?.code ?? 'ok'}）`)
  ok(bridge.proc === procs[1], '当前会话仍是第 2 个子进程')

  bridge.stop()
  ok(bridge.proc === null && bridge.ready === null, 'stop 清空 proc 与 ready')
  clearInterval(keepAlive)
}

/* ------------------------------------------------------- 多实例（离线） */

group('多实例：同宿主重复启用')
{
  const { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync: exists } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { apply } = await import('../lib/index.js')
  const home = mkdtempSync(path.join(tmpdir(), 'cu-multi-'))
  const prevHome = process.env.USERPROFILE
  process.env.USERPROFILE = home
  try {
    const registry = new Map()
    const sectionNames = new Map()
    // 宿主里工具条数的变化轨迹：用来断言冲突实例不会把宿主拆成「半套工具」
    const sizes = []
    // 模拟 dsh-tools：全局层同名工具直接抛错（真实报错文本见 dsh-tools/lib/types/index.js）
    const makeCtx = (warns) => ({
      logger: { info() {}, warn: (m) => warns.push(m), error() {} },
      tools: {
        register(def) {
          if (registry.has(def.name)) throw new Error(`tool "${def.name}" is already registered`)
          registry.set(def.name, def)
          sizes.push(registry.size)
          return () => {
            if (registry.get(def.name) === def) {
              registry.delete(def.name)
              sizes.push(registry.size)
            }
          }
        },
        get(name) {
          return registry.get(name)
        },
      },
      get(id) {
        if (id === 'skills') return { register: () => () => {} }
        if (id === 'systemPrompt') {
          return {
            section: (s) => {
              if (sectionNames.has(s.name)) throw new Error(`prompt section "${s.name}" already exists`)
              sectionNames.set(s.name, 1)
              return () => sectionNames.delete(s.name)
            },
            getSectionOrder: () => 0,
          }
        }
        return null
      },
      effect(fn) {
        return fn()
      },
    })

    const cfg = { driverPath: path.join(ROOT, 'package.json'), promptSection: true, announceOnLoad: false }
    const warnsA = []
    const warnsB = []
    const disposeA = apply(makeCtx(warnsA), cfg)
    ok(registry.size === TOOL_COUNT, `实例 A 注册 ${TOOL_COUNT} 个 cu_* 工具（实际 ${registry.size}）`)

    const markBeforeB = sizes.length
    const disposeB = apply(makeCtx(warnsB), cfg)
    ok(registry.size === TOOL_COUNT, `实例 B 不抢注册：宿主里仍是一套 ${TOOL_COUNT} 个工具（实际 ${registry.size}）`)
    ok(
      sizes.slice(markBeforeB).every((n) => n >= TOOL_COUNT),
      `冲突实例不会把宿主拆成半套工具（B 期间工具数轨迹 ${sizes.slice(markBeforeB).join(',') || '无变化'}）`,
    )
    ok(warnsB.some((m) => m.includes('降级为待命')), '实例 B 留下可见的冲突告警（不是静默失败）')

    const statusFile = path.join(home, '.dsh', 'computer-use-pro-status.json')
    const agg = JSON.parse(readFileSync(statusFile, 'utf8'))
    ok(agg.instanceCount === 2, `状态聚合看到 2 个实例（实际 ${agg.instanceCount}）`)
    const instancesDir = path.join(home, '.dsh', 'computer-use-pro-status', 'instances')
    ok(readdirSync(instancesDir).length === 2, '每个实例状态各占一份文件，互不覆盖')
    const roles = agg.instances.map((i) => i.role).sort()
    ok(roles[0] === 'primary' && roles[1] === 'standby', `状态里区分 primary / standby（实际 ${roles.join('/')}）`)

    // owner 的 ctx 被宿主直接拆掉（工具没了，但既没走 dispose、也没人调 promote）：
    // 待命实例必须靠存活探测自己接管，不能永久 0 工具
    registry.clear()
    await sleep(700)
    ok(registry.size === TOOL_COUNT, `owner 失联后待命实例在轮询内自动接管（实际 ${registry.size} 个工具）`)
    const aggTakeover = JSON.parse(readFileSync(statusFile, 'utf8'))
    const alivePrimary = aggTakeover.instances.filter((i) => i.alive && i.role === 'primary').map((i) => i.instance?.id)
    ok(alivePrimary.length === 1, `轮询接管后只剩一个存活 primary（实际 ${alivePrimary.length} 个）`)
    ok(
      aggTakeover.owners.length > 0 && aggTakeover.owners.every((o) => alivePrimary.includes(o.id)),
      `聚合的 owners 只列存活 primary（owners=${JSON.stringify(aggTakeover.owners)}）`,
    )

    disposeA()
    ok(registry.size === TOOL_COUNT, `前一个实例卸载后，待命实例自动接管（实际 ${registry.size} 个工具）`)
    const agg2 = JSON.parse(readFileSync(statusFile, 'utf8'))
    ok(agg2.instanceCount === 1 && agg2.instances[0].role === 'primary', '卸载后只剩一个 primary 实例')

    disposeB()
    ok(registry.size === 0, '最后一个实例卸载后工具清空')
    ok(!exists(statusFile), '最后一个实例卸载后聚合状态文件被清理')

    // 死实例不得继续冒充 primary（否则「看起来有一整套工具」永远是假象）
    const { createInstanceStatus } = await import('../lib/status.js')
    const { writeFileSync } = await import('node:fs')
    const dshDir = path.join(home, '.dsh')
    const probe = createInstanceStatus({ id: 'probe-1', pid: process.pid }, dshDir)
    probe.write({ plugin: 'dsh-computer-use-pro', role: 'primary', registered: [] })
    writeFileSync(
      path.join(dshDir, 'computer-use-pro-status', 'instances', 'dead-1.json'),
      `${JSON.stringify({ plugin: 'dsh-computer-use-pro', role: 'primary', registered: ['cu_doctor'], instance: { id: 'dead-1', pid: 999999 }, generatedAt: new Date().toISOString() })}\n`,
      'utf8',
    )
    probe.write({ plugin: 'dsh-computer-use-pro', role: 'primary', registered: [] })
    const aggDead = JSON.parse(readFileSync(statusFile, 'utf8'))
    const dead = aggDead.instances.find((i) => i.instance?.id === 'dead-1')
    ok(dead?.role === 'stale', `已退出实例的 primary 降级为 stale（实际 ${dead?.role}）`)
    ok(aggDead.owners.length === 1 && aggDead.owners[0].id === 'probe-1', `owners 不包含死实例（实际 ${JSON.stringify(aggDead.owners)}）`)
    probe.remove()
  } finally {
    process.env.USERPROFILE = prevHome
    rmSync(home, { recursive: true, force: true })
  }
}

group('多实例：跨进程状态文件')
{
  const { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { spawn } = await import('node:child_process')
  const { pathToFileURL } = await import('node:url')
  const { createInstanceStatus } = await import('../lib/status.js')
  const home = mkdtempSync(path.join(tmpdir(), 'cu-proc-'))
  try {
    const statusUrl = pathToFileURL(path.join(ROOT, 'lib', 'status.js')).href
    const script = path.join(home, 'writer.mjs')
    writeFileSync(
      script,
      [
        `import { createInstanceStatus } from ${JSON.stringify(statusUrl)}`,
        `const writer = createInstanceStatus({ id: process.argv[2], pid: process.pid }, process.argv[3])`,
        `for (let tick = 0; tick < 30; tick++) {`,
        `  const result = writer.write({ plugin: 'dsh-computer-use-pro', role: 'primary', registered: Array.from({ length: ${TOOL_COUNT} }, (_, n) => 'cu_' + n), tick })`,
        `  if (!result.ok) { console.error(result.error); process.exit(1) }`,
        `}`,
      ].join('\n'),
      'utf8',
    )
    const dshDir = path.join(home, '.dsh')
    const run = (id) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [script, id, dshDir], { stdio: 'ignore' })
        child.on('exit', (code) => resolve(code))
      })
    const [codeA, codeB] = await Promise.all([run('proc-a'), run('proc-b')])
    ok(codeA === 0 && codeB === 0, '两个进程并发写状态均成功')
    const instancesDir = path.join(home, '.dsh', 'computer-use-pro-status', 'instances')
    const files = readdirSync(instancesDir).sort()
    ok(files.length === 2, `两个实例各自留下状态文件（实际 ${files.length} 个）`)
    const entries = files.map((f) => JSON.parse(readFileSync(path.join(instancesDir, f), 'utf8')))
    ok(entries.every((e) => e.registered.length === TOOL_COUNT && e.tick === 29), '各自的 30 次写入没有被对方覆盖')
    const legacy = JSON.parse(readFileSync(path.join(home, '.dsh', 'computer-use-pro-status.json'), 'utf8'))
    ok(Array.isArray(legacy.instances), '旧路径聚合视图是合法 JSON（并发写没写坏）')
    // 再写一次让聚合视图重扫目录：两个（已退出）实例都应被列出
    const probe = createInstanceStatus({ id: 'probe', pid: process.pid }, dshDir)
    const probeResult = probe.write({ plugin: 'dsh-computer-use-pro', role: 'primary', registered: [] })
    ok(probeResult.ok && probeResult.instanceCount === 3, `聚合视图能同时看到 3 个实例（实际 ${probeResult.instanceCount}）`)
    probe.remove()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/* --------------------------------------------------------------- 实测 */

group('cu_click 无状态可比对元素（文本输入类）')
{
  const cfg = {
    defaultDelivery: 'background',
    defaultTimeoutMs: 1000,
    stateTimeoutMs: 2000,
    maxElements: 50,
    maxChars: 2000,
    idleShutdownMs: 0,
    screenshotDir: '~',
    driverComponentsRoot: 'stub',
    skillRegistered: false,
  }
  const win = {
    structured: { windows: [{ pid: 42, window_id: 77, title: '无标题 - 记事本', app_name: 'notepad.exe', is_on_screen: true, minimized: false }] },
  }
  const treeOf = (role, label, actions, extra = {}) => ({
    structured: {
      pid: 42,
      window_id: 77,
      window_title: '无标题 - 记事本',
      element_count: 2,
      returned_element_count: 2,
      snapshot_id: 's1',
      elements: [
        { element_index: 0, depth: 0, role, label, element_token: 's1:0', actions, frame: { x: 10, y: 40, w: 700, h: 500 }, ...extra },
        { element_index: 1, depth: 0, role: 'MenuBar', label: '应用程序', element_token: 's1:1', actions: [], frame: { x: 0, y: 0, w: 800, h: 30 } },
      ],
    },
  })
  const run = async (tree, label) => {
    const stats = { clicks: 0, states: 0 }
    const calls = []
    const b = {
      calls,
      describe: () => ({ exe: 'stub', version: '0', searched: 'stub', running: false, calls: 0, stderrTail: '' }),
      listTools: async () => [],
      callTool: async (name, params) => {
        calls.push({ name, params })
        if (name === 'list_windows') return win
        if (name === 'get_window_state') {
          stats.states += 1
          return tree
        }
        if (name === 'click') {
          stats.clicks += 1
          return { structured: { route: 'global_input', delivery: 'foreground', effect: 'unverifiable' }, text: '', isError: false }
        }
        return { structured: {}, text: '', isError: false }
      },
    }
    const tool = createTools({ bridge: b, config: cfg, isEnabled: () => true }).find((t) => t.name === 'cu_click')
    const r = await tool.execute({ pid: 42, windowId: 77, label }, {})
    return { text: r.text, ...stats }
  }

  /* 文本输入类：点一下只是聚焦，界面必然不变 —— 不能说「很可能没生效」 */
  const edit = await run(treeOf('Edit', '文本编辑器', ['set_value', 'scroll']), '文本编辑器')
  ok(/没有可比对的状态/.test(edit.text), '如实说明「该元素没有可比对的状态可确认」')
  ok(/不能据此判定失败/.test(edit.text), '不把「没变化」当成失败')
  ok(!/别在原路径上重试|很可能没生效/.test(edit.text), '不再出现「很可能没生效 / 别在原路径重试」')
  ok(edit.clicks === 1, `文本输入类不做升级重投（click ${edit.clicks} 次）`)
  // 首读 + 复核 1 次（确认截图并进复核读取，不再额外多读一轮）
  ok(edit.states === 2, `文本输入类 settle 只取一次样（读树 ${edit.states} 次 = 首读 + 复核）`)

  /* 可验证控件（Button/invoke）：没变就是真没变，仍按原口径升级重投 */
  const button = await run(treeOf('Button', '发布', ['invoke']), '发布')
  ok(/很可能没生效/.test(button.text) && /别在原路径上重试/.test(button.text), '可验证控件保留原口径（没变＝很可能没生效）')
  ok(button.clicks === 2, `可验证控件仍按阶梯升级重投（click ${button.clicks} 次）`)
  ok(button.states >= edit.states * 2, `可验证控件仍多轮 settle（读树 ${button.states} 次 vs 文本输入类 ${edit.states} 次）`)
}

/* ------------------------------------- 截图交付（图片通道）与像素点击 */

group('截图交付 / 像素点击（可编程假驱动 + 假 attachments/llm）')
{
  const { deflateSync } = await import('node:zlib')
  const { readFileSync, writeFileSync, mkdtempSync } = await import('node:fs')
  const os = await import('node:os')

  // 3x3 的 RGBA PNG：只给插件自己解码/量尺寸用（本测试不校验 CRC）
  const tinyPng = () => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const chunk = (type, data) => {
      const head = Buffer.alloc(8)
      head.writeUInt32BE(data.length, 0)
      head.write(type, 4, 'ascii')
      return Buffer.concat([head, data, Buffer.alloc(4)])
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(3, 0)
    ihdr.writeUInt32BE(3, 4)
    ihdr[8] = 8
    ihdr[9] = 6
    const raw = Buffer.alloc((3 * 4 + 1) * 3)
    return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  }
  const png = tinyPng()
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cu-shot-'))

  const makeVfsBridge = () => {
    const calls = []
    return {
      calls,
      exe: 'stub',
      version: '0',
      searched: 'stub',
      describe: () => ({ exe: 'stub', version: '0', searched: 'stub', running: false, calls: 0, stderrTail: '' }),
      listTools: async () => [],
      callTool: async (name, params) => {
        calls.push({ name, params })
        if (name === 'list_windows') {
          return { structured: { windows: [{ pid: 42, window_id: 77, title: 'W', minimized: false, is_on_screen: true, bounds: { x: 0, y: 0, width: 100, height: 100 } }] }, text: '' }
        }
        if (name === 'get_window_state') {
          if (params?.screenshot_out_file) writeFileSync(params.screenshot_out_file, png)
          return {
            structured: {
              pid: 42,
              window_id: 77,
              window_bounds: { x: 0, y: 0, width: 100, height: 100 },
              screenshot_width: 98,
              screenshot_height: 98,
              capture_id: 'cap-1',
              element_count: 1,
              elements: [{ element_index: 0, role: 'Button', label: 'Go', element_token: 'cap-1:0', actions: ['invoke'], frame: { x: 0, y: 0, w: 60, h: 60 } }],
            },
            text: '',
          }
        }
        if (name === 'click') return { structured: { route: 'global_input', effect: 'confirmed', x: params.x, y: params.y }, text: '' }
        return { structured: {}, text: '' }
      },
    }
  }

  const makeCtx = (modalities) => {
    const saved = []
    return {
      saved,
      get(name) {
        if (name === 'attachments') {
          return {
            imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 5_000_000, maxMessageImageBytes: 10_000_000 },
            saveImage: async (input) => {
              saved.push(input)
              return { attachmentId: 'att-1', mediaType: 'image/png', bytes: input.data.length, width: 3, height: 3, name: input.name }
            },
          }
        }
        if (name === 'llm') return { resolveModelInfo: async () => ({ inputModalities: modalities }) }
        return null
      },
    }
  }
  const exec = { agent: { session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } } }
  const cfg = { defaultDelivery: 'background', defaultTimeoutMs: 1000, stateTimeoutMs: 1000, maxElements: 10, maxChars: 1000, idleShutdownMs: 0, screenshotDir: dir, driverComponentsRoot: 'stub', skillRegistered: false }

  // 1) cu_state screenshot:true：图片真的进 render 的 image block
  {
    const ctx = makeCtx(['text', 'image'])
    const tool = createTools({ bridge: makeVfsBridge(), config: cfg, isEnabled: () => true, ctx }).find((t) => t.name === 'cu_state')
    const r = await tool.execute({ pid: 42, windowId: 77, screenshot: true, settle: false }, exec)
    ok(r.images?.length === 1 && r.images[0].attachmentId === 'att-1', 'cu_state 截图换成 ImageBlock 引用')
    const blocks = tool.output.render({}, r)
    ok(blocks.some((x) => x.type === 'image' && x.attachment?.attachmentId === 'att-1'), 'render 把截图作为 image content block 交给模型')
    ok(/图片已随本结果一起返回/.test(r.text), '文本里说明图片已交付（不是只给路径）')
    ok(/原点在截图左上角/.test(r.text) && /1:1/.test(r.text), '文本里给出截图坐标口径（原点左上、与点击 1:1）')
  }

  // 2) 路由不收图片：不塞 image block，但把原因说清楚
  {
    const ctx = makeCtx(['text'])
    const tool = createTools({ bridge: makeVfsBridge(), config: cfg, isEnabled: () => true, ctx }).find((t) => t.name === 'cu_state')
    const r = await tool.execute({ pid: 42, windowId: 77, screenshot: true, settle: false }, exec)
    ok(Array.isArray(r.images) && r.images.length === 0, '文本路由不塞图片块')
    ok(/声明只收文本/.test(r.text), '文本路由如实说明原因，截图仍落盘')
  }

  // 2b) 拿不到路由元数据（老宿主）：仍然交付，由宿主给纯文本模型做投影
  {
    const ctx = {
      get: (n) => (n === 'attachments' ? { imageLimits: { mediaTypes: ['image/png'] }, saveImage: async (i) => ({ attachmentId: 'att-2', mediaType: 'image/png', bytes: i.data.length }) } : null),
    }
    const tool = createTools({ bridge: makeVfsBridge(), config: cfg, isEnabled: () => true, ctx }).find((t) => t.name === 'cu_state')
    const r = await tool.execute({ pid: 42, windowId: 77, screenshot: true, settle: false }, exec)
    ok(r.images?.length === 1 && r.images[0].attachmentId === 'att-2', '路由元数据缺席时仍交付图片（不因检测不到就放弃）')
    ok(r.images[0].width === 3 && r.images[0].height === 3, '附件服务不回尺寸时用 PNG 真实宽高兜底（不再给 0x0）')
  }

  // 3) 没有 attachments 服务：同样只落盘 + 说明
  {
    const tool = createTools({ bridge: makeVfsBridge(), config: cfg, isEnabled: () => true }).find((t) => t.name === 'cu_state')
    const r = await tool.execute({ pid: 42, windowId: 77, screenshot: true, settle: false }, exec)
    ok(/attachments/.test(r.text) && r.images.length === 0, '缺图片服务时如实报「没有 attachments」')
  }

  // 4) 像素点击：x,y 原样进 click，并回一张带标记的新截图
  {
    const ctx = makeCtx(['text', 'image'])
    const bridge = makeVfsBridge()
    const tool = createTools({ bridge, config: cfg, isEnabled: () => true, ctx }).find((t) => t.name === 'cu_click')
    const r = await tool.execute({ pid: 42, windowId: 77, x: 10, y: 12 }, exec)
    const click = bridge.calls.find((c) => c.name === 'click')
    ok(click?.params.x === 10 && click?.params.y === 12, '像素点击把 x,y 按截图坐标原样下传')
    ok(click?.params.capture_id === 'cap-1', '像素点击绑定同一张截图的 capture_id')
    ok(/像素点击/.test(r.text) && /屏幕点/.test(r.text), '输出给出像素坐标与屏幕坐标换算')
    ok(r.images?.length === 1, '点击后返回一张新截图')
    ok(/红圈=本次点击位置/.test(r.text), '说明红圈标记与覆盖层差异')
    const savedBuf = ctx.saved.at(-1).data
    ok(readFileSync(path.join(dir, path.basename(ctx.saved.at(-1).name))).length === savedBuf.length, '截图本地也留了一份（同名文件）')
  }

  // 5) screenshot:false 关闭确认截图（老行为可回退）
  {
    const ctx = makeCtx(['text', 'image'])
    const bridge = makeVfsBridge()
    const tool = createTools({ bridge, config: cfg, isEnabled: () => true, ctx }).find((t) => t.name === 'cu_click')
    const r = await tool.execute({ pid: 42, windowId: 77, x: 10, y: 12, screenshot: false }, exec)
    ok(r.images.length === 0 && !/红圈/.test(r.text), 'screenshot:false 时点击不再附截图（默认行为可回退）')
    ok(bridge.calls.some((c) => c.name === 'click'), '关掉截图仍然完成点击')
  }

  // 6) 既没 label 也没 x,y：本地就报错，不空点
  {
    const tool = createTools({ bridge: makeVfsBridge(), config: cfg, isEnabled: () => true, ctx: makeCtx(['text']) }).find((t) => t.name === 'cu_click')
    const r = await tool.execute({ pid: 42, windowId: 77 }, exec)
    ok(/label/.test(r.text) && /x,y/.test(r.text), '缺 label 与 x,y 时给出明确错误')
  }
}

group('0.3.2 缺陷修复回归')
{
  const { mkdtempSync: mkTemp, readFileSync: readF, writeFileSync: writeF, rmSync: rmDir, existsSync: existsF } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const cfg = {
    defaultDelivery: 'background',
    defaultTimeoutMs: 1000,
    stateTimeoutMs: 2000,
    maxElements: 50,
    maxChars: 2000,
    idleShutdownMs: 0,
    screenshotDir: '~',
    driverComponentsRoot: 'stub',
    skillRegistered: false,
  }
  const makeBridge = (handler) => {
    const calls = []
    return {
      calls,
      exe: 'stub',
      version: '0',
      searched: 'stub',
      describe: () => ({ exe: 'stub', version: '0', searched: 'stub', running: false, calls: 0, stderrTail: '' }),
      listTools: async (force) => {
        calls.push({ name: 'listTools', force })
        return []
      },
      callTool: async (name, params) => {
        calls.push({ name, params })
        return handler(name, params, calls) ?? { structured: {}, text: '', isError: false }
      },
    }
  }
  const pick = (bridge, name, extra = {}) => createTools({ bridge, config: cfg, isEnabled: () => true, ...extra }).find((t) => t.name === name)
  const oneBtn = (extra = {}) => {
    const { elementExtra, ...rest } = extra
    return {
      structured: {
        pid: 42,
        window_id: 77,
        element_count: 1,
        returned_element_count: 1,
        window_bounds: { x: 0, y: 0, width: 100, height: 100 },
        screenshot_width: 98,
        screenshot_height: 98,
        capture_id: 'cap-x',
        elements: [
          { element_index: 0, role: 'Button', label: 'Go', element_token: 's1:0', actions: ['invoke'], frame: { x: 0, y: 0, w: 60, h: 60 }, ...elementExtra },
        ],
        ...rest,
      },
      text: '',
      isError: false,
    }
  }
  const live = { structured: { windows: [{ pid: 42, window_id: 77, title: 'W', minimized: false, is_on_screen: true, app_name: 'a.exe' }] }, text: '', isError: false }
  const minimum = { structured: { windows: [{ pid: 42, window_id: 77, title: 'W', minimized: true, is_on_screen: false, app_name: 'a.exe' }] }, text: '', isError: false }

  /* 技能 / 配置 / 路径 */
  ok(typeof skill.provider === 'string' && skill.provider.length > 0, 'skills.register 主分支的技能载荷带 provider（get() 强校验）')

  const schemaKit = await import('../lib/schema-kit.js')
  ok(schemaKit.buildConfig(() => { throw new Error('boom') }) === undefined, 'Schema 构造抛错不会把插件加载带崩')
  if (schemaKit.Schema) ok(String(schemaKit.SCHEMA_ERROR).includes('schema build failed'), '构造失败原因写进 SCHEMA_ERROR')
  else ok(schemaKit.SCHEMA_SOURCE === 'none' && String(schemaKit.SCHEMA_ERROR).length > 0, '本机无官方 Schemastery：SOURCE=none 且记录了降级原因')

  const prevEnv = process.env.CU_TEST_PLUGIN_ROOT
  process.env.CU_TEST_PLUGIN_ROOT = ROOT
  const envHit = findDriverExe('%CU_TEST_PLUGIN_ROOT%/package.json')
  ok(envHit.found && envHit.version === 'custom', 'driverPath 里的 %VAR% 会展开')
  const badHit = findDriverExe('~somebody/not-here.exe')
  ok(badHit.version !== 'custom', '~somebody 不会被误当成本用户主目录')
  if (prevEnv === undefined) delete process.env.CU_TEST_PLUGIN_ROOT
  else process.env.CU_TEST_PLUGIN_ROOT = prevEnv
  const weirdDir = mkTemp(path.join(tmpdir(), 'cu-weird-'))
  const weirdShot = resolveShotPath('~somebody/x.png', { screenshotDir: weirdDir })
  ok(weirdShot.includes('~somebody'), '截图路径里的 ~somebody 不再被展开成主目录')
  rmDir(weirdDir, { recursive: true, force: true })

  const { apply } = await import('../lib/index.js')
  const reg = new Map()
  const baseCtx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(def) { reg.set(def.name, def); return () => reg.delete(def.name) },
      get: (n) => reg.get(n),
    },
    get: () => null,
    effect(fn) { return fn() },
  }
  const boolHome = mkTemp(path.join(tmpdir(), 'cu-bool-'))
  const prevProfile = process.env.USERPROFILE
  process.env.USERPROFILE = boolHome
  try {
    const disposeBool = apply(baseCtx, { enabled: 'false', driverPath: path.join(ROOT, 'package.json'), promptSection: false, announceOnLoad: 'true' })
    const out = await reg.get('cu_doctor').execute({})
    ok(out.disabled === true, '字符串 "false" 也能软禁用（布尔字段归一化一致）')
    ok(reg.size === TOOL_COUNT, '软禁用只拒绝执行，工具仍常驻注册')
    disposeBool()

    let attempts = 0
    const retryCtx = {
      ...baseCtx,
      get(id) {
        if (id === 'systemPrompt') {
          return {
            section: () => {
              attempts += 1
              if (attempts === 1) throw new Error('prompt section already exists')
              return () => {}
            },
            getSectionOrder: () => 0,
          }
        }
        return null
      },
    }
    const disposeRetry = apply(retryCtx, { enabled: true, driverPath: path.join(ROOT, 'package.json'), promptSection: true, announceOnLoad: false })
    await sleep(1300)
    ok(attempts >= 2, `系统提示节注入失败会延时重试（尝试 ${attempts} 次）`)
    disposeRetry()
  } finally {
    process.env.USERPROFILE = prevProfile
    rmDir(boolHome, { recursive: true, force: true })
  }

  /* 驱动桥：服务端请求 / spawn error / 进程退出兜底 */
  ok(process.listeners('exit').length > 0, '驱动桥注册了进程退出兜底（宿主异常退出不留孤儿驱动）')
  {
    const { spawnImpl } = makeFakeSpawn((proc) => {
      proc.handle = (msg) => {
        if (msg.method === 'initialize') return reply(proc, msg, { protocolVersion: '2024-11-05' })
        if (msg.method === 'tools/call') {
          // 服务端→客户端请求，id 故意与在途请求撞车：绝不能把它当响应
          proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, method: 'roots/list', params: {} })}\n`)
          setTimeout(() => reply(proc, msg, { content: [{ type: 'text', text: 'done' }] }), 10)
          return
        }
        return null
      }
    })
    const b = new DriverBridge({ exe: path.join(ROOT, 'package.json'), timeoutMs: 800, idleShutdownMs: 0, spawnImpl })
    const r = await b.callTool('x', {}, 500)
    ok(r.text === 'done', '服务端发起的请求不会误 resolve 在途 RPC（真响应没丢）')
    b.stop()
  }
  {
    const { procs, spawnImpl } = makeFakeSpawn(() => {})
    const b = new DriverBridge({ exe: path.join(ROOT, 'package.json'), timeoutMs: 800, idleShutdownMs: 0, spawnImpl })
    const started = b.start()
    const proc = procs[0]
    proc.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }))
    const err = await started.then(() => null, (e) => e)
    ok(err && /EACCES|无法启动/.test(err.message), 'spawn error 被转成可读错误')
    ok(b.proc === null && b.ready === null, 'spawn error 后 proc/ready 被清理')
    ok(proc.stdin.writableEnded === true, 'spawn error 后 stdin 被 end（旧实现跳过 stop 的清理）')
    b.stop()
  }

  /* 恢复窗口：驱动没报错 ≠ 真恢复 */
  {
    const b = makeBridge((n) => {
      if (n === 'list_windows') return minimum
      if (n === 'get_window_state') return oneBtn()
      if (n === 'bring_to_front') return { structured: {}, text: 'ok', isError: false }
      return null
    })
    const r = await pick(b, 'cu_click').execute({ pid: 42, windowId: 77, label: 'Go' }, {})
    ok(/没成功/.test(r.text), '驱动没报错但窗口仍最小化时不再谎报「已 bring_to_front 恢复」')
    ok(/先手动恢复窗口/.test(r.text), '恢复失败时给出可执行的修法')
  }

  /* 复核判定：无关窗口不能当生效证据 */
  {
    let round = 0
    const b = makeBridge((n) => {
      if (n === 'list_windows') {
        round += 1
        const extra = round >= 2 ? [{ pid: 999, window_id: 888, title: '通知', app_name: 'notify.exe', is_on_screen: true, minimized: false }] : []
        return { structured: { windows: [...live.structured.windows, ...extra] }, text: '', isError: false }
      }
      if (n === 'get_window_state') return oneBtn()
      return null
    })
    const r = await pick(b, 'cu_click').execute({ pid: 42, windowId: 77, label: 'Go' }, {})
    ok(/很可能没生效/.test(r.text), '复核期间无关应用弹窗不会把「没点中」误判成生效')
    ok(b.calls.filter((c) => c.name === 'click').length === 2, '误判被挡住后仍按阶梯升级重投')
  }

  /* 像素点击：弹出窗口 / window_minimized 重投 / captureId 绑定 */
  {
    let seen = false
    const b = makeBridge((n) => {
      if (n === 'list_windows') {
        const extra = seen ? [{ pid: 42, window_id: 99, title: '菜单', app_name: 'a.exe', is_on_screen: true, minimized: false }] : []
        return { structured: { windows: [...live.structured.windows, ...extra] }, text: '', isError: false }
      }
      if (n === 'get_window_state') return oneBtn()
      if (n === 'click') { seen = true; return { structured: { route: 'global_input' }, text: '', isError: false } }
      return null
    })
    const r = await pick(b, 'cu_click').execute({ pid: 42, windowId: 77, x: 10, y: 12, screenshot: false }, {})
    ok(/新窗口出现/.test(r.text), '像素点击弹出的同进程窗口会被复核看见（不再误判没生效）')
  }
  {
    /* 像素点击：background 合成事件点不动原生 Win32 菜单项 → 升级成 foreground 真鼠标事件 */
    let clicks = 0
    const b = makeBridge((name) => {
      if (name === 'list_windows') return live
      if (name === 'get_window_state') {
        // 只有「真的用真鼠标事件点过一次」之后，界面才算变了
        return oneBtn({ elementExtra: { label: clicks >= 2 ? '已变化' : 'Go' } })
      }
      if (name === 'click') { clicks += 1; return { structured: { route: 'synthetic_events' }, text: '', isError: false } }
      return null
    })
    await pick(b, 'cu_click').execute({ pid: 42, windowId: 77, x: 10, y: 12, screenshot: false }, {})
    const modes = b.calls.filter((c) => c.name === 'click').map((c) => c.params?.delivery_mode)
    ok(modes.length === 2 && modes[0] === 'background' && modes[1] === 'foreground', `像素点击 background 没生效会升级成 foreground 真鼠标事件（实际 ${modes.join('→') || '无'}）`)
  }
  {
    /* 已经生效就不许重投 —— toggle 控件被点第二下会变回去 */
    let clicks = 0
    const b = makeBridge((name) => {
      if (name === 'list_windows') return live
      if (name === 'get_window_state') {
        return oneBtn({ elementExtra: { label: clicks >= 1 ? '已变化' : 'Go' } })
      }
      if (name === 'click') { clicks += 1; return { structured: { route: 'synthetic_events' }, text: '', isError: false } }
      return null
    })
    await pick(b, 'cu_click').execute({ pid: 42, windowId: 77, x: 10, y: 12, screenshot: false }, {})
    const modes = b.calls.filter((c) => c.name === 'click').map((c) => c.params?.delivery_mode)
    ok(modes.length === 1, `像素点击已生效时不重投（实际点了 ${modes.length} 次）`)
  }
  {
    let clicks = 0
    let restored = false
    const b = makeBridge((n) => {
      if (n === 'list_windows') return restored ? live : minimum
      if (n === 'get_window_state') return oneBtn()
      if (n === 'bring_to_front') { restored = true; return { structured: { restored: true, landed_on_target: true }, text: '', isError: false } }
      if (n === 'click') {
        clicks += 1
        if (clicks === 1) return { structured: { refusal: 'window_minimized' }, text: 'window_minimized', isError: true }
        return { structured: { route: 'global_input' }, text: '', isError: false }
      }
      return null
    })
    await pick(b, 'cu_click').execute({ pid: 42, windowId: 77, x: 10, y: 12, screenshot: false }, {})
    ok(clicks === 2, `像素点击遇到 window_minimized 会恢复窗口并重投（实际 ${clicks} 次）`)
  }
  {
    const b = makeBridge((n) => {
      if (n === 'list_windows') return live
      if (n === 'get_window_state') return oneBtn({ capture_id: 'cap-auto' })
      return null
    })
    await pick(b, 'cu_click').execute({ pid: 42, windowId: 77, x: 1, y: 1, captureId: 'cap-user', screenshot: false }, {})
    ok(b.calls.find((c) => c.name === 'click')?.params.capture_id === 'cap-user', 'cu_click 的 captureId 覆盖自动捕获 id（坐标与画面同源）')
  }

  /* cu_state 截图输出 capture_id + 图片尺寸兜底 */
  {
    const { deflateSync } = await import('node:zlib')
    const tiny = (() => {
      const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const chunk = (t, d) => {
        const h = Buffer.alloc(8)
        h.writeUInt32BE(d.length, 0)
        h.write(t, 4, 'ascii')
        return Buffer.concat([h, d, Buffer.alloc(4)])
      }
      const ihdr = Buffer.alloc(13)
      ihdr.writeUInt32BE(3, 0)
      ihdr.writeUInt32BE(3, 4)
      ihdr[8] = 8
      ihdr[9] = 6
      return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc((3 * 4 + 1) * 3))), chunk('IEND', Buffer.alloc(0))])
    })()
    const shotDir = mkTemp(path.join(tmpdir(), 'cu-state-shot-'))
    const b = makeBridge((n, p) => {
      if (n === 'list_windows') return live
      if (n === 'get_window_state') {
        if (p?.screenshot_out_file) writeF(p.screenshot_out_file, tiny)
        return oneBtn({ capture_id: 'cap-state' })
      }
      return null
    })
    const r = await pick(b, 'cu_state').execute({ pid: 42, windowId: 77, screenshotFile: path.join(shotDir, 'a.png'), settle: false }, {})
    ok(/capture_id=cap-state/.test(r.text), 'cu_state 截图输出带上 capture_id（像素点击可绑定同源画面）')
    rmDir(shotDir, { recursive: true, force: true })
  }

  /* render 保护 / fmtClick 拒绝优先 */
  {
    const tool = pick(makeBridge(() => null), 'cu_doctor')
    const blocks = tool.output.render({}, { get text() { throw new Error('render boom') } })
    ok(blocks.length === 1 && /渲染失败/.test(blocks[0].text), 'render 抛错不再冒泡成工具级崩溃')
    const txt = fmtClick({
      matched: { hits: 1, role: 'Button', label: 'X', token: 's1' },
      click: { structured: { refusal: 'window_minimized' }, text: 'iconic' },
      after: { before: 1, now: 2, changed: true },
    })
    ok(/驱动拒绝/.test(txt) && !/这次点击\*\*有效\*\*/.test(txt), 'window_minimized 拒绝不会因复核有变化被翻案成「有效」')
  }

  /* 参数校验 / 缓存语义 / 输出口径 */
  {
    const b = makeBridge(() => ({ structured: { status: 'satisfied' }, text: '', isError: false }))
    const t = pick(b, 'cu_verify')
    const many = await t.execute({ pid: 42, windowId: 77, expect: Array.from({ length: 9 }, () => ({ window: { exists: true } })) }, {})
    ok(/1-8/.test(many.text) && !b.calls.some((c) => c.name === 'verify_state'), 'expect 超过 8 条本地拒绝')
    const dirty = await t.execute({ pid: 42, windowId: 77, expect: [1, { window: { exists: true } }] }, {})
    ok(/空谓词/.test(dirty.text) && !b.calls.some((c) => c.name === 'verify_state'), 'expect 混入非对象本地拒绝')
  }
  {
    const winList = { structured: { windows: [{ pid: 42, window_id: 77, title: 'W', is_on_screen: true, minimized: false }] }, text: '', isError: false }
    const b = makeBridge((n) => {
      if (n === 'list_windows') return winList
      if (n === 'get_window_state') return oneBtn()
      return { structured: { delivery: { mode: 'foreground' }, effect: 'confirmed' }, text: '', isError: false }
    })
    const r = await pick(b, 'cu_key').execute({ pid: 42, key: 'Enter', observe: true }, {})
    ok(/复核快照/.test(r.text), '只给 pid 时 observe:true 也会按 pid 找窗口复核（不静默跳过）')
  }
  {
    const b = makeBridge(() => null)
    const t = pick(b, 'cu_call')
    await t.execute({ query: 'launch' }, {})
    ok(b.calls.some((c) => c.name === 'listTools' && c.force === false), '带 query 列清单不再误触发 tools/list 强拉')
    await t.execute({ refresh: true }, {})
    ok(b.calls.some((c) => c.name === 'listTools' && c.force === true), 'refresh:true 才显式强拉缓存')
  }
  {
    const b = makeBridge((n) => (n === 'list_windows' ? { structured: { windows: [] }, text: '', isError: false } : null))
    const r = await pick(b, 'cu_windows').execute({ query: 'xxx' }, {})
    ok(/没有可见窗口/.test(r.text) && /窗口 0 个/.test(r.text), '无窗口 + query 过滤时空表提示与表头都不被删')
  }
  {
    const longTitle = 'A'.repeat(60) + '关键词'
    const b = makeBridge((n) =>
      n === 'list_windows'
        ? { structured: { windows: [{ pid: 1, window_id: 2, title: longTitle, app_name: 'x.exe', is_on_screen: true }] }, text: '', isError: false }
        : null,
    )
    const r = await pick(b, 'cu_windows').execute({ query: '关键词' }, {})
    ok(/1\t2/.test(r.text), 'query 能命中 clip(title,52) 截断掉的长标题尾部关键词')
  }
  {
    let reads = 0
    const b = makeBridge((n) => {
      if (n === 'list_windows') return { structured: { windows: [{ pid: 42, window_id: 77, title: 'W', app_name: 'a.exe' }] }, text: '', isError: false }
      if (n === 'get_window_state') {
        reads += 1
        if (reads === 1) return { structured: { code: 'gone' }, text: '窗口已关闭', isError: true }
        return { structured: { element_count: 0, degraded: true, elements: [] }, text: '', isError: false }
      }
      return null
    })
    const r = await pick(b, 'cu_recover').execute({ pid: 42, windowId: 77, maxAttempts: 2 }, {})
    ok(!/-1/.test(r.text), '读树报错的哨兵 -1 不会当成元素数打印')
    ok(/报错/.test(r.text), '混合「报错 + 0 元素」时如实写出「报错」')
  }

  /* 状态文件：连续写期间目标不得出现空窗 */
  {
    const { createInstanceStatus } = await import('../lib/status.js')
    const base = mkTemp(path.join(tmpdir(), 'cu-atomic-'))
    const s = createInstanceStatus({ id: 'atomic-1', pid: process.pid }, base)
    const legacy = path.join(base, 'computer-use-pro-status.json')
    let missing = 0
    for (let i = 0; i < 40; i++) {
      s.write({ role: 'primary', i })
      if (!existsF(legacy)) missing += 1
    }
    ok(missing === 0, '连续写聚合视图期间目标文件始终存在（不再 rmSync 制造空窗）')
    ok(JSON.parse(readF(legacy, 'utf8')).i === 39, '连续写后聚合视图仍是最新一份完整 JSON')
    rmDir(base, { recursive: true, force: true })
  }
}

/* --------------------------- 0.3.3：补上此前 0 覆盖的路径 --------------------------- */

group('0.3.3 加固回归：韧性 kit / 探针 / PNG / 统计 / 配置 / 工具主路径')
{
  const { deflateSync, inflateSync } = await import('node:zlib')
  const { mkdtempSync, readFileSync: readF2, writeFileSync: writeF2, rmSync: rm2 } = await import('node:fs')
  const { tmpdir: tmpdir2 } = await import('node:os')
  const { spawnSync } = await import('node:child_process')

  /* 1) tool-kit.js —— 官方包缺席时的降级实现，以前整文件 0 覆盖 */
  const kit = await import('../lib/tool-kit.js')
  ok(['dsh-tools', 'shim'].includes(kit.TOOL_KIT_SOURCE), `defineTool 来源可诊断（${kit.TOOL_KIT_SOURCE}）`)
  const kitTool = kit.defineTool({
    name: 'kit_probe',
    description: 'kit 探针工具',
    parameters: {
      a: { type: 'string', required: true },
      b: { type: 'json' },
      c: { type: 'array', items: { type: 'integer' } },
      d: { type: 'object', properties: { e: { type: 'number' } } },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
    execute: async (args) => ({ a: args.a }),
  })
  ok(kitTool.name === 'kit_probe' && kitTool.parameters?.type === 'object', 'defineTool 产出标准工具形状')
  ok(typeof kitTool.execute === 'function' && typeof kitTool.output?.render === 'function', 'defineTool 保留 execute / render')
  if (kit.TOOL_KIT_SOURCE === 'shim') {
    ok((kitTool.parameters.required ?? []).includes('a'), 'shim 收集 required:true 标记')
    ok(kitTool.parameters.properties.b && !kitTool.parameters.properties.b.type, 'shim 把 type:json 编译成注解-only schema')
    ok(kitTool.parameters.properties.c?.items?.type === 'integer', 'shim 递归编译 array/items')
    ok(kitTool.parameters.properties.d?.properties?.e?.type === 'number', 'shim 递归编译嵌套 object')
  } else {
    ok(typeof kit.TOOL_KIT_ERROR === 'string', '官方 dsh-tools 路径下错误原因字段可诊断')
  }
  const kitOut = await kitTool.execute({ a: 'x' }, {})
  ok(kitOut?.a === 'x', 'defineTool 的 execute 透传参数')

  /* 2) mcp-probe.mjs —— 入口契约（不依赖驱动是否安装） */
  const probeFile = path.join(ROOT, 'scripts', 'mcp-probe.mjs')
  const noArgs = spawnSync(process.execPath, [probeFile], { encoding: 'utf8' })
  ok(noArgs.status === 2 && /usage:/.test(noArgs.stderr), `探针无参数时打印用法并以 2 退出（实际 ${noArgs.status}）`)
  ok(/verify/.test(noArgs.stderr) && /click-by/.test(noArgs.stderr) && /--index/.test(noArgs.stderr), '用法列出 verify / click-by / --index')
  const probeSrc = readF2(probeFile, 'utf8')
  ok(probeSrc.includes("from '../lib/tools.js'"), 'click-by 复用插件的 cu_click（不再另写一套判定）')
  ok(/guard\.unref/.test(probeSrc), '探针用 unref 长兜底，不强退截断输出')

  /* 3) shot.js —— PNG 编解码 / 标记像素 / 附件服务各分支 */
  const makePng = (w, h) => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const chunk = (type, data) => {
      const head = Buffer.alloc(8)
      head.writeUInt32BE(data.length, 0)
      head.write(type, 4, 'ascii')
      // CRC 由 encodePng 重写；decodePng 只解析 chunk 不校验 CRC
      return Buffer.concat([head, data, Buffer.alloc(4)])
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(w, 0)
    ihdr.writeUInt32BE(h, 4)
    ihdr[8] = 8
    ihdr[9] = 6
    return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc((w * 4 + 1) * h))), chunk('IEND', Buffer.alloc(0))])
  }
  const shotKit = await import('../lib/shot.js')
  const px = makePng(5, 5)
  ok(shotKit.pngSize(px)?.width === 5 && shotKit.pngSize(px)?.height === 5, 'pngSize 读 IHDR 宽高')
  ok(shotKit.pngSize(Buffer.from('not a png')) === null, '非 PNG 返回 null')
  const marked = shotKit.markPoint(px, { x: 2, y: 2 })
  ok(Buffer.isBuffer(marked) && shotKit.pngSize(marked)?.width === 5, 'markPoint 产出可解码 PNG')
  ok(shotKit.markPoint(px, { x: NaN, y: 2 }) === null, '非法坐标不画标记')
  ok(shotKit.markPoint(Buffer.from('bad'), { x: 1, y: 1 }) === null, '非 PNG 输入不画标记')

  // 像素级校验：40x40 的图上点 (20,20)，解 IDAT 找品红环 (230,0,92)
  const big = makePng(40, 40)
  const markedBig = shotKit.markPoint(big, { x: 20, y: 20 })
  let off = 8
  const idat = []
  while (off + 8 <= markedBig.length) {
    const len = markedBig.readUInt32BE(off)
    const type = markedBig.toString('ascii', off + 4, off + 8)
    if (type === 'IDAT') idat.push(markedBig.subarray(off + 8, off + 8 + len))
    off += 12 + len
    if (type === 'IEND') break
  }
  const rawPx = inflateSync(Buffer.concat(idat))
  let magenta = 0
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) {
      const p = y * (40 * 4 + 1) + 1 + x * 4
      if (rawPx[p] === 230 && rawPx[p + 1] === 0 && rawPx[p + 2] === 92) magenta += 1
    }
  }
  ok(magenta > 0, `红圈真的画在像素上（品红像素 ${magenta} 个）`)

  const ai = shotKit.attachImage
  const svc = (obj) => ({ ctx: { get: () => obj }, exec: {}, data: px, name: 'x.png', logger: null })
  const noSvc = await ai({ ctx: null, exec: {}, data: px, name: 'x.png' })
  ok(noSvc.image === null && /attachments/.test(noSvc.reason), '无 attachments 服务时如实说明')
  const jpegOnly = await ai(svc({ saveImage: async () => ({}), imageLimits: { mediaTypes: ['image/jpeg'] } }))
  ok(jpegOnly.image === null && /image\/png/.test(jpegOnly.reason), '宿主不收 image/png 时拒绝并说明')
  const tooBig = await ai(svc({ saveImage: async () => ({}), imageLimits: { maxImageBytes: 1 } }))
  ok(/超过宿主单图上限/.test(tooBig.reason), '超过单图上限时拒绝')
  const saveFail = await ai(svc({ saveImage: async () => { throw new Error('boom') } }))
  ok(/saveImage 失败/.test(saveFail.reason), 'saveImage 抛错时降级为纯文本并说明')
  const noRef = await ai(svc({ saveImage: async () => ({}) }))
  ok(noRef.image === null && /没返回可用引用/.test(noRef.reason), '附件服务没给引用时拒绝')
  const good = await ai(svc({ saveImage: async () => ({ attachmentId: 'A1' }) }))
  ok(good.image?.attachmentId === 'A1' && good.image.width === 5 && good.image.height === 5, '服务不回尺寸时用 PNG 头兜底宽高')

  /* 4) driver.js —— 同步 spawn 抛错 / 调用统计 / 空闲回收 */
  const fakeExe = path.join(ROOT, 'package.json')
  const syncThrow = new DriverBridge({ exe: fakeExe, spawnImpl: () => { throw new Error('EACCES sync') } })
  let syncErr = null
  try {
    await syncThrow.start()
  } catch (e) {
    syncErr = e
  }
  ok(syncErr?.code === 'SPAWN_FAILED', 'spawn 同步抛错归类为 SPAWN_FAILED')
  ok(syncThrow.proc === null && syncThrow.ready === null, '同步 spawn 失败后 proc/ready 清空，可重试')
  syncThrow.stop()

  const statB = new DriverBridge({ exe: fakeExe })
  statB.start = async () => {}
  statB.serial = (fn) => fn()
  statB._touch = () => {}
  statB.request = async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false })
  await statB.callTool('a')
  await statB.callTool('b')
  const st = statB.describe().stats
  ok(st.calls === 2, '调用统计累计次数')
  ok(st.avgMs >= 0 && st.maxMs >= st.lastMs && st.errors === 0, '调用统计给出平均/最慢耗时与零失败')
  statB.request = async () => { throw new Error('boom') }
  await statB.callTool('c').catch(() => {})
  ok(statB.describe().stats.errors === 1, 'RPC 抛错计入失败次数')
  statB.stop()

  const idleB = new DriverBridge({ exe: fakeExe, idleShutdownMs: 20 })
  idleB.proc = { stdin: { end() {} }, kill() {}, exitCode: null }
  idleB._touch()
  ok(idleB.idleTimer !== null, '_touch 安排空闲回收定时器')
  await new Promise((r) => setTimeout(r, 60))
  ok(idleB.proc === null, '空闲超时后自动回收驱动子进程')
  idleB.stop()

  /* 5) index.js —— 配置归一化与边界 */
  const idx = await import('../lib/index.js')
  const rc = idx.resolveConfig({ defaultDelivery: 'FRONT', maxElements: 0, maxChars: 999999, defaultTimeoutMs: -5, enabled: 'false', promptSection: 'off' })
  ok(rc.defaultDelivery === 'background', '非法 defaultDelivery 回落到 background')
  ok(rc.maxElements >= 1 && rc.maxChars <= 100000 && rc.defaultTimeoutMs >= 1000, '数值配置收敛到安全区间')
  ok(rc.enabled === false && rc.promptSection === false, '布尔字段口径统一（false / off 都关）')
  ok(idx.resolveConfig({ idleShutdownMs: 99999999 }).idleShutdownMs <= 3600000, 'idleShutdownMs 有上限')
  ok(idx.resolveConfig({}).enabled === true, '空配置沿用默认值')

  /* 6) skill.js —— 截图目录跟随配置 */
  const sk = await import('../lib/skill.js')
  ok(sk.buildSkill(ROOT, 'C:/custom-shots').content.includes('C:/custom-shots'), '技能正文跟随 screenshotDir 配置')
  ok(sk.buildSkill(ROOT).content.includes('~/.dsh/computer-use/shots'), '省略 screenshotDir 时回落默认目录')

  /* 7) format.js —— 混合类型索引与 fmtApps */
  const fmt = await import('../lib/format.js')
  const mixed = {
    pid: 1, window_id: 2, element_count: 3, returned_element_count: 3,
    elements: [
      { element_index: 0, role: 'Window', parent_index: null, depth: 0 },
      { element_index: '1', role: 'Pane', parent_index: 0, depth: 1 },
      { element_index: 2, role: 'Button', label: 'Go', actions: ['invoke'], element_token: 't1', parent_index: '1', depth: 2 },
    ],
  }
  const mixedTxt = fmt.fmtState(mixed, {})
  ok(/可点 1/.test(mixedTxt) && /Button "Go"/.test(mixedTxt), 'element_index / parent_index 类型混用时祖先链与可点行都不丢')
  const appsTxt = fmt.fmtApps({ apps: [{ name: '设置', bundle_id: 'x!App', running: true, pid: 1 }, { name: '记事本', launch_path: 'C:/n.exe', running: false }] }, { query: '设置' })
  ok(/bundle_id=x!App/.test(appsTxt) && !/记事本/.test(appsTxt), 'fmtApps 按 query 过滤且保留 bundle_id')

  /* 8) 工具主路径 —— cu_doctor / cu_window_info / cu_verify / cu_call */
  const tmpShots = mkdtempSync(path.join(tmpdir2(), 'cu-main-'))
  writeF2(path.join(tmpShots, 'a.png'), px)
  const mainBridge = {
    exe: fakeExe, version: '0', searched: '',
    describe: () => ({ exe: fakeExe, version: '0', searched: '', running: true, pid: 1234, calls: 3, uptimeMs: 100, stderrTail: '', stats: { calls: 3, errors: 0, timeouts: 0, avgMs: 12, maxMs: 30, lastMs: 10, totalMs: 36 } }),
    listTools: async () => [{ name: 'get_window_state' }],
    callTool: async (name) => {
      if (name === 'get_screen_size') return { structured: { width: 1920, height: 1080 }, text: '1920x1080', isError: false }
      if (name === 'list_windows') return { structured: { windows: [{ pid: 42, window_id: 77, title: 'W', app_name: 'a.exe', is_on_screen: true, minimized: false }] }, text: '', isError: false }
      if (name === 'debug_window_info') return { structured: { pid: 42, windows: [{ hwnd: 1, class_name: 'Windows.UI.Core.CoreWindow', title: '设置' }] }, text: '', isError: false }
      if (name === 'verify_state') return { structured: { status: 'satisfied', samples: 2, predicates: [{ index: 0, status: 'satisfied' }] }, text: '', isError: false }
      if (name === 'scroll') return { structured: {}, text: 'scrolled', isError: false }
      if (name === 'list_apps') return { structured: { apps: [{ name: '设置', bundle_id: 'x!App', running: true, pid: 1 }] }, text: '', isError: false }
      return { structured: {}, text: 'ok', isError: false }
    },
  }
  const mainCfg = { defaultDelivery: 'background', defaultTimeoutMs: 1000, stateTimeoutMs: 1000, maxElements: 50, maxChars: 2000, idleShutdownMs: 0, screenshotDir: tmpShots, driverComponentsRoot: '', skillRegistered: true }
  const defs2 = createTools({ bridge: mainBridge, config: mainCfg, logger: null, isEnabled: () => true })
  const run2 = async (n, a) => defs2.find((t) => t.name === n).execute(a, {})
  const doc = await run2('cu_doctor', {})
  ok(/MCP 握手/.test(doc.text) && /调用统计/.test(doc.text), 'cu_doctor 正常路径输出握手与调用画像')
  ok(/截图目录/.test(doc.text) && /1 个文件/.test(doc.text), 'cu_doctor 只读盘点截图目录')
  const wi = await run2('cu_window_info', { pid: 42 })
  ok(/CoreWindow/.test(wi.text) && /非渲染面/.test(wi.text), 'cu_window_info 转发并解读 CoreWindow')
  const vf = await run2('cu_verify', { pid: 42, windowId: 77, expect: { window: { exists: true } } })
  ok(/verdict: satisfied/.test(vf.text), 'cu_verify 正常转发并渲染三态')
  const cl = await run2('cu_call', { tool: 'scroll', args: { direction: 'down' } })
  ok(/scrolled/.test(cl.text), 'cu_call 正常转发原生工具')
  const la = await run2('cu_call', { tool: 'list_apps', args: {} })
  ok(/bundle_id/.test(la.text), 'cu_call 的 list_apps 重排成带 AUMID 的清单')
  rm2(tmpShots, { recursive: true, force: true })
}

/* --------------------------- 0.3.4：新功能与文档防漂移 --------------------------- */

group('0.3.4：光标自愈 / 键盘 UI / 便捷动作 / 截图策略 / 驱动自愈 / 文档防漂移')
{
  const { mkdtempSync, readFileSync: readF3, writeFileSync: writeF3, readdirSync: readdirF3, rmSync: rmF3 } = await import('node:fs')
  const { tmpdir: tmpdir3 } = await import('node:os')

  /* 1) 单一数据源：工具清单从 defs 生成，文档必须跟得上 */
  const toolsKit = await import('../lib/tools.js')
  const roster = toolsKit.toolRoster(tools)
  ok(Array.isArray(toolsKit.ROUTING_RULES) && toolsKit.ROUTING_RULES.length >= 8, '提示节规则是共享定义')
  ok(names.every((n) => roster.includes(`\`${n}\``)), 'roster 覆盖全部已注册工具（加工具不会漏改提示）')
  const readme = readF3(path.join(ROOT, 'README.md'), 'utf8')
  const skillMd = readF3(path.join(ROOT, 'skills', 'computer-use-pro', 'SKILL.md'), 'utf8')
  ok(names.every((n) => readme.includes(n)), 'README 覆盖全部 cu_* 工具名')
  ok(names.every((n) => skillMd.includes(n)), 'SKILL.md 速查表覆盖全部 cu_* 工具名')
  ok(!/没有 `cu_scroll` 这个工具/.test(skillMd + toolsKit.ROUTING_RULES.join('\n')), '文档不再声称「没有 cu_scroll」')

  /* 2) 光标自愈 + 键盘 UI（可编程假驱动，模拟真实 cursor 状态） */
  const curCalls = []
  const curState = {
    enabled: true,
    motion: { idle_hide_ms: 15000, timing: 'native', glide_duration_ms: 0 },
    position: null,
    visual_state: { requested_action: 'idle', resolved_action: 'idle', modifiers: [] },
    theme: { id: 'cua.default' },
  }
  const curBridge = {
    describe: () => ({ exe: 'stub', version: '0', searched: '', running: false, calls: 0, stderrTail: '' }),
    listTools: async () => [],
    callTool: async (name, args) => {
      curCalls.push({ name, args })
      if (name === 'get_agent_cursor_state') return { structured: JSON.parse(JSON.stringify(curState)), text: '', isError: false }
      if (name === 'set_agent_cursor_enabled') { curState.enabled = args.enabled; return { structured: { enabled: args.enabled }, text: '', isError: false } }
      if (name === 'set_agent_cursor_motion') { curState.motion = { ...curState.motion, ...args }; return { structured: { motion: curState.motion }, text: '', isError: false } }
      if (name === 'move_cursor') { curState.position = { x: args.x, y: args.y }; return { structured: {}, text: '', isError: false } }
      if (name === 'list_windows') return { structured: { windows: [{ pid: 42, window_id: 77, title: 'W', app_name: 'a.exe', is_on_screen: true, minimized: false }] }, text: '', isError: false }
      return { structured: {}, text: 'ok', isError: false }
    },
  }
  const curCfg = { defaultDelivery: 'background', defaultTimeoutMs: 1000, stateTimeoutMs: 1000, maxElements: 50, maxChars: 2000, idleShutdownMs: 0, screenshotDir: '~/.dsh/computer-use/shots', driverComponentsRoot: '', skillRegistered: false, keyboardOverlay: true }
  const curTools = createTools({ bridge: curBridge, config: curCfg, logger: null, isEnabled: () => true })
  const runC = async (n, a) => curTools.find((t) => t.name === n).execute(a, {})
  const st0 = await runC('cu_cursor', { action: 'status' })
  ok(/idle_hide_ms=15000/.test(st0.text) && /不是「永不自动隐藏」/.test(st0.text), 'cu_cursor status 报出「15 秒自动隐藏」根因')
  const sh = await runC('cu_cursor', { action: 'show' })
  ok(/已自愈/.test(sh.text), 'cu_cursor show 触发自愈并回读验证')
  ok(curCalls.some((c) => c.name === 'set_agent_cursor_enabled' && c.args.enabled === true), '自愈真的调用了 set_agent_cursor_enabled(true)')
  const motion = curCalls.find((c) => c.name === 'set_agent_cursor_motion')
  ok(motion?.args.idle_hide_ms === 0 && motion.args.glide_duration_ms === 120, '自愈把 idle_hide_ms 设 0 + 120ms 直移')
  ok(/永不自动隐藏/.test((await runC('cu_cursor', { action: 'status' })).text), '自愈后 status 确认健康')
  await runC('cu_cursor', { action: 'place', pid: 42, windowId: 77, x: 50, y: 60 })
  const mv = curCalls.filter((c) => c.name === 'move_cursor').pop()
  ok(mv?.args.target?.window_id === 77 && !Object.hasOwn(mv.args, 'scope'), 'move_cursor 用正确形状（不带 scope）')
  ok(/50,60/.test((await runC('cu_cursor', { action: 'status' })).text), 'place 之后覆盖层有位置')
  ok(/已隐藏/.test((await runC('cu_cursor', { action: 'hide' })).text), 'hide 可主动关闭覆盖层')

  const kb = await runC('cu_key', { pid: 42, key: 'Escape' })
  ok(/⌨ 键盘动作/.test(kb.text), 'cu_key 输出键盘动作行')
  ok(/覆盖层视觉状态/.test(kb.text), 'cu_key 回读并输出驱动侧语义播放状态')

  /* 3) 便捷动作 */
  const sc = await runC('cu_scroll', { title: 'W', direction: 'up', amount: 5, by: 'page' })
  const scrollCall = curCalls.find((c) => c.name === 'scroll')
  ok(/滚动 up ×5/.test(sc.text) && scrollCall?.args.direction === 'up' && scrollCall.args.amount === 5 && scrollCall.args.by === 'page', 'cu_scroll 参数映射与摘要正确')
  ok(/direction 只能是/.test((await runC('cu_scroll', { pid: 42, direction: 'sideways' })).text), 'cu_scroll 拒绝非法方向')
  await runC('cu_drag', { pid: 42, windowId: 77, fromX: 1, fromY: 2, toX: 3, toY: 4 })
  const dragCall = curCalls.find((c) => c.name === 'drag')
  ok(dragCall?.args.from_x === 1 && dragCall.args.to_y === 4 && dragCall.args.steps === 20, 'cu_drag 参数映射正确')
  await runC('cu_clipboard', { action: 'write', text: 'hello' })
  ok(curCalls.some((c) => c.name === 'clipboard_write' && c.args.text === 'hello'), 'cu_clipboard write 转发')
  await runC('cu_clipboard', { action: 'read' })
  ok(curCalls.some((c) => c.name === 'clipboard_read' && c.args.include_text === false), 'cu_clipboard read 默认不读明文')

  /* 4) 截图保留策略（纯函数，验证不误删用户文件） */
  const shotDir3 = mkdtempSync(path.join(tmpdir3(), 'cu-prune-'))
  for (let i = 0; i < 6; i++) writeF3(path.join(shotDir3, `state-42-77-${i}.png`), Buffer.from('x'))
  writeF3(path.join(shotDir3, 'keep-me.txt'), 'x')
  const removed = toolsKit.pruneShotFiles(shotDir3, { maxFiles: 2 })
  ok(removed === 4, `保留最近 2 张，清掉 4 张（实际 ${removed}）`)
  ok(readdirF3(shotDir3).includes('keep-me.txt'), '只删本插件命名的 PNG，不碰其它文件')
  ok(toolsKit.pruneShotFiles(shotDir3, {}) === 0, '默认关闭时一个文件都不删')
  rmF3(shotDir3, { recursive: true, force: true })

  /* 5) 驱动自愈 / 熔断 / 只读重试 */
  const exeA = path.join(ROOT, 'package.json')
  const exeB = path.join(ROOT, 'README.md')
  const fb = new DriverBridge({ exe: exeA, candidates: [{ exe: exeA, version: '2.0' }, { exe: exeB, version: '1.0' }] })
  ok(fb.describe().candidatesCount === 2 && fb.describe().exeIndex === 0, '驱动桥记录 2 个版本候选')
  ok(fb._nextCandidate() === true && fb.exe === exeB && fb.version === '1.0' && fb.restarts === 1, '启动失败切到次新版本')
  ok(fb._nextCandidate() === false, '没有更多候选时停止回退，不会无限循环')
  fb.stop()

  const rtB = new DriverBridge({ exe: exeA })
  rtB.start = async () => {}
  rtB.serial = (fn) => fn()
  rtB._touch = () => {}
  let n = 0
  rtB.request = async () => { n += 1; if (n === 1) { const e = new Error('exited'); e.code = 'EXITED'; throw e } return { content: [{ type: 'text', text: 'ok' }] } }
  const rr = await rtB.callTool('get_window_state', {})
  ok(rr.text === 'ok' && n === 2, '只读工具在子进程挂掉后自动重启补一次')
  let n2 = 0
  rtB.request = async () => { n2 += 1; const e = new Error('exited'); e.code = 'EXITED'; throw e }
  await rtB.callTool('press_key', {}).catch(() => {})
  ok(n2 === 1, '动作类工具绝不自动重试（防重复点击 / 重复输入）')
  rtB.stop()

  const cbB = new DriverBridge({ exe: exeA })
  cbB.start = async () => {}
  cbB.serial = (fn) => fn()
  cbB._touch = () => {}
  cbB.request = async () => { const e = new Error('gone'); e.code = 'EXITED'; throw e }
  for (let i = 0; i < 5; i++) await cbB.callTool('press_key', {}).catch(() => {})
  ok(cbB.describe().cooldownMs > 0 && cbB.failureStreak >= 5, '连续 5 次失败进入 30 秒熔断')
  let circuitErr = null
  try { await cbB.callTool('get_window_state', {}) } catch (e) { circuitErr = e }
  ok(circuitErr?.code === 'CIRCUIT_OPEN', '熔断期间直接返回可读错误，不卡住模型')
  cbB.stop()

  /* 6) 新配置项与版本号 */
  const idx3 = await import('../lib/index.js')
  const rc3 = idx3.resolveConfig({ keyboardOverlay: 'false', screenshotMaxFiles: 99999, screenshotMaxAgeDays: 9999 })
  ok(rc3.keyboardOverlay === false, 'keyboardOverlay 可用字符串 false 关闭')
  ok(rc3.screenshotMaxFiles <= 5000 && rc3.screenshotMaxAgeDays <= 365, '截图保留参数收敛到安全区间')
  ok(idx3.resolveConfig({}).screenshotMaxFiles === 0, '截图默认不清理')
  ok(Number(String(idx3.version).split('.').pop()) >= 4, `插件版本号不低于 0.3.4（实际 ${idx3.version}）`)
}

/* --------------------------- 0.3.5：浮窗与性能 --------------------------- */

group('0.3.5：桌面按键浮窗 / 协议 / 降级 / 性能档位 / 新配置')
{
  const { readFileSync: readF4 } = await import('node:fs')

  /* 1) 浮窗协议：Base64 让中文 / 竖线都不破坏纯 ASCII 命令 */
  const ovKit = await import('../lib/overlay.js')
  const enc = ovKit.encodeEncodedCommand()
  ok(Buffer.from(enc, 'base64').toString('utf16le').includes('KeyOverlayForm'), '-EncodedCommand 解码回原始脚本')
  const line = ovKit.buildShowLine('Ctrl + A 中文 | 竖线', { x: 100, y: 200, durationMs: 900 })
  const parts = line.trim().split('|')
  ok(parts[0] === 'show' && parts[1] === '900' && parts[2] === '100' && parts[3] === '200', 'show 命令字段正确')
  const decoded0 = Buffer.from(parts.slice(4).join('|'), 'base64').toString('utf8')
  ok(decoded0.includes('Ctrl') && decoded0.includes('中文') && decoded0.includes('竖线'), '键帽串 Base64 往返无损（含中文/竖线）')
  ok(decoded0.includes(ovKit.KEY_SEP), '键帽用 US 分隔符，修饰键可单独上色')
  const def = ovKit.buildShowLine('X').trim().split('|')
  ok(def[2] === '-1' && def[3] === '-1', '不给坐标时用 -1 让浮窗主屏底部居中')

  /* 2) 浮窗控制器（假进程，不真弹窗） */
  const mkProc = () => {
    const p = new EventEmitter()
    p.stdin = new PassThrough()
    p.stdout = new PassThrough()
    p.stderr = new PassThrough()
    p.exitCode = null
    p.lastWrite = ''
    p.stdin.write = (s) => { p.lastWrite += String(s); return true }
    p.kill = () => { p.exitCode = 1 }
    p.emitReady = () => p.stdout.emit('data', 'ok:ready\n')
    return p
  }
  const spawned = []
  const ov = new ovKit.KeyboardOverlay({
    durationMs: 900, startTimeoutMs: 300, idleShutdownMs: 0,
    spawnImpl: (cmd, args) => {
      const p = mkProc()
      spawned.push({ cmd, args, p })
      setImmediate(() => p.emitReady())
      return p
    },
  })
  ok(spawned.length === 0, '浮窗懒启动：构造时不 spawn')
  const r1 = await ov.show('Ctrl+A', { x: 10, y: 20 })
  ok(r1 === true && spawned.length === 1, '第一次 show 才启动进程')
  ok(spawned[0].cmd === 'powershell.exe' && spawned[0].args.includes('-EncodedCommand'), '用 powershell -EncodedCommand 启动')
  ok(/show\|900\|10\|20\|/.test(spawned[0].p.lastWrite), 'show 命令带上配置时长与坐标')
  ok(/^config\|/.test(spawned[0].p.lastWrite), 'ready 后先发一次 config（主题/字号/位置）')
  ok(ov.describe().shows === 1 && ov.describe().running === true, '浮窗状态可诊断')
  await ov.show('Escape')
  ok(spawned.length === 1 && ov.describe().shows === 2, '复用同一个常驻进程，不重复 spawn')
  ov.stop()
  ok(ov.describe().running === false, 'stop 关掉浮窗进程')

  const ovFail = new ovKit.KeyboardOverlay({ startTimeoutMs: 60, spawnImpl: () => mkProc() })
  ok((await ovFail.show('X')) === false && ovFail.describe().unavailable === true, '启动超时标记不可用，不让键盘等它')
  const errBefore = ovFail.describe().lastError
  await ovFail.show('Y')
  ok(ovFail.describe().lastError === errBefore, '不可用后直接短路，不再重试 spawn')
  ovFail.stop()

  /* 3) 性能档位：量化 RPC 减少 */
  const perfCalls = (sink) => ({
    describe: () => ({ exe: 's', version: '0', searched: '', running: false, calls: 0, stderrTail: '' }),
    listTools: async () => [],
    callTool: async (name) => {
      sink.push(name)
      if (name === 'list_windows') return { structured: { windows: [{ pid: 42, window_id: 77, title: 'W', app_name: 'a.exe', is_on_screen: true, minimized: false, bounds: { x: 0, y: 0, width: 100, height: 100 } }] }, text: '', isError: false }
      if (name === 'get_window_state') return { structured: { pid: 42, window_id: 77, element_count: 1, returned_element_count: 1, window_bounds: { x: 0, y: 0, width: 100, height: 100 }, elements: [{ element_index: 0, role: 'Button', label: 'Go', element_token: 's1:0', actions: ['invoke'], frame: { x: 0, y: 0, w: 20, h: 20 } }] }, text: '', isError: false }
      if (name === 'get_agent_cursor_state') return { structured: { enabled: true, motion: { idle_hide_ms: 0, timing: 'fixed' } }, text: '', isError: false }
      return { structured: { route: 'accessibility', effect: 'confirmed' }, text: '', isError: false }
    },
  })
  const baseCfgP = {
    defaultDelivery: 'background', defaultTimeoutMs: 1000, stateTimeoutMs: 1000,
    maxElements: 50, maxChars: 2000, idleShutdownMs: 0,
    screenshotDir: '~/.dsh/computer-use/shots', driverComponentsRoot: '',
    skillRegistered: false, keyboardOverlayWindow: false, targetCacheMs: 0,
  }
  const runProfile = async (profile) => {
    const sink = []
    const defsP = createTools({ bridge: perfCalls(sink), config: { ...baseCfgP, observeProfile: profile }, isEnabled: () => true })
    await defsP.find((t) => t.name === 'cu_click').execute({ pid: 42, windowId: 77, label: 'Go', screenshot: false }, {})
    return sink.filter((n) => n === 'get_window_state' || n === 'list_windows').length
  }
  const fastN = await runProfile('fast')
  const balancedN = await runProfile('balanced')
  ok(fastN < balancedN, `fast 档比 balanced 少 RPC（${fastN} vs ${balancedN}）`)

  /* 4) title 缓存：连续两次同标题只列一次窗口表 */
  const cacheSink = []
  const cacheDefs = createTools({ bridge: perfCalls(cacheSink), config: { ...baseCfgP, targetCacheMs: 5000 }, isEnabled: () => true })
  const stateC = cacheDefs.find((t) => t.name === 'cu_state')
  await stateC.execute({ title: 'W', settle: false }, {})
  await stateC.execute({ title: 'W', settle: false }, {})
  const listCount = cacheSink.filter((n) => n === 'list_windows').length
  ok(listCount === 1, `连续两次同 title 只列一次窗口表（实际 ${listCount}）`)

  /* 5) 新配置、文档与版本号 */
  const idx5 = await import('../lib/index.js')
  const rc5 = idx5.resolveConfig({ keyboardOverlayWindow: 'false', observeProfile: 'nope', targetCacheMs: 999999, overlayDurationMs: 10 })
  ok(rc5.keyboardOverlayWindow === false, '浮窗可用字符串 false 关闭')
  ok(rc5.observeProfile === 'balanced', '非法 observeProfile 回落 balanced')
  ok(rc5.targetCacheMs <= 30000 && rc5.overlayDurationMs >= 250, '新数值配置收敛到安全区间')
  ok(idx5.resolveConfig({}).keyboardOverlayWindow === true, '浮窗默认开启')
  const readme5 = readF4(path.join(ROOT, 'README.md'), 'utf8')
  const skill5 = readF4(path.join(ROOT, 'skills', 'computer-use-pro', 'SKILL.md'), 'utf8')
  ok(/keyboardOverlayWindow/.test(readme5) && /observeProfile/.test(readme5), 'README 覆盖新配置项')
  ok(/按键浮窗/.test(skill5) && /observeProfile/.test(skill5), '技能正文覆盖浮窗与性能档位')
  ok(Number(String(idx5.version).split('.').pop()) >= 5, `插件版本号不低于 0.3.5（实际 ${idx5.version}）`)
}

/* --------------------------- 0.3.6：浮窗打磨 --------------------------- */

group('0.3.6：浮窗键帽 / 主题 / 位置策略 / 渐隐协议')
{
  const { readFileSync: readF6 } = await import('node:fs')
  const ov6 = await import('../lib/overlay.js')

  /* 1) 键帽解析 */
  const combo = ov6.parseKeycaps('⌨ Ctrl+Shift+T')
  ok(
    combo.length === 3 && combo[0].label === 'Ctrl' && combo[0].modifier === true &&
      combo[1].modifier === true && combo[2].label === 'T' && combo[2].modifier === false,
    '组合键拆成键帽且修饰键被标记',
  )
  const single = ov6.parseKeycaps('Escape')
  ok(single.length === 1 && single[0].label === 'Escape', '单键仍是一个键帽')
  const typed = ov6.parseKeycaps('输入文本「你好，世界」')
  ok(typed.length === 1 && typed[0].kind === 'text' && typed[0].label === '你好，世界', '输入文本作为单个文本键帽')
  const quoted = ov6.parseKeycaps('⌨ "hello world"')
  ok(quoted.length === 1 && quoted[0].label === 'hello world', '引号形式也识别为文本')
  ok(ov6.parseKeycaps('A+B+C+D+E+F+G+H+I').length === 8, '键帽数有上限，防止浮窗撑爆')
  ok(ov6.parseKeycaps('').length === 0, '空文本不产生键帽')

  /* 2) config / show 协议 */
  const cfgLine = ov6.buildConfigLine({ theme: 'accent', fontSize: 20, opacity: 0.9, position: 'fixed', fadeMs: 200 })
  ok(/^config\|accent\|20\|90\|fixed\|200\n$/.test(cfgLine), 'config 命令字段完整且可解析')
  const bp = ov6.buildConfigLine({ theme: 'nope', fontSize: 999, opacity: 9, position: '???', fadeMs: 1 }).trim().split('|')
  ok(bp[1] === 'dark' && bp[2] === '32' && bp[3] === '100' && bp[4] === 'auto' && bp[5] === '40', '非法外观参数收敛到安全区间')
  const sp = ov6.buildShowLine('⌨ Ctrl+A', { x: 50, y: 60, durationMs: 800 }).trim().split('|')
  const capsStr = Buffer.from(sp.slice(4).join('|'), 'base64').toString('utf8')
  ok(sp[0] === 'show' && sp[1] === '800' && sp[2] === '50' && sp[3] === '60', 'show 命令字段保持兼容')
  ok(capsStr === `*Ctrl${ov6.KEY_SEP}A`, '组合键编码成「*修饰键 + US + 普通键」')
  const center = ov6.buildShowLine('Enter').trim().split('|')
  ok(center[2] === '-1' && center[3] === '-1', '不给坐标时仍是主屏居中')

  /* 3) 新配置归一化 */
  const idx6 = await import('../lib/index.js')
  const rc6 = idx6.resolveConfig({ overlayTheme: 'NOPE', overlayFontSize: 999, overlayOpacityPct: 5, overlayPosition: '???', overlayFadeMs: 9999 })
  ok(rc6.overlayTheme === 'dark' && rc6.overlayPosition === 'auto', '主题/位置非法值回落')
  ok(rc6.overlayFontSize <= 32 && rc6.overlayOpacityPct >= 40 && rc6.overlayFadeMs <= 600, '外观数值收敛')
  const dflt6 = idx6.resolveConfig({})
  ok(dflt6.overlayTheme === 'dark' && dflt6.overlayFontSize === 15 && dflt6.overlayPosition === 'auto', '外观默认值正确')

  /* 4) 文档与版本 */
  const readme6 = readF6(path.join(ROOT, 'README.md'), 'utf8')
  const skill6 = readF6(path.join(ROOT, 'skills', 'computer-use-pro', 'SKILL.md'), 'utf8')
  ok(/overlayTheme/.test(readme6) && /overlayPosition/.test(readme6), 'README 覆盖浮窗外观配置')
  ok(/键帽/.test(skill6) && /渐隐/.test(skill6), '技能正文覆盖键帽与渐隐')
  ok(idx6.version === '0.3.6', `版本号已升到 0.3.6（实际 ${idx6.version}）`)
}

if (!process.argv.some((a) => a.startsWith('--offline')) && found.found) {
  group('真实驱动（只读）')
  const bridge = new DriverBridge({ exe: found.exe, version: found.version, searched: found.searched, timeoutMs: 20000 })
  const second = new DriverBridge({ exe: found.exe, version: found.version, searched: found.searched, timeoutMs: 20000 })
  try {
    const listed = await bridge.listTools(true)
    ok(listed.length >= 50, `tools/list 回来 ${listed.length} 个原生工具`)
    const names = listed.map((t) => t.name)
    for (const need of ['get_window_state', 'debug_window_info', 'launch_app', 'verify_state', 'click']) {
      ok(names.includes(need), `原生面含 ${need}`)
    }
    const wins = await bridge.callTool('list_windows', { on_screen_only: true }, 15000)
    ok(Array.isArray(wins.structured?.windows), 'list_windows 返回结构化窗口表')
    const text = fmtWindows(wins.structured, { hideOverlay: true })
    ok(text.startsWith('窗口'), '窗口表可渲染')
    console.log(`  · 当前可见窗口：${wins.structured?.windows?.length ?? '?'} 个`)

    // 两个实例同时存活：各自 spawn 一个驱动子进程，并发只读调用互不阻塞
    await second.listTools(true)
    const [winsA, winsB] = await Promise.all([
      bridge.callTool('list_windows', { on_screen_only: true }, 15000),
      second.callTool('list_windows', { on_screen_only: true }, 15000),
    ])
    ok(Array.isArray(winsA.structured?.windows) && Array.isArray(winsB.structured?.windows), '两个驱动实例可并发列窗口')
    const pidA = bridge.describe().pid
    const pidB = second.describe().pid
    ok(pidA && pidB && pidA !== pidB, `每个实例各自持有驱动子进程（${pidA} / ${pidB}）`)
  } catch (err) {
    ok(false, '真实驱动调用失败', err.message)
  } finally {
    bridge.stop()
    second.stop()
  }
} else {
  console.log('\n（跳过真实驱动实测：未装驱动或指定了 --offline）')
}

console.log(`\n合计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
