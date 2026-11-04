#!/usr/bin/env node
// 发布前校验 data 目录：清单格式、每个分片存在且 SHA-256 / 大小一致、分片内容与清单一致。
//
//   node tools/validate.mjs out

import fs from 'node:fs'
import path from 'node:path'
import { DATASETS, FORMAT, MAX_MANIFEST_BYTES, MAX_SHARD_BYTES, sha256, shardOf, VERSION } from './lib/format.mjs'

export function validate(outDir) {
  const errors = []
  const manifestFile = path.join(outDir, 'manifest.json')
  const manifestText = fs.readFileSync(manifestFile, 'utf8')
  if (Buffer.byteLength(manifestText) > MAX_MANIFEST_BYTES) {
    errors.push('manifest.json is too large')
  }
  const manifest = JSON.parse(manifestText)
  if (manifest.format !== FORMAT || manifest.version !== VERSION) {
    errors.push('unexpected manifest format or version')
  }
  if (!Number.isInteger(manifest.generatedAt)) {
    errors.push('generatedAt must be a Unix timestamp')
  }
  for (const dataset of DATASETS) {
    const seen = new Set()
    for (const shard of manifest.datasets?.[dataset]?.shards ?? []) {
      const pattern = new RegExp(`^${dataset}/[0-9a-f]{2}\\.[0-9a-f]{16}\\.json$`)
      if (!pattern.test(shard.path) || !shard.path.startsWith(`${dataset}/${shard.id}.`) || seen.has(shard.id)) {
        errors.push(`${dataset}: bad shard entry ${shard.path}`)
        continue
      }
      seen.add(shard.id)
      const file = path.join(outDir, shard.path)
      if (!fs.existsSync(file)) {
        errors.push(`${shard.path} is missing`)
        continue
      }
      const text = fs.readFileSync(file, 'utf8')
      const size = Buffer.byteLength(text)
      if (size !== shard.size || size > MAX_SHARD_BYTES) {
        errors.push(`${shard.path}: size mismatch`)
      }
      if (sha256(text) !== shard.sha256 || !shard.path.includes(`.${shard.sha256.slice(0, 16)}.`)) {
        errors.push(`${shard.path}: sha256 mismatch`)
      }
      const content = JSON.parse(text)
      if (content.format !== `${FORMAT}/${dataset}` || content.shard !== shard.id) {
        errors.push(`${shard.path}: unexpected content header`)
      }
      const ids = Object.keys(content.apps ?? {})
      if (ids.length !== shard.count || ids.some(id => shardOf(id) !== shard.id)) {
        errors.push(`${shard.path}: app ids do not match the shard`)
      }
    }
  }
  return errors
}

if (import.meta.main) {
  const outDir = path.resolve(process.argv[2] ?? 'out')
  const errors = validate(outDir)
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exit(1)
  }
  console.log('public data is valid')
}
