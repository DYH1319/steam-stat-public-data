// history 分支的格式：每天采样在线人数，按月分片，只追加。
// 格式改动要同时改后端仓 Core 的 PublicData/PlayerHistory.cs，并保持对已发布客户端的兼容。

import fs from 'node:fs'
import path from 'node:path'
import { sha256, stableStringify } from './format.mjs'

export const INDEX_FORMAT = 'steam-stat-public-data/players-index'
export const SHARD_FORMAT = 'steam-stat-public-data/players'
export const VERSION = 1
export const SHARD_COUNT = 16
export const MAX_INDEX_BYTES = 2 * 1024 * 1024
export const MAX_SHARD_BYTES = 4 * 1024 * 1024
/** 覆盖多少款。工作区每年增长约 2000 × 365 × 7 字节，jsDelivr 的包上限是 50 MB，这个数能用十年。 */
export const DEFAULT_LIMIT = 2000

export const historyShardOf = appId => (Number(appId) % SHARD_COUNT).toString(16)

export const monthOf = date => date.toISOString().slice(0, 7)

export const shardPath = (month, shard) => path.posix.join('players', month, `${shard}.json`)

export function daysInMonth(month) {
  const [year, number] = month.split('-').map(Number)
  return new Date(Date.UTC(year, number, 0)).getUTCDate()
}

export function emptyShard(month, shard) {
  return { format: SHARD_FORMAT, version: VERSION, month, shard, apps: {} }
}

export function readShard(root, month, shard) {
  const file = path.join(root, shardPath(month, shard))
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : emptyShard(month, shard)
}

/** 写入一天的采样。下标是日期减一，没有采到的日子是 null，同一天重跑取最后一次。 */
export function addSample(content, appId, day, players) {
  const key = String(appId)
  const days = content.apps[key] ?? []
  while (days.length < day) days.push(null)
  days[day - 1] = players
  content.apps[key] = days
  return content
}

export function writeShard(root, content) {
  const file = path.join(root, shardPath(content.month, content.shard))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, stableStringify(content))
}

/** 扫描目录重建索引。apps 只列当月采到的：客户端靠它决定哪些游戏不用自己采样。 */
export function buildIndex(root, updatedAt, currentMonth) {
  const months = {}
  const apps = new Set()
  const directory = path.join(root, 'players')
  for (const month of fs.existsSync(directory) ? fs.readdirSync(directory).sort() : []) {
    months[month] = []
    for (const name of fs.readdirSync(path.join(directory, month)).sort()) {
      const text = fs.readFileSync(path.join(directory, month, name), 'utf8')
      months[month].push({ shard: name.replace('.json', ''), sha256: sha256(text), size: Buffer.byteLength(text) })
      if (month === currentMonth) {
        for (const id of Object.keys(JSON.parse(text).apps ?? {})) apps.add(Number(id))
      }
    }
  }
  return { format: INDEX_FORMAT, version: VERSION, updatedAt, apps: [...apps].sort((a, b) => a - b), months }
}

/** 拥有者最多的游戏优先，只取游戏本体。 */
export function pickApps(apps, limit) {
  return [...apps.entries()]
    .filter(([, record]) => !record.type || record.type === 'game')
    .sort(([, left], [, right]) => (right.owners ?? 0) - (left.owners ?? 0) || (right.positive ?? 0) - (left.positive ?? 0))
    .slice(0, limit)
    .map(([appId]) => appId)
}
