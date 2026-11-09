/**
 * lib/skill.js — 把定位规程注册成 DSH 运行时技能
 *
 * 宿主 `@deepseek-ai/dsh-skill` 契约（以 app.asar 内 dsh-skill/lib/index.js 为准）：
 *   - `skills.register(skill)`：runtime 层技能（rank 250），验收只查 name(kebab-case) /
 *     description / invocation；但真正 `get()` 加载时 `validateDefinition` 还要求
 *     `source`(string) / `provider`(string) / `content`(string) —— 少一个就「catalog 里
 *     看得到、加载必失败」。所以这里把四个字段全给齐。
 *   - `skills.registerProvider(create)`：provider 层，验收更严（provider 名必须与
 *     registration 一致、rank 必须是有限数字），留作旧宿主的兜底。
 *
 * 所有 IO fail-soft：技能缺席不能拖垮插件加载（工具仍然可用）。
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const SKILL_NAME = 'computer-use-pro'

/** 极简 frontmatter 解析：只认顶层 `key: value` */
export function parseFrontmatter(text) {
  const source = String(text ?? '')
  if (!source.startsWith('---')) return { meta: {}, body: source }
  const end = source.indexOf('\n---', 3)
  if (end === -1) return { meta: {}, body: source }
  const head = source.slice(3, end)
  const meta = {}
  for (const line of head.split('\n')) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (m) meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  const body = source.slice(end + 4).replace(/^\s*\n/, '')
  return { meta, body }
}

/** 把正文里的包内相对路径改写成绝对路径（模型拿到的就是能直接读的路径） */
function adaptPaths(body, pluginRoot) {
  const refDir = path.join(pluginRoot, 'skills', SKILL_NAME, 'references')
  return body.replace(/(^|[\s(（`])(references\/[\w./-]+)/gm, (_all, lead, rel) => `${lead}${path.join(refDir, rel.replace(/^references\//, ''))}`)
}

function appendix(pluginRoot, screenshotDir) {
  // 配置里改了 screenshotDir，技能正文也得跟着改 —— 硬编码默认值会让模型
  // 拿着一个不存在的路径去复现截图。
  const shotDir = String(screenshotDir ?? '').trim() || '~/.dsh/computer-use/shots'
  return `

---

## DSH 运行时附录（dsh-computer-use-pro 自动追加）

- 资源：参考证据 \`${path.join(pluginRoot, 'skills', SKILL_NAME, 'references', 'grounding-evidence.md')}\`
- 独立命令行探针（不依赖宿主）：\`node ${path.join(pluginRoot, 'scripts', 'mcp-probe.mjs')} list | call <tool> -\`
- 截图落盘目录：\`${shotDir}\`（插件设置 \`screenshotDir\` 的当前值）
- 驱动路径可用插件设置里的 \`driverPath\` 覆盖（默认自动扫
  \`~/.minimax/computer-use/components/<版本>/<arch>/<sha>/minimax-computer-use.exe\`）
`
}

/** 构建 register 载荷；screenshotDir 省略时回落到插件默认值（测试可三参数调用） */
export function buildSkill(pluginRoot, screenshotDir) {
  const dir = path.join(pluginRoot, 'skills', SKILL_NAME)
  const file = path.join(dir, 'SKILL.md')
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  const { meta, body } = parseFrontmatter(text)
  const description = meta.description || ''
  if (!description) return null
  const name = meta.name || SKILL_NAME
  const content = adaptPaths(body, pluginRoot) + appendix(pluginRoot, screenshotDir)
  return {
    name,
    description,
    source: 'dsh-computer-use-pro',
    // register() 主分支在真正 get() 时会跑 validateDefinition，缺 provider 会变成
    // 「catalog 里看得到、加载必失败」；registerProvider 兜底分支是一直补了的。
    provider: 'dsh-computer-use-pro',
    content,
    resourceBase: { kind: 'directory', path: dir },
    invocation: { modelInvocable: true, userInvocable: true },
  }
}

/**
 * 注册技能。返回 disposer 或 null（服务缺席 / 注册失败）。
 * 注意：注册失败只记日志，不影响工具注册。
 */
export function registerSkill(registry, pluginRoot, logger, screenshotDir) {
  if (!registry) {
    logger?.warn?.('[computer-use] 宿主没有 skills 服务，技能未注册（工具不受影响）')
    return null
  }
  let skill = null
  try {
    skill = buildSkill(pluginRoot, screenshotDir)
  } catch (err) {
    logger?.warn?.(`[computer-use] 读 SKILL.md 失败：${err.message}`)
    return null
  }
  if (!skill) {
    logger?.warn?.('[computer-use] SKILL.md 缺失或缺 description，技能未注册')
    return null
  }

  if (typeof registry.register === 'function') {
    try {
      return registry.register(skill)
    } catch (err) {
      logger?.warn?.(`[computer-use] skills.register 失败：${err.message}`)
    }
  }

  if (typeof registry.registerProvider === 'function') {
    try {
      const file = path.join(pluginRoot, 'skills', SKILL_NAME, 'SKILL.md')
      return registry.registerProvider(() => ({
        name: 'dsh-computer-use-pro',
        async list() {
          return [
            {
              name: skill.name,
              description: skill.description,
              invocation: skill.invocation,
              source: skill.source,
              provider: 'dsh-computer-use-pro',
              rank: 250,
              locator: { path: file },
              path: file,
              resourceBase: skill.resourceBase,
            },
          ]
        },
        async get() {
          const fresh = buildSkill(pluginRoot, screenshotDir)
          return { ...fresh, provider: 'dsh-computer-use-pro' }
        },
      }))
    } catch (err) {
      logger?.warn?.(`[computer-use] skills.registerProvider 失败：${err.message}`)
    }
  }

  logger?.warn?.('[computer-use] 宿主 skills 服务没有任何可用注册方法，技能未注册')
  return null
}
