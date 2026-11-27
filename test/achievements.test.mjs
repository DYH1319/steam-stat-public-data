import assert from 'node:assert/strict'
import { test } from 'node:test'
import { achievementSchemaDue, fitAchievementRecords, normalizeAchievementRecord } from '../tools/lib/achievements.mjs'
import { serializeShard } from '../tools/lib/format.mjs'

function achievement(overrides = {}) {
  return {
    name: 'WIN',
    displayName: 'Winner',
    description: 'Win once',
    icon: 'icon.jpg',
    iconGray: 'gray.jpg',
    hidden: false,
    ...overrides,
  }
}

function record(size) {
  return { pad: 'x'.repeat(size) }
}

function shardObject(records) {
  return Object.fromEntries([...records].map(([appId, value]) => [String(appId), value]))
}

test('normalizes default hidden and duplicate schinese without changing the input', () => {
  const item = achievement()
  const source = {
    fetchedAt: 1,
    languages: {
      english: [item],
      schinese: [{ ...item }],
    },
    groups: {
      english: [{ id: 0, name: '' }],
      schinese: [{ id: 0, name: '' }],
    },
  }
  const normalized = normalizeAchievementRecord(source)
  assert.equal(normalized.languages.english[0].hidden, undefined)
  assert.equal(normalized.languages.schinese, undefined)
  assert.equal(source.languages.english[0].hidden, false)
  assert.equal(source.languages.schinese.length, 1)
})

test('keeps schinese when achievements or groups differ', () => {
  const translated = normalizeAchievementRecord({
    languages: {
      english: [achievement()],
      schinese: [achievement({ displayName: '赢家' })],
    },
  })
  assert.equal(translated.languages.schinese.length, 1)

  const differentGroups = normalizeAchievementRecord({
    languages: {
      english: [achievement()],
      schinese: [achievement()],
    },
    groups: {
      english: [{ id: 0, name: 'Base' }],
      schinese: [{ id: 0, name: '基础' }],
    },
  })
  assert.equal(differentGroups.languages.schinese.length, 1)
})

test('keeps hidden true', () => {
  const normalized = normalizeAchievementRecord({
    languages: {
      english: [achievement({ hidden: true })],
      schinese: [achievement({ hidden: true })],
    },
  })
  assert.equal(normalized.languages.english[0].hidden, true)
})

test('schedules deferred achievement schemas separately from regular refreshes', () => {
  assert.equal(achievementSchemaDue(undefined, 1000, 100, 50), true)
  assert.equal(achievementSchemaDue({ achievementsAt: 950 }, 1000, 100, 50), false)
  assert.equal(achievementSchemaDue({ achievementsAt: 800 }, 1000, 100, 50), true)
  assert.equal(achievementSchemaDue({ achievementsAt: 800, achievementDeferredAt: 950 }, 1000, 100, 50), false)
  assert.equal(achievementSchemaDue({ achievementsAt: 950, achievementDeferredAt: 900 }, 1000, 100, 50), true)
})

test('defers a new schema that does not fit and keeps the rest publishable', () => {
  const baseline = new Map([[570, record(50)]])
  const current = new Map([[570, record(50)], [826, record(400)], [1082, record(50)]])
  const touched = new Map([[826, record(400)], [1082, record(50)]])
  const fit = fitAchievementRecords({ baseline, current, touched, priority: [826, 1082], maxBytes: 500 })
  assert.deepEqual(fit.deferred, [826])
  assert.equal(fit.records.has(826), false)
  assert.equal(fit.records.get(570).pad.length, 50)
  assert.equal(fit.records.get(1082).pad.length, 50)
  assert.ok(Buffer.byteLength(serializeShard('achievements', '3a', shardObject(fit.records))) <= 500)
  assert.deepEqual(fit.resizedShards, ['3a'])
})

test('uses priority order when only some schemas fit', () => {
  const baseline = new Map([[570, record(50)]])
  const current = new Map([[570, record(50)], [826, record(200)], [1082, record(200)]])
  const touched = new Map([[826, record(200)], [1082, record(200)]])
  const fit = fitAchievementRecords({ baseline, current, touched, priority: [1082, 826], maxBytes: 500 })
  assert.equal(fit.records.has(1082), true)
  assert.equal(fit.records.has(826), false)
  assert.deepEqual(fit.deferred, [826])
})

test('keeps the previously published record when its update does not fit', () => {
  const baseline = new Map([[570, record(100)]])
  const current = new Map([[570, record(410)]])
  const touched = new Map([[570, record(410)]])
  const fit = fitAchievementRecords({ baseline, current, touched, priority: [570], maxBytes: 500 })
  assert.deepEqual(fit.deferred, [570])
  assert.equal(fit.records.get(570).pad.length, 100)
})

test('deletions stay effective while fitting an oversized shard', () => {
  const baseline = new Map([[570, record(50)], [826, record(50)]])
  const current = new Map([[570, record(50)], [1082, record(400)]])
  const touched = new Map([[826, null], [1082, record(400)]])
  const fit = fitAchievementRecords({ baseline, current, touched, priority: [1082], maxBytes: 500 })
  assert.equal(fit.records.has(826), false)
  assert.equal(fit.records.has(1082), false)
  assert.deepEqual(fit.deferred, [1082])
})

test('leaves fitting shards unchanged', () => {
  const baseline = new Map([[570, record(50)]])
  const current = new Map([[570, record(50)], [826, record(50)]])
  const touched = new Map([[826, record(50)]])
  const fit = fitAchievementRecords({ baseline, current, touched, priority: [826], maxBytes: 500 })
  assert.deepEqual(fit.deferred, [])
  assert.deepEqual(fit.resizedShards, [])
  assert.equal(fit.records.get(826).pad.length, 50)
})

test('evicts an already oversized corrupt baseline record instead of failing the build', () => {
  const baseline = new Map([[570, record(410)]])
  const current = new Map([[570, record(410)]])
  const fit = fitAchievementRecords({ baseline, current, touched: new Map(), maxBytes: 500 })
  assert.deepEqual(fit.deferred, [])
  assert.deepEqual(fit.evicted, [570])
  assert.equal(fit.records.has(570), false)
})

test('keeps every shard within the cap for mixed additions', () => {
  let seed = 1
  const random = () => (seed = seed * 48271 % 2147483647) / 2147483647
  const current = new Map()
  const touched = new Map()
  const priority = []
  for (let index = 0; index < 100; index++) {
    const appId = 570 + (index % 10) * 256 + Math.floor(index / 10) * 2560
    const value = record(Math.floor(random() * 1800))
    current.set(appId, value)
    touched.set(appId, value)
    priority.push(appId)
  }
  const fit = fitAchievementRecords({ baseline: new Map(), current, touched, priority, maxBytes: 2000 })
  const byShard = new Map()
  for (const [appId, value] of fit.records) {
    const shard = (appId % 256).toString(16).padStart(2, '0')
    byShard.set(shard, { ...byShard.get(shard), [appId]: value })
  }
  assert.ok(fit.deferred.length > 0)
  for (const [shard, apps] of byShard) {
    assert.ok(Buffer.byteLength(serializeShard('achievements', shard, apps)) <= 2000, `shard ${shard}`)
  }
})
