import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { buildManifest, readExisting, sha256, shardOf, stableStringify, writeDataset } from '../tools/lib/format.mjs'
import { parseGenreNames, parseSchema, parseSteamSpyAll, parseSteamSpyTags, parseStoreDetails } from '../tools/lib/steam.mjs'
import { validate } from '../tools/validate.mjs'

const fixture = name => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8'))

test('shards by appId modulo 256 as two hex digits', () => {
  assert.equal(shardOf(570), '3a')
  assert.equal(shardOf(256), '00')
  assert.equal(shardOf(255), 'ff')
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

test('orders SteamSpy candidates by owners', () => {
  assert.deepEqual(parseSteamSpyAll({
    10: { appid: 10, owners: '10,000,000 .. 20,000,000' },
    570: { appid: 570, owners: '200,000,000 .. 500,000,000' },
    7: { appid: 7, owners: 'n/a' },
  }), [570, 10, 7])
})

test('parses achievement schemas and drops non-https icons', () => {
  const list = parseSchema({
    game: {
      availableGameStats: {
        achievements: [
          { name: 'WIN', displayName: 'Winner', description: 'Win once', hidden: 0, icon: 'https://cdn.akamai.steamstatic.com/a.jpg', icongray: 'javascript:alert(1)' },
          { name: '', displayName: 'skip' },
        ],
      },
    },
  })
  assert.deepEqual(list, [{ name: 'WIN', displayName: 'Winner', description: 'Win once', icon: 'https://cdn.akamai.steamstatic.com/a.jpg', iconGray: '', hidden: false }])
  assert.equal(parseSchema({ game: {} }), undefined)
})
