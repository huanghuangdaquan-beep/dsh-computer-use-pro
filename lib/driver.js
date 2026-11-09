/**
 * lib/driver.js — 电脑操控驱动（cua-driver）发现 + 常驻 MCP stdio 客户端
 *
 * 事实基线（本机实测，2026-11）：
 *   - 驱动二进制在 `~/.minimax/computer-use/components/<ver>/win32-x64/<sha256>/minimax-computer-use.exe`
 *   - 传 `mcp` 参数即起一个 MCP stdio server（direct runtime），**不经过**被安全策略
 *     拦下的命名管道；协议 2024-11-05，tools/list 回来 59 个工具。
 *   - 每个工具调用都要重新起进程的话，冷启动约 1s，且每次 get_window_state 的
 *     snapshot 序列都要重建 —— 所以这里做成**常驻子进程 + 空闲超时回收**。
 *
 * 设计约束：
 *   1. 绝不能在模块加载期 spawn（插件被加载但没人用桌面控制时不该有副作用）。
 *   2. 绝不能因为驱动缺席/崩溃而让插件加载失败 —— 所有失败都变成可读的错误文本。
 *   3. 超时必须杀掉子进程重来：卡住的驱动会毒化后续所有调用。
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** 驱动组件根（MiniMax Code 的组件安装器写这里） */
export const DRIVER_COMPONENTS_ROOT = path.join(homedir(), '.minimax', 'computer-use', 'components')

/** 兜底路径（扫描失败时的最后尝试，版本会被下面的扫描覆盖） */
const EXE_BASENAME = 'minimax-computer-use.exe'

/**
 * 展开配置路径里的 %VAR% / $VAR / ${VAR} 与 ~/ 前缀。
 * Windows 上写 `%LOCALAPPDATA%\...` 是常态；不展开就会静默退回自动探测，
 * 排查时完全看不出「我明明配了 driverPath」。
 */
function expandPathText(input) {
  let s = String(input ?? '').trim()
  s = s.replace(/%([A-Za-z_][\w]*)%/g, (_m, k) => process.env[k] ?? '')
  s = s.replace(/\$\{([A-Za-z_][\w]*)\}|\$([A-Za-z_][\w]*)/g, (_m, a, b) => process.env[a ?? b] ?? '')
  // 只展开「~ 本身 / ~/ / ~\」；`~somebody` 不是本用户主目录，别硬拼
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(homedir(), s.slice(1))
  return s
}

/**
 * 进程退出兜底：宿主异常退出时不会调用 disposer，常驻驱动会变成孤儿，
 * 而 stdio 是活跃 libuv handle，会拖住 Node 不能自然结束。
 * 模块级只注册一次（同进程多份插件副本不会叠加 listener）；exit 相位只能做同步操作。
 */
const LIVE_PROCS = new Set()
let exitHookInstalled = false
function trackProc(proc) {
  LIVE_PROCS.add(proc)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const p of LIVE_PROCS) {
      try {
        p.kill?.()
      } catch {
        /* exit 相位不能再抛 */
      }
      for (const stream of [p.stdin, p.stdout, p.stderr]) {
        try {
          stream?.destroy?.()
        } catch {
          /* 同上 */
        }
      }
    }
    LIVE_PROCS.clear()
  })
}
function untrackProc(proc) {
  LIVE_PROCS.delete(proc)
}

/** 版本号比较：0.34.1 < 0.35.0；非数字段按字典序兜底 */
function compareVersion(a, b) {
  const pa = a.split(/[.\-_]/)
  const pb = b.split(/[.\-_]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i])
    const nb = Number(pb[i])
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb
      continue
    }
    const sa = String(pa[i] ?? '')
    const sb = String(pb[i] ?? '')
    if (sa !== sb) return sa < sb ? -1 : 1
  }
  return 0
}

/** 在一个 arch 目录下找一个可执行文件（<sha>/minimax-computer-use.exe 或直接躺平） */
function findExeUnder(archDir) {
  const direct = path.join(archDir, EXE_BASENAME)
  if (existsSync(direct)) return direct
  let subs = []
  try {
    subs = readdirSync(archDir, { withFileTypes: true })
  } catch {
    return ''
  }
  for (const sub of subs) {
    if (!sub.isDirectory()) continue
    const candidate = path.join(archDir, sub.name, EXE_BASENAME)
    if (existsSync(candidate)) return candidate
  }
  return ''
}

/**
 * 定位驱动可执行文件。
 * @param {string} override 配置里的 driverPath：可以是 exe 本身，也可以是目录
 * @returns {{exe: string, version: string, found: boolean, searched: string}}
 */
