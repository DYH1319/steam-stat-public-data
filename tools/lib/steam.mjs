// 数据来源：Steam 商店 appdetails（类型 / 开发商 / 发行商 / 发行日期）、SteamSpy（标签、评测数、拥有者数、美区价格与热门游戏列表）、
// Steam Web API IPlayerService/GetGameAchievements（成就 schema 和成就集，不需要 Key）。
// 解析函数是纯函数，只保留客户端需要的字段，并对长度做限制。

const USER_AGENT = 'steam-stat-public-data (+https://github.com/DYH1319/steam-stat-public-data)'
const MAX_TEXT = 512
const MAX_TAGS = 12
const MAX_ACHIEVEMENTS = 5000
// Steam 的上限：每个应用 40 个成就集
const MAX_GROUPS = 40

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 按最小间隔串行发送请求的节流器。 */
export function throttle(intervalMs) {
  let next = 0
  return async () => {
    const now = Date.now()
    const wait = Math.max(0, next - now)
    next = Math.max(now, next) + intervalMs
    if (wait > 0) {
      await sleep(wait)
    }
  }
}

export async function fetchJson(url, { retries = 3, timeoutMs = 30_000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, 'accept': 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok) {
        return { status: response.status, body: null }
      }
      return { status: response.status, body: await response.json() }
    }
    catch (error) {
      if (attempt >= retries) {
        throw error
      }
      // 429 / 5xx / 网络错误：指数退避（10s、40s、90s）
      await sleep(10_000 * (attempt + 1) ** 2)
    }
  }
}

const text = value => typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : undefined
const textList = (value, limit = 16) => Array.isArray(value) ? value.map(text).filter(Boolean).slice(0, limit) : undefined

/** 商店 appdetails（english）→ 游戏记录；不存在或下架时返回 null。 */
export function parseStoreDetails(json, appId) {
  const entry = json?.[String(appId)]
  if (!entry?.success || !entry.data) {
    return null
  }
  const data = entry.data
  const genres = Array.isArray(data.genres)
    ? data.genres.map(genre => Number(genre.id)).filter(id => Number.isInteger(id) && id > 0)
    : []
  return {
    record: {
      name: text(data.name),
      type: text(data.type),
      developers: textList(data.developers),
      publishers: textList(data.publishers),
      genres: genres.length ? [...new Set(genres)].sort((a, b) => a - b) : undefined,
      releaseDate: data.release_date?.coming_soon ? undefined : text(data.release_date?.date),
      achievements: Number.isInteger(data.achievements?.total) && data.achievements.total > 0 ? data.achievements.total : undefined,
    },
    genreNames: Object.fromEntries((data.genres ?? []).filter(genre => Number(genre.id) > 0).map(genre => [String(Number(genre.id)), text(genre.description)])),
  }
}

/** 商店 appdetails（其他语言）→ 该语言的类型名称。 */
export function parseGenreNames(json, appId) {
  const data = json?.[String(appId)]?.data
  return Object.fromEntries((data?.genres ?? []).filter(genre => Number(genre.id) > 0).map(genre => [String(Number(genre.id)), text(genre.description)]))
}

/** SteamSpy appdetails → 票数最多的标签（最多 12 个）。 */
export function parseSteamSpyTags(json) {
  const tags = json?.tags
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) {
    return undefined
  }
  const list = Object.entries(tags)
    .filter(([, votes]) => Number(votes) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]))
    .map(([name]) => text(name))
    .filter(Boolean)
    .slice(0, MAX_TAGS)
  return list.length ? list : undefined
}

/**
 * SteamSpy appdetails → 好评数、差评数、拥有者数量的下限和美区原价（美分）。
 * 没有的字段不写，体积和旧记录一样。客户端用来算小众指数。
 */
export function parseSteamSpyPopularity(json) {
  const count = (value) => {
    const number = Number(value)
    return Number.isInteger(number) && number > 0 ? number : undefined
  }
  const owners = ownersLowerBound(json?.owners)
  return Object.fromEntries(Object.entries({
    positive: count(json?.positive),
    negative: count(json?.negative),
    owners: owners > 0 ? owners : undefined,
    price: count(json?.initialprice),
  }).filter(([, value]) => value !== undefined))
}

