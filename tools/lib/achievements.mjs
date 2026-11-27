import { MAX_SHARD_BYTES, serializeShard, shardOf, stableStringify } from './format.mjs'

function sameJson(a, b) {
  if (a === undefined || b === undefined) {
    return a === b
  }
  return stableStringify(a) === stableStringify(b)
}

function normalizeItem(item) {
  if (!item || typeof item !== 'object' || item.hidden !== false) {
    return item
  }
  const normalized = { ...item }
  delete normalized.hidden
  return normalized
}

export function normalizeAchievementRecord(record) {
  if (!record?.languages) {
    return record
  }
  const languages = Object.fromEntries(Object.entries(record.languages).map(([language, items]) => [
    language,
    Array.isArray(items) ? items.map(normalizeItem) : items,
  ]))
  const normalized = { ...record, languages }
  if (sameJson(languages.english, languages.schinese) && sameJson(record.groups?.english, record.groups?.schinese)) {
    delete languages.schinese
  }
  return normalized
}

export function normalizeAchievementRecords(records) {
  return new Map([...records].map(([appId, record]) => [appId, normalizeAchievementRecord(record)]))
}

export function achievementSchemaDue(info, now, refreshAfter, deferredRetryAfter) {
  if (info?.achievementDeferredAt) {
    return now - info.achievementDeferredAt > deferredRetryAfter
  }
  return now - (info?.achievementsAt ?? 0) > refreshAfter
}

function appsInShard(records, shard) {
  const apps = {}
  for (const [appId, record] of records) {
    if (shardOf(appId) === shard) {
      apps[String(appId)] = record
    }
  }
  return apps
}

function shardSize(shard, apps) {
  return Buffer.byteLength(serializeShard('achievements', shard, apps))
}

function replaceShard(records, shard, apps) {
  for (const appId of [...records.keys()]) {
    if (shardOf(appId) === shard) {
      records.delete(appId)
    }
  }
  for (const [appId, record] of Object.entries(apps)) {
    records.set(Number(appId), record)
  }
}

function evictLargestUntilFits(shard, apps, maxBytes) {
  const evicted = []
  while (Object.keys(apps).length && shardSize(shard, apps) > maxBytes) {
    let victim
    let victimBytes = -1
    for (const [appId, record] of Object.entries(apps)) {
      const bytes = Buffer.byteLength(stableStringify(record))
      if (bytes > victimBytes || (bytes === victimBytes && Number(appId) < Number(victim))) {
        victim = appId
        victimBytes = bytes
      }
    }
    delete apps[victim]
    evicted.push(Number(victim))
  }
  return evicted
}

export function fitAchievementRecords({ baseline, current, touched, priority = [], maxBytes = MAX_SHARD_BYTES }) {
  const result = new Map(current)
  const deferred = []
  const evicted = []
  const resizedShards = []
  const orderedTouched = []
  const seen = new Set()
  for (const appId of [...priority, ...touched.keys()]) {
    if (touched.has(appId) && !seen.has(appId)) {
      seen.add(appId)
      orderedTouched.push(appId)
    }
  }

  const shardIds = new Set()
  for (const appId of [...baseline.keys(), ...current.keys()]) {
    shardIds.add(shardOf(appId))
  }

  for (const shard of [...shardIds].sort()) {
    const currentApps = appsInShard(current, shard)
    if (!Object.keys(currentApps).length || shardSize(shard, currentApps) <= maxBytes) {
      continue
    }

    const fittedApps = appsInShard(baseline, shard)
    for (const appId of orderedTouched) {
      if (shardOf(appId) === shard && touched.get(appId) === null) {
        delete fittedApps[String(appId)]
      }
    }
    for (const appId of orderedTouched) {
      if (shardOf(appId) !== shard || touched.get(appId) === null || !current.has(appId)) {
        continue
      }
      const key = String(appId)
      const hadPrevious = Object.hasOwn(fittedApps, key)
      const previous = fittedApps[key]
      fittedApps[key] = current.get(appId)
      if (shardSize(shard, fittedApps) > maxBytes) {
        if (hadPrevious) {
          fittedApps[key] = previous
        }
        else {
          delete fittedApps[key]
        }
        deferred.push(appId)
      }
    }

    evicted.push(...evictLargestUntilFits(shard, fittedApps, maxBytes))
    replaceShard(result, shard, fittedApps)
    resizedShards.push(shard)
  }

  return { records: result, deferred, evicted, resizedShards }
}
