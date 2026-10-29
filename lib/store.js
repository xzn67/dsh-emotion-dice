// 落盘那一层：读情绪状态、加载/追加历史、写满轮转。
// 单独拆出来是为了能脱离宿主 ctx 测——文件坏了、路径怪、历史长得离谱，都得扛住。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { countHabits } from './dice.js'

export const HOME = homedir().replace(/\\/g, '/')
export const DEFAULT_EMOTION = join(HOME, '.dsh', 'storages', 'emotion.json')
export const DEFAULT_HISTORY = join(HOME, '.dsh', 'storages', 'emotion-dice.jsonl')

/** 数字兜底：非有限值 / 越界都拉回区间，别让 NaN 渗进概率。 */
export function num(v, def, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  if (n < min) return min
  if (n > max) return max
  return n
}

/** 读 dsh-emotion 的当前状态。读不到 → 全 0（只有不看心情的行为可能命中）。
 *  返回的 valence/intensity 一定落在 [-1,1] / [0,1]。 */
export function readEmotion(path) {
  const zero = { valence: 0, intensity: 0, label: '', ok: false }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const cur = raw?.tables?.state?.current
    if (!cur || typeof cur !== 'object') return zero
    return {
      valence: num(cur.valence, 0, -1, 1),
      intensity: num(cur.intensity, 0, 0, 1),
      label: String(cur.label ?? '').slice(0, 16),
      ok: true,
    }
  } catch {
    return zero
  }
}

/** 从历史文件统计各条做过多少次。文件不存在 / 半截行 / 非 JSON 都不抛。 */
export function loadHabits(path) {
  try {
    const raw = readFileSync(path, 'utf8')
    const rows = []
    for (const line of raw.split('\n')) {
      if (!line) continue
      try { rows.push(JSON.parse(line)) } catch { /* 半截行跳过 */ }
    }
    return countHabits(rows)
  } catch {
    return {}
  }
}

/** 追加一行；超过 maxBytes 就把文件轮转一半（只留后一半）。
 *  写失败不抛——历史绝不能连累主流程。返回是否发生了轮转。 */
export function appendRecord(path, row, maxBytes = 2 * 1024 * 1024) {
  try {
    const dir = dirname(path)
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true })
    appendFileSync(path, JSON.stringify(row) + '\n', 'utf8')
    let size = 0
    try { size = statSync(path).size } catch { return false }
    if (size <= maxBytes) return false
    const raw = readFileSync(path, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const keep = lines.slice(-Math.max(1, Math.floor(lines.length / 2)))
    const tmp = `${path}.tmp`
    writeFileSync(tmp, keep.join('\n') + '\n', 'utf8')
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

export function fileSize(path) {
  try {
    return existsSync(path) ? statSync(path).size : 0
  } catch {
    return 0
  }
}