export function findDriverExe(override, logger) {
  const searched = DRIVER_COMPONENTS_ROOT
  // 非 win32 上不再「静默扫一圈什么也找不到」：直接把结论交给体检与错误文本
  const platformNote =
    process.platform !== 'win32'
      ? `当前平台 ${process.platform}/${process.arch}；上游只发布 win32 payload，除非 driverPath 指向可执行的本地构建，否则桌面操控不可用`
      : ''

  if (override) {
    const dir = expandPathText(override)
    try {
      const st = statSync(dir)
      if (st.isFile()) {
        const hit = { exe: dir, version: 'custom', found: true }
        return { ...hit, searched, candidates: [hit], platformNote }
      }
      // 目录：先看直接子文件，再按版本降序扫
      const direct = path.join(dir, EXE_BASENAME)
      if (existsSync(direct)) {
        const hit = { exe: direct, version: 'custom', found: true }
        return { ...hit, searched, candidates: [hit], platformNote }
      }
      const hits = scanVersions(dir)
      if (hits.length) return { ...hits[0], searched: dir, candidates: hits, platformNote }
      logger?.warn?.(`[computer-use] driverPath 指向的目录里没有 ${EXE_BASENAME}：${dir}（退回自动探测）`)
    } catch (err) {
      // 显式配置无效必须留痕，否则「配了等于没配」在排查时完全看不出来
      logger?.warn?.(`[computer-use] 配置的 driverPath 不可用（退回自动探测）：${dir} — ${err instanceof Error ? err.message : err}`)
    }
  }

  const hits = scanVersions(DRIVER_COMPONENTS_ROOT)
  if (hits.length) return { ...hits[0], searched, candidates: hits, platformNote }
  return { exe: '', version: '', found: false, searched, candidates: [], platformNote }
}

/**
 * 按版本降序收集**所有**候选 `<root>/<ver>/<arch>/<sha>/minimax-computer-use.exe`。
 * 返回数组而不是「第一个命中」：最高版本的 exe 损坏 / 无法启动时，DriverBridge
 * 可以自动回退到次新版本，而不是让整套桌面控制挂掉。
 */
function scanVersions(root) {
  if (!existsSync(root)) return []
  let versions = []
  try {
    versions = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort(compareVersion)
      .reverse()
  } catch {
    return []
  }
  const hits = []
  for (const v of versions) {
    for (const arch of ['win32-x64', 'win32-arm64', 'darwin-arm64', 'darwin-x64', 'linux-x64']) {
      const archDir = path.join(root, v, arch)
      if (!existsSync(archDir)) continue
      const exe = findExeUnder(archDir)
      if (exe) hits.push({ exe, version: v, found: true, arch })
    }
  }
  return hits
}

/** 一次请求的失败原因分类，模型据此决定下一步 */
export class DriverError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'DriverError'
    this.code = code || 'DRIVER_ERROR'
  }
}

const PROTOCOL_VERSION = '2024-11-05'

/**
 * 只有这些「读 / 幂等」工具允许在链路级失败（子进程退出、超时、重启）后自动补一次。
 * 动作类一律不重试：驱动可能已经执行成功、只是回包丢了，重投会造成重复点击/重复输入。
 */
const IDEMPOTENT_TOOLS = new Set([
  'list_windows', 'get_window_state', 'debug_window_info', 'verify_state', 'get_screen_size',
  'list_apps', 'get_desktop_state', 'get_cursor_position', 'get_agent_cursor_state',
  'get_session', 'get_session_state', 'get_config', 'get_accessibility_tree',
  'health_report', 'check_permissions', 'clipboard_read', 'get_browser_state',
  'get_recording_state', 'list_sessions', 'check_for_update', 'parse_visual_regions', 'zoom',
])

/**
 * 常驻 MCP stdio 客户端。
 *
 * 只做三件事：握手、转发 tools/call、缓存 tools/list。
 * 并发调用串行化（同一个子进程上并发写 stdin 会让快照语义错乱）。
 */
