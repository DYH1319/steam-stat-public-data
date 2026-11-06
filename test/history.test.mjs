import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { addSample, buildIndex, daysInMonth, emptyShard, historyShardOf, pickApps, readShard, writeShard } from '../tools/lib/history.mjs'
import { stableStringify } from '../tools/lib/format.mjs'
import { validateHistory } from '../tools/validate-history.mjs'

function withDirectory(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'player-history-'))
  try {
    return run(dir)
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function publish(dir, month, samples, updatedAt = 100) {
  for (const [appId, day, players] of samples) {
    const shard = historyShardOf(appId)
    writeShard(dir, addSample(readShard(dir, month, shard), appId, day, players))
  }
  const index = buildIndex(dir, updatedAt, month)
  fs.writeFileSync(path.join(dir, 'index.json'), stableStringify(index))
  return index
}

test('shards by appId modulo 16 as one hex digit', () => {
  assert.equal(historyShardOf(570), 'a')
  assert.equal(historyShardOf(16), '0')
  assert.equal(historyShardOf(15), 'f')
})

test('knows how long a month is', () => {
  assert.equal(daysInMonth('2026-02'), 28)
  assert.equal(daysInMonth('2028-02'), 29)
  assert.equal(daysInMonth('2026-12'), 31)
})

test('a sample lands on its day and gaps stay empty', () => {
  const content = addSample(emptyShard('2026-11', 'a'), 570, 3, 100)
  assert.deepEqual(content.apps['570'], [null, null, 100])
  addSample(content, 570, 3, 120)
  assert.deepEqual(content.apps['570'], [null, null, 120])
})

test('a zero is a real sample', () => {
  assert.deepEqual(addSample(emptyShard('2026-11', 'a'), 570, 1, 0).apps['570'], [0])
})

test('the most owned games are sampled first and only games', () => {
  const apps = new Map([[1, { owners: 10 }], [2, { owners: 500, type: 'dlc' }], [3, { owners: 300, type: 'game' }], [4, {}]])
  assert.deepEqual(pickApps(apps, 2), [3, 1])
})

test('the index lists only apps sampled this month', () => withDirectory((dir) => {
  publish(dir, '2026-10', [[570, 1, 5]])
  const index = publish(dir, '2026-11', [[730, 1, 5]])
  assert.deepEqual(index.apps, [730])
  assert.deepEqual(Object.keys(index.months), ['2026-10', '2026-11'])
  assert.deepEqual(validateHistory(dir), [])
}))

test('validation catches a shard that does not match the index', () => withDirectory((dir) => {
  publish(dir, '2026-11', [[570, 1, 5]])
  fs.appendFileSync(path.join(dir, 'players/2026-11/a.json'), ' ')
  assert.match(validateHistory(dir).join('\n'), /size mismatch/)
}))

test('validation catches an app in the wrong shard and a bad sample', () => withDirectory((dir) => {
  const content = emptyShard('2026-11', 'a')
  content.apps['1'] = [-1]
  writeShard(dir, content)
  fs.writeFileSync(path.join(dir, 'index.json'), stableStringify(buildIndex(dir, 100, '2026-11')))
  const errors = validateHistory(dir).join('\n')
  assert.match(errors, /wrong shard/)
  assert.match(errors, /bad sample/)
}))

test('a closed month must not change', () => withDirectory((dir) => {
  publish(dir, '2026-09', [[570, 1, 5]])
  publish(dir, '2026-10', [[570, 1, 5]])
  const previous = publish(dir, '2026-11', [[570, 1, 5]])
  assert.deepEqual(validateHistory(dir, previous), [])

  writeShard(dir, addSample(readShard(dir, '2026-09', 'a'), 570, 2, 9))
  fs.writeFileSync(path.join(dir, 'index.json'), stableStringify(buildIndex(dir, 200, '2026-11')))
  assert.match(validateHistory(dir, previous).join('\n'), /2026-09\/a changed/)
}))

test('the current month may grow', () => withDirectory((dir) => {
  const previous = publish(dir, '2026-11', [[570, 1, 5]])
  publish(dir, '2026-11', [[570, 2, 6]], 200)
  assert.deepEqual(validateHistory(dir, previous), [])
}))
