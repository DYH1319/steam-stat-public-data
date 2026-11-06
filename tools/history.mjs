#!/usr/bin/env node
// 采样一天的在线人数，写进 history 分支的工作目录。
//
//   node tools/history.mjs --data out --out history [--limit 2000]
//
// --data 是 data 分支的内容（用它选热门游戏），--out 是 history 分支的工作目录。
// 接口公开，不需要 API Key。一款游戏没有人数数据时跳过，不写 0：0 表示真的没人在玩。

import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { readExisting, stableStringify } from './lib/format.mjs'
import { addSample, buildIndex, DEFAULT_LIMIT, historyShardOf, monthOf, pickApps, readShard, writeShard } from './lib/history.mjs'
import { fetchJson, throttle } from './lib/steam.mjs'

const { values: args } = parseArgs({
  options: {
    data: { type: 'string', default: 'out' },
    out: { type: 'string', default: 'history' },
    limit: { type: 'string', default: String(DEFAULT_LIMIT) },
  },
})

const gate = throttle(250)
const log = (...parts) => console.log(new Date().toISOString(), ...parts)

async function playerCount(appId) {
  await gate()
  const { status, body } = await fetchJson(`https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appId}`)
  return status === 200 && body?.response?.result === 1 ? body.response.player_count ?? null : null
}

const today = new Date()
const month = monthOf(today)
const day = today.getUTCDate()
const outDir = path.resolve(args.out)
const appIds = pickApps(readExisting(path.resolve(args.data)).apps, Number(args.limit))
log(`sampling ${appIds.length} apps for ${month}-${day}`)

const shards = new Map()
let sampled = 0
let failed = 0
for (const appId of appIds) {
  let players
  try {
    players = await playerCount(appId)
  }
  catch (error) {
    failed++
    if (failed > 50 && sampled === 0) throw error
    continue
  }
  if (players == null) continue
  const shard = historyShardOf(appId)
  if (!shards.has(shard)) shards.set(shard, readShard(outDir, month, shard))
  addSample(shards.get(shard), appId, day, players)
  sampled++
}

for (const content of shards.values()) writeShard(outDir, content)
const index = buildIndex(outDir, Math.floor(today.getTime() / 1000), month)
fs.writeFileSync(path.join(outDir, 'index.json'), stableStringify(index))
log(`sampled ${sampled}, failed ${failed}`)
