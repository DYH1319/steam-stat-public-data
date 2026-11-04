// 公共数据格式（v1）：与 Steam Stat 客户端 SteamStat.Core.PublicData 保持一致。
//
// data 分支布局：
//   manifest.json                         清单：生成时间、类型名称表、各数据集的分片（路径 + SHA-256 + 大小）
//   apps/{xx}.{sha16}.json                游戏元数据分片（xx = appId % 256 的两位十六进制）
//   achievements/{xx}.{sha16}.json        成就 schema 分片
//   state.json                            生成器自己的进度（客户端不读取）
//
// 分片文件名带内容哈希：CDN 缓存旧清单时也不会拿到不匹配的分片，客户端还会逐个校验 SHA-256。

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const FORMAT = 'steam-stat-public-data'
export const VERSION = 1
export const SHARD_COUNT = 256
export const MAX_SHARD_BYTES = 4 * 1024 * 1024
export const MAX_MANIFEST_BYTES = 1024 * 1024
export const DATASETS = ['apps', 'achievements']
export const LANGUAGES = ['english', 'schinese']

export function shardOf(appId) {
  return (Number(appId) % SHARD_COUNT).toString(16).padStart(2, '0')
}

/** 键排序的 JSON：同样的内容总是产生同样的字节与哈希。 */
export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * 写出一个数据集：按 appId 分片，每个分片一个带哈希的文件，删除不再引用的旧文件。
 * records: Map<appId, record>
 */
export function writeDataset(outDir, dataset, records) {
  const byShard = new Map()
  for (const [appId, record] of records) {
    const shard = shardOf(appId)
    if (!byShard.has(shard)) {
      byShard.set(shard, {})
    }
    byShard.get(shard)[String(appId)] = record
  }

  const dir = path.join(outDir, dataset)
  fs.mkdirSync(dir, { recursive: true })
  const shards = []
  const keep = new Set()
  for (const shard of [...byShard.keys()].sort()) {
    const apps = byShard.get(shard)
    const text = stableStringify({ format: `${FORMAT}/${dataset}`, version: VERSION, shard, apps })
    if (Buffer.byteLength(text) > MAX_SHARD_BYTES) {
      throw new Error(`${dataset} shard ${shard} exceeds ${MAX_SHARD_BYTES} bytes`)
    }
    const hash = sha256(text)
    const file = `${shard}.${hash.slice(0, 16)}.json`
    fs.writeFileSync(path.join(dir, file), text)
    keep.add(file)
    shards.push({ id: shard, path: `${dataset}/${file}`, sha256: hash, size: Buffer.byteLength(text), count: Object.keys(apps).length })
  }
  for (const file of fs.readdirSync(dir)) {
    if (!keep.has(file)) {
      fs.rmSync(path.join(dir, file))
    }
  }
  return shards
}

export function buildManifest({ generatedAt, repository, genres, shards }) {
  return {
    format: FORMAT,
    version: VERSION,
    generatedAt,
    source: repository ? `https://github.com/${repository}` : undefined,
    genres,
    datasets: Object.fromEntries(DATASETS.map(dataset => [dataset, { shards: shards[dataset] ?? [] }])),
  }
}

/** 读取上一次生成的数据（data 分支的内容），返回各数据集的 Map 与类型名称表。 */
export function readExisting(outDir) {
  const result = { apps: new Map(), achievements: new Map(), genres: {}, state: { apps: {}, candidates: {} } }
  const manifestFile = path.join(outDir, 'manifest.json')
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    if (manifest.format === FORMAT && manifest.version === VERSION) {
      result.genres = manifest.genres ?? {}
      for (const dataset of DATASETS) {
        for (const shard of manifest.datasets?.[dataset]?.shards ?? []) {
          const file = path.join(outDir, shard.path)
          if (!fs.existsSync(file)) {
            continue
          }
          const content = JSON.parse(fs.readFileSync(file, 'utf8'))
          for (const [appId, record] of Object.entries(content.apps ?? {})) {
            result[dataset].set(Number(appId), record)
          }
        }
      }
    }
  }
  const stateFile = path.join(outDir, 'state.json')
  if (fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    result.state = { apps: state.apps ?? {}, candidates: state.candidates ?? {} }
  }
  return result
}
