#!/usr/bin/env node
// 增量构建公共数据：读取上一次的 data 分支内容（--out），按预算抓取一批游戏，写回分片与清单。
//
//   node tools/build.mjs --out out [--budget 400] [--achievement-budget 300] [--time-limit 300] [--candidate-pages 3]
//
// 选择顺序：seed.json 中尚未抓取的 → SteamSpy 热门列表中尚未抓取的 → 超过 30 天未刷新的（最旧的优先）。
// 同时抓取成就 schema 和成就集（english + schinese）。
// 环境变量 EXTRA_SEED（仓库 Secret）是不公开的额外种子，与 seed.json 同等优先；日志中不输出任何 AppID。

import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { buildManifest, LANGUAGES, MAX_MANIFEST_BYTES, parseSeedList, readExisting, stableStringify, writeDataset } from './lib/format.mjs'
import { fetchJson, parseGenreNames, parseSchema, parseSteamSpyAll, parseSteamSpyTags, parseStoreDetails, throttle, urls } from './lib/steam.mjs'

const DAY = 86_400
const REFRESH_AFTER = 30 * DAY
const MISSING_RETRY_AFTER = 90 * DAY
const CANDIDATE_REFRESH_AFTER = 7 * DAY
const MAX_CANDIDATE_PAGES = 40

const { values: args } = parseArgs({
  options: {
    'out': { type: 'string', default: 'out' },
    'budget': { type: 'string', default: '400' },
    'achievement-budget': { type: 'string', default: '300' },
    'time-limit': { type: 'string', default: '300' },
    'candidate-pages': { type: 'string', default: '3' },
    'seed': { type: 'string', default: path.join(import.meta.dirname, '..', 'seed.json') },
  },
})

const outDir = path.resolve(args.out)
const budget = Number(args.budget)
const achievementBudget = Number(args['achievement-budget'])
const deadline = Date.now() + Number(args['time-limit']) * 60_000
const now = () => Math.floor(Date.now() / 1000)
const log = (...parts) => console.log(new Date().toISOString(), ...parts)

// 商店约 200 次 / 5 分钟；SteamSpy appdetails 1 次 / 秒，request=all 1 次 / 分钟
const storeGate = throttle(1600)
const spyGate = throttle(1100)
const spyAllGate = throttle(61_000)
const apiGate = throttle(250)

fs.mkdirSync(outDir, { recursive: true })
const existing = readExisting(outDir)
const apps = existing.apps
const achievements = existing.achievements
const genres = existing.genres
const state = existing.state

// ---------------------------------------------------------------- 候选列表（SteamSpy 热门，分页渐进刷新）
async function refreshCandidates() {
  const pages = state.candidates.pages ?? {}
  const due = []
  for (let page = 0; page < MAX_CANDIDATE_PAGES; page++) {
    const fetchedAt = pages[page]?.fetchedAt ?? 0
    if (now() - fetchedAt > CANDIDATE_REFRESH_AFTER) {
      due.push(page)
    }
  }
  for (const page of due.slice(0, Number(args['candidate-pages']))) {
    if (Date.now() > deadline) {
      break
    }
    await spyAllGate()
    try {
      const { body } = await fetchJson(urls.steamSpyAll(page))
      const ids = parseSteamSpyAll(body)
      if (ids.length) {
        pages[page] = { fetchedAt: now(), ids }
        log(`candidates page ${page}: ${ids.length} apps`)
      }
    }
    catch (error) {
      log(`candidates page ${page} failed: ${error.message}`)
    }
  }
  state.candidates.pages = pages
}

const publicSeed = fs.existsSync(args.seed) ? parseSeedList(fs.readFileSync(args.seed, 'utf8')) : []
const extraSeed = parseSeedList(process.env.EXTRA_SEED)
const seed = [...new Set([...publicSeed, ...extraSeed])]
const seedIds = new Set(seed)
log(`seed: ${publicSeed.length} public, ${extraSeed.length} private`)

function candidateOrder() {
  const ordered = []
  const seen = new Set()
  const push = (id) => {
    const appId = Number(id)
    if (Number.isInteger(appId) && appId > 0 && !seen.has(appId)) {
      seen.add(appId)
      ordered.push(appId)
    }
  }
  seed.forEach(push)
  const pages = state.candidates.pages ?? {}
  Object.keys(pages).map(Number).sort((a, b) => a - b).forEach(page => pages[page].ids.forEach(push))
  return ordered
}

