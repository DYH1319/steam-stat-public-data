import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { buildManifest, parseSeedList, readExisting, sha256, shardOf, stableStringify, writeDataset } from '../tools/lib/format.mjs'
import { parseGenreNames, parseSchema, parseSteamSpyAll, parseSteamSpyPopularity, parseSteamSpyTags, parseStoreDetails } from '../tools/lib/steam.mjs'
import { validate } from '../tools/validate.mjs'

const fixture = name => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8'))

test('shards by appId modulo 256 as two hex digits', () => {
  assert.equal(shardOf(570), '3a')
  assert.equal(shardOf(256), '00')
  assert.equal(shardOf(255), 'ff')
})

test('parses seed lists from JSON or separated text', () => {
  assert.deepEqual(parseSeedList('[570, 730, 570, "440", -1, 1.5]'), [570, 730, 440])
  assert.deepEqual(parseSeedList(' 570,730\n440  105600 '), [570, 730, 440, 105600])
  assert.deepEqual(parseSeedList('[570, 730'), [570, 730])
  assert.deepEqual(parseSeedList(undefined), [])
  assert.deepEqual(parseSeedList(''), [])
})

test('stable stringify sorts keys and drops undefined', () => {
  assert.equal(stableStringify({ b: 1, a: [{ d: undefined, c: 'x' }] }), '{"a":[{"c":"x"}],"b":1}')
})

test('writes content-hashed shards, a manifest that validates, and reads them back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-data-'))
  try {
    const apps = new Map([[570, { name: 'Dota 2', genres: [1] }], [826, { name: 'Other' }], [730, { name: 'CS2' }]])
    const shards = { apps: writeDataset(dir, 'apps', apps), achievements: writeDataset(dir, 'achievements', new Map()) }
    assert.equal(shards.apps.length, 2)
    const first = shards.apps.find(shard => shard.id === '3a')
    assert.equal(first.count, 2) // 570 与 826 同在 0x3a
    assert.match(first.path, /^apps\/3a\.[0-9a-f]{16}\.json$/)
    assert.equal(sha256(fs.readFileSync(path.join(dir, first.path), 'utf8')), first.sha256)

    fs.writeFileSync(path.join(dir, 'manifest.json'), stableStringify(buildManifest({ generatedAt: 1, genres: { 1: { english: 'Action' } }, shards })))
    assert.deepEqual(validate(dir), [])

    const back = readExisting(dir)
    assert.equal(back.apps.get(570).name, 'Dota 2')
    assert.equal(back.genres[1].english, 'Action')

    // 内容变化后旧分片文件被删除
    apps.set(570, { name: 'Dota 2 Reborn' })
    const updated = writeDataset(dir, 'apps', apps)
    assert.notEqual(updated.find(shard => shard.id === '3a').path, first.path)
    assert.equal(fs.existsSync(path.join(dir, first.path)), false)

    // 篡改分片会被校验发现
    fs.writeFileSync(path.join(dir, 'manifest.json'), stableStringify(buildManifest({ generatedAt: 1, genres: {}, shards: { apps: updated } })))
    fs.appendFileSync(path.join(dir, updated[0].path), ' ')
    assert.ok(validate(dir).some(error => error.includes('mismatch')))
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('parses store appdetails into a compact record', () => {
  const parsed = parseStoreDetails(fixture('appdetails-570.json'), 570)
  assert.deepEqual(parsed.record, {
    name: 'Dota 2',
    type: 'game',
    developers: ['Valve'],
    publishers: ['Valve'],
    genres: [1, 2, 37],
    releaseDate: '9 Jul, 2013',
    achievements: undefined,
  })
  assert.equal(parsed.genreNames['37'], 'Free To Play')
  assert.equal(parseStoreDetails({ 570: { success: false } }, 570), null)
  assert.deepEqual(parseGenreNames({ 570: { data: { genres: [{ id: '1', description: '动作' }] } } }, 570), { 1: '动作' })
})

test('keeps the most voted SteamSpy tags', () => {
  assert.deepEqual(parseSteamSpyTags({ tags: { MOBA: 100, Strategy: 300, 'Free to Play': 300, Zero: 0 } }), ['Free to Play', 'Strategy', 'MOBA'])
  assert.equal(parseSteamSpyTags({ tags: [] }), undefined)
})

test('keeps SteamSpy popularity and leaves out what is missing', () => {
  assert.deepEqual(
    parseSteamSpyPopularity({ positive: 713071, negative: 131850, owners: '20,000,000 .. 50,000,000', initialprice: '5999' }),
    { positive: 713071, negative: 131850, owners: 20000000, price: 5999 },
  )
  assert.deepEqual(parseSteamSpyPopularity({ positive: 0, negative: 'n/a', owners: '0 .. 20,000', initialprice: '0' }), {})
  assert.deepEqual(parseSteamSpyPopularity(undefined), {})
  // 抓取失败时要能把旧记录的数字原样带回来
  assert.deepEqual(parseSteamSpyPopularity({ positive: 10, owners: 2000, initialprice: 999 }), { positive: 10, owners: 2000, price: 999 })
})

test('orders SteamSpy candidates by owners', () => {
  assert.deepEqual(parseSteamSpyAll({
    10: { appid: 10, owners: '10,000,000 .. 20,000,000' },
    570: { appid: 570, owners: '200,000,000 .. 500,000,000' },
    7: { appid: 7, owners: 'n/a' },
  }), [570, 10, 7])
})

test('parses achievement schemas and builds https icon urls', () => {
  const parsed = parseSchema({
    response: {
      achievements: [
        { internal_name: 'WIN', localized_name: 'Winner', localized_desc: 'Win once', hidden: false, icon: 'abc123.jpg', icon_gray: 'javascript:alert(1)', groupid: 0, archived: false },
        { internal_name: '', localized_name: 'skip' },
      ],
      groups: [{ groupid: 0, localized_name: '', dlcappid: 0, archived: false, developeronly: false, order: 0, ispublic: true }],
    },
  }, 570)
  // 只有基础组的游戏和旧格式完全一样，已发布的客户端照常读取
  assert.deepEqual(parsed, {
    achievements: [{ name: 'WIN', displayName: 'Winner', description: 'Win once', icon: 'https://shared.fastly.steamstatic.com/community_assets/images/apps/570/abc123.jpg', iconGray: '', hidden: false }],
    groups: undefined,
  })
  assert.equal(parseSchema({ response: {} }, 570), undefined)
})

test('keeps achievement sets and drops developer-only groups', () => {
  const parsed = parseSchema({
    response: {
      achievements: [
        { internal_name: 'BASE', groupid: 0 },
        { internal_name: 'DLC', groupid: 1, archived: true },
        { internal_name: 'DEV', groupid: 2 },
        { internal_name: 'PRIVATE', groupid: 3 },
      ],
      groups: [
        { groupid: 0, localized_name: '', dlcappid: 0, ispublic: true },
        { groupid: 1, localized_name: 'Royal Court', dlcappid: 1303182, archived: true, order: 2, ispublic: true },
        { groupid: 2, localized_name: 'Dev', developeronly: true, ispublic: true },
        { groupid: 3, localized_name: 'Private', ispublic: false },
      ],
    },
  }, 1158310)
  assert.deepEqual(parsed.achievements.map(item => [item.name, item.groupId, item.archived]), [['BASE', undefined, undefined], ['DLC', 1, true]])
  assert.deepEqual(parsed.groups, [
    { id: 0, name: '' },
    { id: 1, name: 'Royal Court', dlcAppId: 1303182, archived: true, order: 2 },
  ])
})
