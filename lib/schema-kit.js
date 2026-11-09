/**
 * lib/schema-kit.js — 韧性 Schemastery 解析
 *
 * `export const Config = Schema.object({...})` 里如果 `Schema` 来自顶层静态
 * import，那么官方包不可解析时插件会在**模块链接阶段**整体炸掉。
 *
 * cordis 用 `Config['~standard'].validate(raw)` 校验插件配置：
 * - 拿到真正的 Schemastery Schema → 配置受 schema 校验，Settings 面板按其自动生成；
 * - 拿不到 → 导出 `undefined`，cordis 视为「无 schema」，把 patch config 原样透传
 *   （apply() 里已对每个 key 用 `??` 兜默认值，功能不受影响）。
 *
 * 绝不能用「长得像 JSON Schema 的普通对象」冒充 Config：它没有 `~standard`，
 * 启动时抛 `Cannot read properties of undefined (reading 'validate')`，
 * 插件同样「加载了但 apply() 不跑」。
 */

let Schema = null
let source = 'none'
let loadError = ''

try {
  const mod = await import('@deepseek-ai/schemastery')
  const candidate = mod?.default ?? mod
  if (candidate && typeof candidate.object === 'function') {
    Schema = candidate
    source = 'schemastery'
  } else {
    loadError = 'module loaded but does not expose object()'
  }
} catch (err) {
  loadError = err instanceof Error ? err.message.split('\n')[0] : String(err)
}

/** `'schemastery'` 或 `'none'` */
export const SCHEMA_SOURCE = source
/** 无法使用官方包的原因（可用时为空串；构造 Config 失败时会被补上） */
export let SCHEMA_ERROR = loadError

/** Schemastery 命名空间（不可用时为 null） */
export { Schema }

/**
 * 用给定工厂构造 Config；Schema 不可用时返回 undefined。
 * @param build (Schema) => object  仅在 Schema 可用时被调用
 */
export function buildConfig (build) {
  if (!Schema) return undefined
  try {
    return build(Schema)
  } catch (err) {
    // 官方包能 import 但版本残缺（缺 natural()/volatile() 等扩展）时，
    // 这个异常发生在模块求值期，不 catch 会让整个插件加载失败 —— 比「拿不到包」更糟。
    // 退回「无 schema」降级路径：cordis 原样透传 patch config，apply() 里仍有默认值兜底。
    SCHEMA_ERROR = `schema build failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`
    return undefined
  }
}