function pickWork(order) {
  const fresh = []
  const stale = []
  for (const appId of order) {
    const info = state.apps[appId]
    if (!info) {
      fresh.push(appId)
    }
    else if (info.missing ? now() - info.detailsAt > MISSING_RETRY_AFTER : now() - info.detailsAt > REFRESH_AFTER) {
      stale.push(appId)
    }
  }
  stale.sort((a, b) => state.apps[a].detailsAt - state.apps[b].detailsAt)
  return [...fresh, ...stale].slice(0, budget)
}

// ---------------------------------------------------------------- 单个游戏
async function crawlApp(appId) {
  await storeGate()
  const { body } = await fetchJson(urls.storeDetails(appId, 'english'))
  const parsed = parseStoreDetails(body, appId)
  if (!parsed) {
    state.apps[appId] = { ...state.apps[appId], detailsAt: now(), missing: true }
    return false
  }

  for (const [id, name] of Object.entries(parsed.genreNames)) {
    genres[id] = { ...genres[id], english: name }
  }
  // 发现没有中文名的类型时，顺带取一次中文商店页
  if (Object.keys(parsed.genreNames).some(id => !genres[id]?.schinese)) {
    await storeGate()
    const localized = parseGenreNames((await fetchJson(urls.storeDetails(appId, 'schinese'))).body, appId)
    for (const [id, name] of Object.entries(localized)) {
      if (name) {
        genres[id] = { ...genres[id], schinese: name }
      }
    }
  }

  let tags
  try {
    await spyGate()
    tags = parseSteamSpyTags((await fetchJson(urls.steamSpyDetails(appId), { retries: 1 })).body)
  }
  catch (error) {
    log(`tags failed: ${error.message}`)
    tags = apps.get(appId)?.tags
  }

  apps.set(appId, { ...parsed.record, tags, fetchedAt: now() })
  state.apps[appId] = { ...state.apps[appId], detailsAt: now(), missing: false }
  return true
}

async function crawlAchievements(appId) {
  const languages = {}
  const groups = {}
  for (const language of LANGUAGES) {
    await apiGate()
    const { status, body } = await fetchJson(urls.schema(appId, language), { retries: 2 })
    if (status === 403) {
      throw new Error('achievement schema request was rejected')
    }
    const parsed = parseSchema(body, appId)
    if (parsed) {
      languages[language] = parsed.achievements
      if (parsed.groups) {
        groups[language] = parsed.groups
      }
    }
  }
  state.apps[appId] = { ...state.apps[appId], achievementsAt: now() }
  if (Object.keys(languages).length) {
    achievements.set(appId, { fetchedAt: now(), languages, ...(Object.keys(groups).length ? { groups } : {}) })
  }
  else {
    achievements.delete(appId)
  }
}

// ---------------------------------------------------------------- 主流程
await refreshCandidates()
const work = pickWork(candidateOrder())
log(`crawling ${work.length} apps (known ${apps.size})`)
let crawled = 0
let failed = 0
for (const appId of work) {
  if (Date.now() > deadline) {
    log('time limit reached')
    break
  }
  try {
    if (await crawlApp(appId)) {
      crawled++
    }
  }
  catch (error) {
    failed++
    log(`app failed: ${error.message}`)
  }
}

const due = [...apps.entries()]
  .filter(([appId, record]) => record.achievements && now() - (state.apps[appId]?.achievementsAt ?? 0) > REFRESH_AFTER)
  .map(([appId]) => appId)
  // seed.json 中的游戏优先，其余按上次抓取时间（最旧的优先）
  .sort((a, b) => (seedIds.has(a) ? 0 : 1) - (seedIds.has(b) ? 0 : 1) || (state.apps[a]?.achievementsAt ?? 0) - (state.apps[b]?.achievementsAt ?? 0))
  .slice(0, achievementBudget)
log(`fetching achievement schemas for ${due.length} apps`)
for (const appId of due) {
  if (Date.now() > deadline) {
    break
  }
  try {
    await crawlAchievements(appId)
  }
  catch (error) {
    log(`achievements failed: ${error.message}`)
    if (error.message.includes('rejected')) {
      break
    }
  }
}

const shards = {
  apps: writeDataset(outDir, 'apps', apps),
  achievements: writeDataset(outDir, 'achievements', achievements),
}
const manifest = buildManifest({ generatedAt: now(), repository: process.env.GITHUB_REPOSITORY, genres, shards })
const manifestText = stableStringify(manifest)
if (Buffer.byteLength(manifestText) > MAX_MANIFEST_BYTES) {
  throw new Error('manifest is too large')
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), manifestText)
fs.writeFileSync(path.join(outDir, 'state.json'), stableStringify(state))
log(`done: ${crawled} updated, ${failed} failed, ${apps.size} apps, ${achievements.size} achievement schemas`)