/** SteamSpy request=all 的一页 → 按拥有者数量排序的 appId。 */
export function parseSteamSpyAll(json) {
  if (!json || typeof json !== 'object') {
    return []
  }
  return Object.values(json)
    .map(item => ({ appId: Number(item?.appid), owners: ownersLowerBound(item?.owners) }))
    .filter(item => Number.isInteger(item.appId) && item.appId > 0)
    .sort((a, b) => b.owners - a.owners || a.appId - b.appId)
    .map(item => item.appId)
}

function ownersLowerBound(value) {
  if (typeof value === 'number') {
    return value
  }
  const match = typeof value === 'string' ? value.replaceAll(',', '').match(/^\s*(\d+)/) : null
  return match ? Number(match[1]) : 0
}

/**
 * GetGameAchievements → 成就列表与成就集。接口给的图标是文件名，这里拼成完整 https 地址，
 * 已发布的客户端只接受 https 地址。开发者组和不公开的组连同其中的成就一起丢弃。
 * 只有基础组的游戏不写 groups，默认值（groupId 0、未归档）不写进成就，体积和旧格式一样。
 */
export function parseSchema(json, appId) {
  const response = json?.response
  if (!Array.isArray(response?.achievements)) {
    return undefined
  }
  const rawGroups = Array.isArray(response.groups) ? response.groups : []
  const dropped = new Set(rawGroups.filter(group => group?.developeronly === true || group?.ispublic === false).map(group => group.groupid))
  const achievements = response.achievements
    .filter(item => typeof item?.internal_name === 'string' && item.internal_name.length > 0 && !dropped.has(item.groupid ?? 0))
    .slice(0, MAX_ACHIEVEMENTS)
    .map(item => ({
      name: item.internal_name.slice(0, 128),
      displayName: text(item.localized_name) || item.internal_name.slice(0, 128),
      description: text(item.localized_desc) ?? '',
      icon: iconUrl(item.icon, appId),
      iconGray: iconUrl(item.icon_gray, appId),
      hidden: item.hidden === true,
      ...(item.groupid ? { groupId: item.groupid } : {}),
      ...(item.archived === true ? { archived: true } : {}),
    }))
  if (achievements.length === 0) {
    return undefined
  }
  const groups = rawGroups
    .filter(group => Number.isInteger(group?.groupid) && !dropped.has(group.groupid))
    .slice(0, MAX_GROUPS)
    .map(group => ({
      id: group.groupid,
      name: text(group.localized_name) ?? '',
      ...(group.dlcappid ? { dlcAppId: group.dlcappid } : {}),
      ...(group.archived === true ? { archived: true } : {}),
      ...(group.order ? { order: group.order } : {}),
    }))
  const onlyBase = groups.every(group => group.id === 0 && !group.dlcAppId && !group.archived)
  return { achievements, groups: onlyBase ? undefined : groups }
}

function iconUrl(value, appId) {
  return typeof value === 'string' && /^[\w-]{1,128}\.(?:jpg|png|webp)$/i.test(value)
    ? `https://shared.fastly.steamstatic.com/community_assets/images/apps/${appId}/${value}`
    : httpsOnly(value)
}

function httpsOnly(value) {
  return typeof value === 'string' && /^https:\/\/[^\s"'<>]+$/.test(value) && value.length <= 512 ? value : ''
}

export const urls = {
  storeDetails: (appId, language) => `https://store.steampowered.com/api/appdetails?appids=${appId}&l=${language}&cc=us`,
  steamSpyDetails: appId => `https://steamspy.com/api.php?request=appdetails&appid=${appId}`,
  steamSpyAll: page => `https://steamspy.com/api.php?request=all&page=${page}`,
  schema: (appId, language) => `https://api.steampowered.com/IPlayerService/GetGameAchievements/v1/?appid=${appId}&language=${language}`,
}
