#!/usr/bin/env node
/**
 * scripts/mcp-probe.mjs — 不依赖宿主的命令行探针
 *
 * 复用 lib/driver.js 与 lib/format.js；`click-by` 直接复用 lib/tools.js 里的
 * cu_click（settle / index / 三级阶梯 / 复核都在内），所以终端输出与模型在对话里
 * 看到的是同一套判定，不再是「探针一套、插件一套」。
 * 用途：DSH 没开、或要单独验证驱动链路时，直接在终端跑。
 *
 * 用法：
 *   node mcp-probe.mjs doctor                       链路体检
 *   node mcp-probe.mjs list [--query=文本]          列 59 个原生工具
 *   node mcp-probe.mjs describe <tool>              看某个工具的参数定义
 *   node mcp-probe.mjs call <tool> -                参数从 stdin 传（PowerShell 5.1 安全写法）
 *   node mcp-probe.mjs call <tool> '{"pid":1}'      参数直接给（cmd/bash 下注意引号）
 *   node mcp-probe.mjs windows [--all]              列窗口（默认过滤驱动光标覆盖层）
 *   node mcp-probe.mjs info <pid>                   debug_window_info
 *   node mcp-probe.mjs state <pid> <windowId> [--query=文本] [--shot=文件名]
 *   node mcp-probe.mjs verify <pid> <windowId> <json|->
 *   node mcp-probe.mjs click-by <pid> <windowId> <label> [--role=Role] [--index=N] [--delivery=foreground] [--dry] [--no-observe]
 */

import { DriverBridge, findDriverExe } from '../lib/driver.js'
import { createTools } from '../lib/tools.js'
import { fmtState, fmtTools, fmtVerify, fmtWindowInfo, fmtWindows } from '../lib/format.js'

/** click-by 走的是插件同款 cu_click，这份配置与 cordis.patch.yml 的默认值保持一致 */
const PROBE_CONFIG = {
  defaultDelivery: 'background',
  defaultTimeoutMs: 20000,
  stateTimeoutMs: 60000,
  maxElements: 400,
  maxChars: 8000,
  screenshotDir: '~/.dsh/computer-use/shots',
  driverComponentsRoot: '',
  skillRegistered: false,
}

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

function flag(name) {
  return process.argv.includes(`--${name}`)
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let s = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => (s += d))
    process.stdin.on('end', () => resolve(s))
    process.stdin.on('error', reject)
  })
}

async function parseArgs(raw) {
  if (raw === undefined) return {}
  if (raw !== '-') {
    try {
      return JSON.parse(raw)
    } catch (e) {
      console.error(`bad JSON args: ${e.message}`)
      process.exit(2)
    }
  }
  const text = (await readStdin()).trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch (e) {
    console.error(`bad JSON on stdin: ${e.message}`)
    process.exit(2)
  }
}

const [cmd, ...rest] = process.argv.slice(2)
if (!cmd) {
  console.error(
    'usage: mcp-probe.mjs doctor | list [--query=] | describe <tool> | call <tool> <json|-> | windows [--all] | info <pid> | state <pid> <wid> [--query=] [--shot=] | verify <pid> <wid> <json|-> | click-by <pid> <wid> <label> [--role=] [--index=] [--dry]',
  )
  process.exit(2)
}

const found = findDriverExe('')
if (!found.found) {
  console.error(`driver exe not found under ${found.searched}`)
  process.exit(1)
}

const bridge = new DriverBridge({ exe: found.exe, version: found.version, searched: found.searched, timeoutMs: 30000 })