export class DriverBridge {
  constructor({ exe, version, searched, candidates = [], platformNote = '', timeoutMs = 20000, idleShutdownMs = 120000, logger = null, spawnImpl = spawn } = {}) {
    this.exe = exe
    this.version = version || ''
    this.searched = searched || DRIVER_COMPONENTS_ROOT
    this.platformNote = platformNote
    this.candidates = Array.isArray(candidates) && candidates.length ? candidates : exe ? [{ exe, version: this.version }] : []
    this.exeIndex = Math.max(0, this.candidates.findIndex((c) => c?.exe === exe))
    this.restarts = 0
    this.failureStreak = 0
    this.cooldownUntil = 0
    this.timeoutMs = timeoutMs
    this.idleShutdownMs = idleShutdownMs
    this.logger = logger
    // 仅供测试注入假子进程；生产路径永远是 node:child_process 的 spawn
    this.spawnImpl = spawnImpl

    this.proc = null
    this.buf = ''
    this.stderrTail = ''
    this.pending = new Map()
    this.nextId = 1
    this.ready = null
    this.queue = Promise.resolve()
    this.idleTimer = null
    this.toolsCache = null
    this.calls = 0
    /** 调用可观测性：累计统计，stop() 不清空（重启子进程不该抹掉历史） */
    this.stats = { calls: 0, errors: 0, timeouts: 0, totalMs: 0, maxMs: 0, lastMs: 0 }
    this.startedAt = 0
    /** 会话代际：每次 start/stop 递增，旧子进程的回调据此作废（否则会打到新会话） */
    this.session = 0
  }

  get running() {
    return this.proc !== null && this.proc.exitCode === null
  }

  /**
   * 当前 exe 起不来时切到下一个候选（按版本降序）。返回是否真的换了一个。
   * 只换 exe，不动累计统计与队列；调用方负责重新走一遍 start()。
   */
  _nextCandidate() {
    if (this.exeIndex + 1 >= this.candidates.length) return false
    this.exeIndex += 1
    const next = this.candidates[this.exeIndex]
    this.exe = next?.exe || this.exe
    this.version = next?.version || this.version
    this.restarts += 1
    this.logger?.warn?.(`[computer-use] 驱动启动失败，回退到候选 ${this.exeIndex + 1}/${this.candidates.length}：${this.exe}`)
    return true
  }

