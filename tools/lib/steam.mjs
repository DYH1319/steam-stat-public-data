// 数据来源：Steam 商店 appdetails（类型 / 开发商 / 发行商 / 发行日期）、SteamSpy（标签与热门游戏列表）、
// Steam Web API GetSchemaForGame（成就 schema，需要 STEAM_WEB_API_KEY）。
// 解析函数是纯函数，只保留客户端需要的字段，并对长度做限制。

const USER_AGENT = 'steam-stat-public-data (+https://github.com/DYH1319/steam-stat-public-data)'
const MAX_TEXT = 512
const MAX_TAGS = 12
const MAX_ACHIEVEMENTS = 5000

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
  const match = typeof value === 'string' ? value.replaceAll(',', '').match(/^\s*(\d+)/) : null
  return match ? Number(match[1]) : 0
}

/** GetSchemaForGame → 成就列表（图标为完整 https 地址）。 */
export function parseSchema(json) {
  const list = json?.game?.availableGameStats?.achievements
  if (!Array.isArray(list)) {
    return undefined
  }
  const achievements = list
    .filter(item => typeof item?.name === 'string' && item.name.length > 0)
    .slice(0, MAX_ACHIEVEMENTS)
    .map(item => ({
      name: item.name.slice(0, 128),
      displayName: text(item.displayName) ?? item.name.slice(0, 128),
      description: text(item.description) ?? '',
      icon: httpsOnly(item.icon),
      iconGray: httpsOnly(item.icongray),
      hidden: item.hidden === 1 || item.hidden === true,
    }))
  return achievements.length ? achievements : undefined
}

function httpsOnly(value) {
  return typeof value === 'string' && /^https:\/\/[^\s"'<>]+$/.test(value) && value.length <= 512 ? value : ''
}

export const urls = {
  storeDetails: (appId, language) => `https://store.steampowered.com/api/appdetails?appids=${appId}&l=${language}&cc=us`,
  steamSpyDetails: appId => `https://steamspy.com/api.php?request=appdetails&appid=${appId}`,
  steamSpyAll: page => `https://steamspy.com/api.php?request=all&page=${page}`,
  schema: (appId, language, key) => `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${encodeURIComponent(key)}&appid=${appId}&l=${language}`,
}