try {
  if (cmd === 'doctor') {
    console.log(`driver: ${found.exe}\nversion: ${found.version}`)
    const tools = await bridge.listTools(true)
    console.log(`mcp: ok · tools: ${tools.length}`)
    const size = await bridge.callTool('get_screen_size', {}, 8000)
    console.log(`screen: ${size.text.split('\n')[0]}`)
    const wins = await bridge.callTool('list_windows', { on_screen_only: true }, 10000)
    console.log(fmtWindows(wins.structured, { hideOverlay: true }))
  } else if (cmd === 'list') {
    const tools = await bridge.listTools(true)
    console.log(fmtTools(tools, arg('query')))
  } else if (cmd === 'describe') {
    const tools = await bridge.listTools(true)
    const t = tools.find((x) => x.name === rest[0])
    if (!t) {
      console.error(`tool not found: ${rest[0]}`)
      process.exit(1)
    }
    console.log(JSON.stringify(t, null, 2))
  } else if (cmd === 'call') {
    const name = rest[0]
    const args = await parseArgs(rest[1])
    const res = await bridge.callTool(name, args, 120000)
    console.log(res.isError ? `[isError]\n${res.text}` : res.text)
    if (res.isError) process.exitCode = 1
  } else if (cmd === 'windows') {
    const payload = { on_screen_only: !flag('all') }
    const res = await bridge.callTool('list_windows', payload, 15000)
    console.log(fmtWindows(res.structured, { hideOverlay: true, limit: 100 }))
  } else if (cmd === 'info') {
    const pid = Number(rest[0])
    const res = await bridge.callTool('debug_window_info', { pid }, 15000)
    console.log(fmtWindowInfo(res.structured))
  } else if (cmd === 'state') {
    const pid = Number(rest[0])
    const windowId = Number(rest[1])
    const payload = { pid, window_id: windowId, include_screenshot: false, timeout_ms: 8000, max_elements: 400 }
    if (arg('query')) payload.query = arg('query')
    if (arg('shot')) payload.screenshot_out_file = arg('shot')
    const res = await bridge.callTool('get_window_state', payload, 60000)
    console.log(fmtState(res.structured, {}))
  } else if (cmd === 'click-by') {
    const pid = Number(rest[0])
    const windowId = Number(rest[1])
    const label = rest[2]
    if (!Number.isFinite(pid) || !Number.isFinite(windowId) || !label) {
      console.error('usage: click-by <pid> <window_id> <label> [--role=Role] [--index=N] [--delivery=foreground] [--dry] [--no-observe]')
      process.exit(2)
    }
    // 以前这里自己实现了一套「匹配 + background 点一下 + 比元素数」，与插件的
    // cu_click 完全不同（无 settle / index / 三级阶梯 / 控件状态复核），排障时
    // 会得出和宿主相反的结论。直接复用插件的工具定义，行为与模型侧一致。
    const args = {
      pid,
      windowId,
      label,
      ...(arg('role') ? { role: arg('role') } : {}),
      ...(arg('index') ? { index: Number(arg('index')) } : {}),
      ...(arg('delivery') ? { deliveryMode: arg('delivery') } : {}),
      dryRun: flag('dry'),
      screenshot: false, // 终端探针不产图，attachments 服务也不在这里
      reobserve: !flag('no-observe'),
    }
    const def = createTools({ bridge, config: PROBE_CONFIG, isEnabled: () => true }).find((t) => t.name === 'cu_click')
    const res = await def.execute(args, {})
    console.log(res.text ?? JSON.stringify(res))
    if (/^✗|拒绝这次点击|很可能没生效/.test(res.text ?? '')) process.exitCode = 1
  } else if (cmd === 'verify') {
    const pid = Number(rest[0])
    const windowId = Number(rest[1])
    const expect = await parseArgs(rest[2])
    const res = await bridge.callTool('verify_state', { pid, window_id: windowId, expect: Array.isArray(expect) ? expect : [expect], timeout_ms: 5000 }, 60000)
    console.log(fmtVerify(res.structured))
  } else {
    console.error(`unknown command: ${cmd}`)
    process.exit(2)
  }
} catch (err) {
  console.error(`ERROR: ${err.message}`)
  process.exitCode = 1
} finally {
  bridge.stop()
  // 不再 200ms 后 process.exit()：stdout 是管道/重定向时大段输出会被直接截断，
  // 驱动也来不及退出。stop() 已关掉 stdio 句柄，让事件循环自然结束并 flush 完日志；
  // 只留一个 unref 的长兜底防极端情况下句柄卡死。
  const guard = setTimeout(() => process.exit(process.exitCode ?? 0), 5000)
  guard.unref?.()
}