  /** 建立连接（幂等）。失败会把 proc 清干净，必要时自动回退到次新版本。 */
  async start() {
    if (this.ready) return this.ready
    if (!this.exe) throw new DriverError(`未找到电脑操控驱动（minimax-computer-use.exe）${this.platformNote ? ` · ${this.platformNote}` : ''}`, 'EXE_NOT_FOUND')
    if (!existsSync(this.exe)) {
      if (this._nextCandidate()) return this.start()
      throw new DriverError(`驱动可执行文件不存在：${this.exe}${this.platformNote ? ` · ${this.platformNote}` : ''}`, 'EXE_NOT_FOUND')
    }

    this.buf = ''
    this.stderrTail = ''
    // 防御：新会话不能继承旧会话残留的在途请求，否则它们的响应会被算到新会话头上
    this._rejectAll(new DriverError('驱动连接已重启', 'RESTARTED'))
    const session = ++this.session
    let proc
    try {
      proc = this.spawnImpl(this.exe, ['mcp'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      // spawn 也可能**同步**抛（路径非法 / 部分 Node 版本上的 EACCES）。
      // proc.on('error') 那条分支只覆盖异步失败；这里若不清 ready / pending，
      // 后续所有调用都会卡在「正在启动」的假状态上。
      const message = err instanceof Error ? err.message : String(err)
      this.ready = null
      this.proc = null
      this.toolsCache = null
      this._rejectAll(new DriverError(`驱动子进程无法启动：${message}`, 'SPAWN_FAILED'))
      if (this._nextCandidate()) return this.start()
      throw new DriverError(`驱动子进程无法启动：${message}`, 'SPAWN_FAILED')
    }
    trackProc(proc)
    this.proc = proc
    this.startedAt = Date.now()

    // 管道读/写端在驱动被杀或退出时都会异步 emit error（Windows 上是 EOF/EPIPE）。
    // 没有监听者的 'error' 会直接抛成 uncaughtException —— 那会把宿主一起带走。
    const onStreamError = (stream) => (err) => {
      if (this.session !== session) return
      const code = err?.code ?? (err instanceof Error ? err.message : String(err))
      this.logger?.warn?.(`[computer-use] 驱动 ${stream} 出错：${code}`)
    }
    proc.stdin.on('error', onStreamError('stdin'))
    proc.stdout.on('error', onStreamError('stdout'))
    proc.stderr.on('error', onStreamError('stderr'))

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      if (this.session !== session) return
      this._onData(chunk)
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => {
      if (this.session !== session) return
      this.stderrTail = (this.stderrTail + chunk).slice(-4000)
    })
    proc.on('exit', (code, signal) => {
      // 无论是不是当前会话，进程已经没了，都要从退出兜底集合里摘掉
      untrackProc(proc)
      // 旧会话的退出事件不能清掉新会话的状态（超时杀进程后立刻重启就会碰上）
      if (this.session !== session) return
      const wasReady = this.ready !== null
      this.proc = null
      this.ready = null
      this.toolsCache = null
      this._rejectAll(new DriverError(`驱动子进程退出（code=${code}${signal ? ` signal=${signal}` : ''}）`, 'EXITED'))
      if (wasReady) this.logger?.warn?.(`[computer-use] 驱动进程退出 code=${code}`)
    })
    proc.on('error', (err) => {
      if (this.session !== session) return
      this.toolsCache = null
      // 不能在这里把 this.proc 提前置空：_handshake().catch 里的 stop() 需要它来 end/kill，
      // 否则 spawn 失败时已创建的 stdio 句柄没人回收（还可能拖住进程退出）。
      this._rejectAll(new DriverError(`驱动子进程无法启动：${err.message}`, 'SPAWN_FAILED'))
      this.stop()
    })

    this.ready = this._handshake().catch((err) => {
      this.ready = null
      this.stop()
      // 握手失败（exe 损坏 / 版本不兼容 / 架构不对）也走版本回退
      if (this._nextCandidate()) return this.start()
      throw err
    })
    return this.ready
  }

  async _handshake() {
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-computer-use-pro', version: '0.3.6' },
    })
    this.notify('notifications/initialized', {})
  }

  _rejectAll(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    this.pending.clear()
  }

  _onData(chunk) {
    this.buf += chunk
    if (this.buf.length > 64 * 1024 * 1024) {
      // 防御：驱动吐了异常大的东西，别把宿主内存吃干
      this.buf = ''
      this._rejectAll(new DriverError('驱动输出超过 64MB，已断开会话', 'OVERSIZE'))
      this.stop()
      return
    }
    let idx
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue // 驱动的非 JSON 噪声
      }
      // 必须确认这是「响应」而不是服务端发起的请求：MCP 服务端也可能发带 id 的请求
      // （roots/list 等），id 撞上在途请求时会被误 resolve，真响应反而丢了 → 超时重启。
      const isResponse = msg && (Object.hasOwn(msg, 'result') || Object.hasOwn(msg, 'error'))
      if (isResponse && msg.id !== undefined && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        clearTimeout(entry.timer)
        if (msg.error) {
          const detail = typeof msg.error === 'object' ? JSON.stringify(msg.error) : String(msg.error)
          entry.reject(new DriverError(`驱动返回错误：${detail}`, 'RPC_ERROR'))
        } else {
          entry.resolve(msg.result)
        }
      }
    }
  }

  /** 底层请求：不做串行化，供 start() 内部使用 */
  request(method, params, timeoutMs) {
    if (!this.proc) {
      return Promise.reject(new DriverError('驱动连接不存在', 'NOT_STARTED'))
    }
    const id = this.nextId++
    const payload = { jsonrpc: '2.0', id, method, params: params ?? {} }
    const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.timeoutMs

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        // 卡住的驱动不能再复用：杀掉，下一次调用重新起一份干净的
        this.stats.timeouts += 1
        this.stop()
        reject(new DriverError(`调用 ${method} 超时（${ms}ms），已重启驱动进程`, 'TIMEOUT'))
      }, ms)
      if (typeof timer.unref === 'function') timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.proc.stdin.write(`${JSON.stringify(payload)}\n`)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new DriverError(`向驱动写入失败：${err.message}`, 'WRITE_FAILED'))
      }
    })
  }

  notify(method, params) {
    try {
      this.proc?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} })}\n`)
    } catch {
      /* 通知丢了不影响调用结果 */
    }
  }

  /** 串行执行一段用到驱动的逻辑 */
  serial(fn) {
    const run = this.queue.then(fn, fn)
    this.queue = run.then(
      () => {},
      () => {},
    )
    return run
  }

  /** 列出原生工具（缓存；force=true 重新拉） */
  async listTools(force = false) {
    if (this.toolsCache && !force) return this.toolsCache
    return this.serial(async () => {
      if (this.toolsCache && !force) return this.toolsCache
      await this.start()
      try {
        const res = await this.request('tools/list', {}, Math.max(this.timeoutMs, 15000))
        this.toolsCache = Array.isArray(res?.tools) ? res.tools : []
        return this.toolsCache
      } finally {
        this._touch()
      }
    })
  }

  /**
   * 调用一个原生工具。
   * @returns {{structured: object, text: string, isError: boolean, raw: object}}
   */
  async callTool(name, args = {}, timeoutMs, _retried = false) {
    if (!name) throw new DriverError('缺少工具名', 'BAD_ARGS')
    const now = Date.now()
    if (now < this.cooldownUntil) {
      throw new DriverError(
        `驱动连续失败 ${this.failureStreak} 次，${Math.ceil((this.cooldownUntil - now) / 1000)}s 内暂停调用（防止模型无限重试）；稍后再试或先 cu_doctor`,
        'CIRCUIT_OPEN',
      )
    }
    const started = Date.now()
    if (!_retried) {
      this.stats.calls += 1
      this.calls += 1
    }
    try {
      const result = await this.serial(async () => {
        await this.start()
        let res
        try {
          res = await this.request('tools/call', { name, arguments: args ?? {} }, timeoutMs)
        } finally {
          this._touch()
        }
        const content = Array.isArray(res?.content) ? res.content : []
        const texts = []
        let imageBytes = 0
        for (const item of content) {
          if (item?.type === 'text') texts.push(String(item.text ?? ''))
          else if (item?.type === 'image') {
            const b64 = String(item.data ?? '')
            imageBytes += b64.length
            texts.push(`<image ${item.mimeType ?? 'image/png'} ~${Math.round((b64.length * 3) / 4 / 1024)}KB>`)
          } else if (item) texts.push(JSON.stringify(item))
        }
        const structured = res?.structuredContent && typeof res.structuredContent === 'object' ? res.structuredContent : null
        if (!texts.length && structured) texts.push(JSON.stringify(structured, null, 2))
        const isError = res?.isError === true
        if (isError) this.stats.errors += 1
        return {
          structured,
          text: texts.join('\n').trim(),
          isError,
          imageBytes,
          raw: res,
        }
      })
      this.failureStreak = 0
      this.cooldownUntil = 0
      return result
    } catch (err) {
      // RPC 层抛错（超时 / 子进程退出 / spawn 失败）也要计入，否则体检里的
      // 「失败次数」永远只反映驱动自报的 isError。
      this.stats.errors += 1
      this.failureStreak += 1
      const transient = ['EXITED', 'SPAWN_FAILED', 'NOT_STARTED', 'STOPPED', 'RESTARTED', 'TIMEOUT'].includes(err?.code)
      // 只读 / 幂等工具：子进程挂了就重启后自动补一次。
      // 动作类（click / press_key / type_text / drag…）**绝不重试** —— 重投会把
      // toggle 点回去、把文本输两遍，比失败一次更糟。
      if (!_retried && transient && IDEMPOTENT_TOOLS.has(name)) {
        this.stop()
        return this.callTool(name, args, timeoutMs, true)
      }
      if (this.failureStreak >= 5) {
        this.cooldownUntil = Date.now() + 30000
        this.logger?.warn?.(`[computer-use] 驱动连续失败 ${this.failureStreak} 次，熔断 30 秒`)
      }
      throw err
    } finally {
      const ms = Date.now() - started
      this.stats.lastMs = ms
      this.stats.totalMs += ms
      if (ms > this.stats.maxMs) this.stats.maxMs = ms
    }
  }

  _touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (!this.idleShutdownMs || this.idleShutdownMs <= 0) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.pending.size === 0) this.stop()
    }, this.idleShutdownMs)
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref()
  }

  stop() {
    // 作废旧会话的全部回调：旧子进程随后的 exit / data / error 不能再碰新会话
    this.session += 1
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    const proc = this.proc
    this.proc = null
    if (proc) untrackProc(proc)
    this.ready = null
    this.toolsCache = null
    this._rejectAll(new DriverError('驱动连接已关闭', 'STOPPED'))
    if (!proc) return
    try {
      proc.stdin.end()
    } catch {
      /* 已经关了 */
    }
    try {
      proc.kill()
    } catch {
      /* 已经死了 */
    }
  }

  /** 诊断快照：给 cu_doctor 用 */
  describe() {
    return {
      exe: this.exe,
      version: this.version,
      searched: this.searched,
      running: this.running,
      pid: this.proc?.pid ?? null,
      calls: this.calls,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      stderrTail: this.stderrTail.trim(),
      stats: {
        ...this.stats,
        avgMs: this.stats.calls ? Math.round(this.stats.totalMs / this.stats.calls) : 0,
      },
      exeIndex: this.exeIndex,
      candidatesCount: this.candidates.length,
      restarts: this.restarts,
      failureStreak: this.failureStreak,
      cooldownMs: Math.max(0, this.cooldownUntil - Date.now()),
      platformNote: this.platformNote,
    }
  }
}
