/**
 * 多实例状态隔离。
 *
 * 为什么需要这一层：
 *   同一台机器上可能同时跑多个 dsh/profile/宿主副本，每个进程都会 apply 一次本插件。
 *   旧实现把状态写死在 `~/.dsh/computer-use-pro-status.json`，后加载的实例会整份覆盖，
 *   于是「谁在提供服务」看不出来，冲突也被掩盖成「插件加载了但没效果」。
 *
 * 现在的布局：
 *   `~/.dsh/computer-use-pro-status/instances/<instanceId>.json`  每个实例独占一份（原子写）
 *   `~/.dsh/computer-use-pro-status.json`                          兼容旧路径的聚合视图：
 *     顶层字段仍是「当前实例」的完整状态；`instances` 数组列出扫描到的所有实例
 *     （`alive` 由 pid 存活判断），不依赖读-改-写，因此不会互相覆盖。
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** 死实例状态文件的保留时长；超过后下次写入时清理。 */
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000

export function resolveStatusPaths(baseDir = path.join(homedir(), '.dsh')) {
  const root = path.join(baseDir, 'computer-use-pro-status')
  return {
    root,
    instances: path.join(root, 'instances'),
    legacy: path.join(baseDir, 'computer-use-pro-status.json'),
  }
}

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]+/g, '_') || 'unknown'
}

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  writeFileSync(tmp, text, 'utf8')
  try {
    // Windows 上目标被短暂占用时 rename 会回 EBUSY/EPERM：重试，而不是「先删再 rename」。
    // 删目标会开出一个「文件不存在」的窗口：别的进程读聚合视图时该实例被漏算，
    // 多进程并发写还会互删刚写好的文件 —— 原子写就名存实亡了。
    let lastErr
    // 两个进程同时写聚合视图时，Windows 会在同一个时间片里反复 EBUSY/EPERM。
    // 立即重试 6 次往往 6 次都撞上（实测冒烟测试偶发失败），加同步小退避让另一个
    // 进程先写完；rename 仍是原子的，绝不「先删再建」制造空窗。
    const idle = new Int32Array(new SharedArrayBuffer(4))
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        renameSync(tmp, file)
        return
      } catch (err) {
        lastErr = err
        if (!/EBUSY|EPERM|EEXIST|EACCES/i.test(String(err?.code ?? err))) break
        Atomics.wait(idle, 0, 0, Math.min(2 * (attempt + 1), 16))
      }
    }
    throw lastErr
  } finally {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* tmp 清理失败不影响本次写入结果 */
    }
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/**
 * 为一个插件实例创建状态写入器。
 * @param {{ id: string, pid?: number, profile?: string }} instance 实例标识（id 需在进程内唯一）
 * @param {string} [baseDir] 状态根目录（默认 `~/.dsh`，测试可注入临时目录）
 */
export function createInstanceStatus(instance, baseDir) {
  const paths = resolveStatusPaths(baseDir)
  const id = safeId(instance.id)
  const ownFile = path.join(paths.instances, `${id}.json`)

  function readEntries() {
    let names = []
    try {
      names = readdirSync(paths.instances)
    } catch {
      names = []
    }
    const entries = []
    for (const entryName of names) {
      if (!entryName.endsWith('.json')) continue
      try {
        const entry = JSON.parse(readFileSync(path.join(paths.instances, entryName), 'utf8'))
        entry.alive = pidAlive(Number(entry?.instance?.pid))
        entry.self = entry?.instance?.id === instance.id
        // 已退出的实例不可能还在提供服务：不再把它的 primary 当真，
        // 否则聚合里会同时出现两份 primary（一份 alive:false），「谁在服务」就看不出来了
        if (!entry.alive && entry.role === 'primary') entry.role = 'stale'
        entries.push(entry)
      } catch {
        /* 半截文件（写入中）跳过，下次扫描会补上 */
      }
    }
    return entries.sort((a, b) => String(a?.instance?.id).localeCompare(String(b?.instance?.id)))
  }

  /** 聚合视图：把「谁在真正提供服务」（存活且 primary 的实例）单独列出来。 */
  function aggregateOf(entry, instances) {
    const owners = instances
      .filter((item) => item.alive && item.role === 'primary')
      .map((item) => ({ id: item?.instance?.id ?? null, pid: item?.instance?.pid ?? null }))
    return { ...(entry || {}), instanceCount: instances.length, owners, instances }
  }

  /** 清掉过期实例文件；返回被删掉的实例 id，调用方据此在内存里同步剔除（不必重读目录） */
  function prune(entries) {
    const now = Date.now()
    const removed = new Set()
    for (const entry of entries) {
      if (entry.self || entry.alive) continue
      const file = path.join(paths.instances, `${safeId(entry?.instance?.id)}.json`)
      try {
        if (now - statSync(file).mtimeMs < PRUNE_AFTER_MS) continue
        unlinkSync(file)
        removed.add(entry?.instance?.id)
      } catch {
        /* 清理失败无所谓 */
      }
    }
    return removed
  }

  return {
    id,
    paths,
    instanceFile: ownFile,
    /**
     * 写入本实例状态，并重建聚合视图。
     * @returns {{ ok: boolean, error?: string, instanceFile?: string, legacyFile?: string, instanceCount?: number }}
     */
    write(payload) {
      try {
        mkdirSync(paths.instances, { recursive: true })
        const entry = {
          ...payload,
          instance: { ...instance },
          generatedAt: new Date().toISOString(),
        }
        atomicWrite(ownFile, `${JSON.stringify(entry, null, 2)}\n`)
        // 只扫一次目录：被 prune 删掉的条目在内存里同步剔除，不再重读一遍全部实例文件
        const scanned = readEntries()
        const removed = prune(scanned)
        const instances = removed.size ? scanned.filter((item) => !removed.has(item?.instance?.id)) : scanned
        const aggregate = aggregateOf(entry, instances)
        atomicWrite(paths.legacy, `${JSON.stringify(aggregate, null, 2)}\n`)
        return { ok: true, instanceFile: ownFile, legacyFile: paths.legacy, instanceCount: instances.length }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    /** 实例卸载时删除自己的那份，并刷新聚合视图。 */
    remove() {
      try {
        unlinkSync(ownFile)
      } catch {
        /* 已经不在了就算了 */
      }
      try {
        const instances = readEntries()
        if (!instances.length) {
          rmSync(paths.legacy, { force: true })
          return
        }
        atomicWrite(paths.legacy, `${JSON.stringify(aggregateOf(null, instances), null, 2)}\n`)
      } catch {
        /* 诊断写不进去不影响卸载 */
      }
    },
  }
}
