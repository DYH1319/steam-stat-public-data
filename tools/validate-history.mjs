#!/usr/bin/env node
// 发布前校验 history 目录。--previous 是上一版 index.json：除了当月，过去的月份一个字节都不能变，
// 这条分支只追加，CDN 和客户端都是按这个假设永久缓存的。
//
//   node tools/validate-history.mjs history [--previous previous-index.json]

import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { sha256 } from './lib/format.mjs'
import { daysInMonth, historyShardOf, INDEX_FORMAT, MAX_INDEX_BYTES, MAX_SHARD_BYTES, shardPath, SHARD_FORMAT, VERSION } from './lib/history.mjs'

export function validateHistory(root, previous) {
  const errors = []
  const indexText = fs.readFileSync(path.join(root, 'index.json'), 'utf8')
  if (Buffer.byteLength(indexText) > MAX_INDEX_BYTES) errors.push('index.json is too large')
  const index = JSON.parse(indexText)
  if (index.format !== INDEX_FORMAT || index.version !== VERSION) errors.push('unexpected index format or version')
  if (!Number.isInteger(index.updatedAt) || index.updatedAt <= 0) errors.push('updatedAt must be a Unix timestamp')

  const months = Object.keys(index.months ?? {}).sort()
  for (const month of months) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      errors.push(`bad month ${month}`)
      continue
    }
    const seen = new Set()
    for (const file of index.months[month]) {
      if (!/^[0-9a-f]$/.test(file.shard) || seen.has(file.shard)) {
        errors.push(`${month}: bad shard ${file.shard}`)
        continue
      }
      seen.add(file.shard)
      const location = path.join(root, shardPath(month, file.shard))
      if (!fs.existsSync(location)) {
        errors.push(`${month}/${file.shard} is missing`)
        continue
      }
      const text = fs.readFileSync(location, 'utf8')
      const size = Buffer.byteLength(text)
      if (size !== file.size || size > MAX_SHARD_BYTES) errors.push(`${month}/${file.shard}: size mismatch`)
      if (sha256(text) !== file.sha256) errors.push(`${month}/${file.shard}: sha256 mismatch`)
      const content = JSON.parse(text)
      if (content.format !== SHARD_FORMAT || content.version !== VERSION || content.month !== month || content.shard !== file.shard) {
        errors.push(`${month}/${file.shard}: unexpected header`)
      }
      for (const [id, days] of Object.entries(content.apps ?? {})) {
        if (historyShardOf(id) !== file.shard) errors.push(`${month}/${file.shard}: app ${id} is in the wrong shard`)
        if (!Array.isArray(days) || days.length > daysInMonth(month)) errors.push(`${month}/${file.shard}: app ${id} has too many days`)
        else if (days.some(value => value !== null && (!Number.isInteger(value) || value < 0))) errors.push(`${month}/${file.shard}: app ${id} has a bad sample`)
      }
    }
  }

  if (previous) {
    const current = months.at(-1)
    for (const [month, files] of Object.entries(previous.months ?? {})) {
      if (month === current) continue
      const now = new Map((index.months?.[month] ?? []).map(file => [file.shard, file.sha256]))
      for (const file of files) {
        if (now.get(file.shard) !== file.sha256) errors.push(`${month}/${file.shard} changed but the month is closed`)
      }
    }
  }
  return errors
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { previous: { type: 'string' } } })
  const root = path.resolve(positionals[0] ?? 'history')
  const previous = values.previous && fs.existsSync(values.previous) ? JSON.parse(fs.readFileSync(values.previous, 'utf8')) : null
  const errors = validateHistory(root, previous)
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exit(1)
  }
  console.log('player history is valid')
}
