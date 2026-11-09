/**
 * lib/tool-kit.js — 韧性 `defineTool` 解析
 *
 * 顶层静态 `import { defineTool } from '@deepseek-ai/dsh-tools'` 会在该裸标识符
 * 不可解析时让整个插件在**模块链接阶段**就抛错（早于 `apply()`），结果是
 * 「插件看着加载了，但一个工具都没有」。profile 的 pnpm 布局会把 peer 依赖
 * 留在 store 外，甚至出现 dsh-tools 自身 import 的 `@deepseek-ai/dsh-scope`
 * 在 profile 里根本不存在的情况。
 *
 * 工具注册表只需要一个普通 ToolDefinition 对象，官方包只是便利品而非必需：
 * 用动态 import（可 catch）尝试，失败则回退到同 DSL 的本地实现。
 */

const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']

/** 把一个 author-facing value schema 节点编译成 raw JSON Schema */
function compileValue (spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError('value schema node must be an object')
  }
  const node = {}
  for (const key of ANNOTATION_KEYS) if (Object.hasOwn(spec, key)) node[key] = spec[key]
  if (Object.hasOwn(spec, 'oneOf')) {
    node.oneOf = spec.oneOf.map(compileValue)
    return node
  }
  // `json` 是 author-only 节点 = 任意 JSON 值 → 只留注解（annotation-only schema）
  if (spec.type === 'json') return node
  if (spec.type === 'object' || Object.hasOwn(spec, 'properties')) {
    const { properties, required } = compilePropertyMap(spec.properties ?? {})
    node.type = 'object'
    node.properties = properties
    if (required.length > 0) node.required = required
    node.additionalProperties = spec.additionalProperties ?? true
    return node
  }
  if (spec.type === 'array') {
    node.type = 'array'
    if (Object.hasOwn(spec, 'items')) node.items = compileValue(spec.items)
    return node
  }
  if (Object.hasOwn(spec, 'type')) node.type = spec.type
  for (const key of ['enum', 'const']) if (Object.hasOwn(spec, key)) node[key] = spec[key]
  return node
}

/** 编译隐式参数表，收集 `required: true` 标记 */
function compilePropertyMap (map) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(map)) {
    if (spec && typeof spec === 'object' && spec.required === true) required.push(key)
    properties[key] = compileValue(spec)
  }
  return { properties, required }
}

/** 官方包不可用时的本地 defineTool（同 DSL，含最小参数校验） */
function shimDefineTool (options) {
  const { properties, required } = compilePropertyMap(options.parameters ?? {})
  const parameters = { type: 'object', properties, additionalProperties: true }
  if (required.length > 0) parameters.required = required
  const outputSchema = compileValue(options.output.schema)
  const render = options.output.render
  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render (args, value) { return render(args, value) }
    },
    async execute (args, exec) { return options.execute(args ?? {}, exec) }
  }
  if (options.deferLoading === true) tool.deferLoading = true
  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs
  return tool
}

let realDefineTool = null
let source = 'shim'
let loadError = ''
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  // CJS 互操作下 defineTool 可能挂在 default 上；只认具名导出会静默降级到 shim，
  // 与「配置走官方 schema、工具走本地 shim」的割裂状态就来自这里。
  const candidate = mod?.defineTool ?? mod?.default?.defineTool
  if (typeof candidate === 'function') {
    realDefineTool = candidate
    source = 'dsh-tools'
  } else {
    loadError = 'module loaded but does not export defineTool()'
  }
} catch (err) {
  loadError = err instanceof Error ? err.message.split('\n')[0] : String(err)
}

/** 当前用的是哪个实现：`'dsh-tools'` 或 `'shim'` */
export const TOOL_KIT_SOURCE = source
/** 无法使用官方包的原因（可用时为空串） */
export const TOOL_KIT_ERROR = loadError

/** `defineTool` — 能 import 官方包就用官方的，否则用本地等价实现 */
export function defineTool (options) {
  return realDefineTool ? realDefineTool(options) : shimDefineTool(options)
}
