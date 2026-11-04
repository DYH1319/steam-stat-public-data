# Steam Stat 公共数据

[Steam Stat](https://github.com/DYH1319/steam-stat) 的公共数据层：把游戏元数据（类型、标签、开发商、发行商、发行日期）和成就 schema 预先整理好，通过 GitHub 与 jsDelivr 分发。

- 客户端按需下载自己用到的分片，减少对 Steam 的请求次数，国内网络下也能访问（国内网络优化时优先 jsDelivr）。
- 统计页可以据此按类型、标签汇总游玩时长。
- 没有登录 Steam 或 CM 不可用时，成就详情可以用这里的 schema 作为回退。

这里只有公开的商店 / 社区数据，**不包含任何用户数据**（没有 SteamID、账号、游玩时长或解锁记录）。

## 数据格式（v1）

数据在 `data` 分支，每次构建都是一个新的孤儿提交（只保留最新一代）：

```
manifest.json                    清单：生成时间、类型名称表（english / schinese）、各数据集的分片列表
apps/{xx}.{sha16}.json           游戏元数据分片，xx = appId % 256（两位十六进制）
achievements/{xx}.{sha16}.json   成就 schema 分片（english / schinese）
state.json                       生成器进度（客户端不读取）
```

清单中每个分片都有路径、SHA-256、字节数和游戏数。分片文件名带内容哈希，CDN 缓存旧清单时也不会拿到不一致的分片；客户端会再次校验 SHA-256 与大小上限（分片 4 MB、清单 1 MB），只接受白名单主机，不匹配就丢弃。

```jsonc
// apps/3a.<sha16>.json
{
  "format": "steam-stat-public-data/apps",
  "version": 1,
  "shard": "3a",
  "apps": {
    "570": {
      "name": "Dota 2",
      "type": "game",
      "genres": [1, 2, 37],              // 名称见 manifest.genres
      "tags": ["Free to Play", "MOBA"],  // SteamSpy 票数最多的标签（最多 12 个）
      "developers": ["Valve"],
      "publishers": ["Valve"],
      "releaseDate": "Jul 9, 2013",
      "achievements": 0,                 // 成就数（有成就时）
      "fetchedAt": 1793784091
    }
  }
}
```

分发地址：

- `https://raw.githubusercontent.com/DYH1319/steam-stat-public-data/data/manifest.json`
- `https://cdn.jsdelivr.net/gh/DYH1319/steam-stat-public-data@data/manifest.json`

## 构建

GitHub Actions（`.github/workflows/build.yml`）每 6 小时运行一次，增量抓取一批游戏：

1. 先取 `seed.json` 中尚未抓取的游戏，再取 SteamSpy 热门列表（按拥有者数量，每次刷新几页），最后刷新超过 30 天的记录。
2. 商店 `appdetails`（english，遇到新类型时再取一次 schinese 的类型名称）与 SteamSpy `appdetails`（标签）。请求按各自的限速串行发送。
3. 配置了仓库 Secret `STEAM_WEB_API_KEY` 时，为有成就的游戏抓取 `GetSchemaForGame`（english / schinese）。没有配置时跳过成就。
4. `tools/validate.mjs` 校验通过后强制推送 `data` 分支，并刷新 jsDelivr 上清单的缓存。

本地运行：

```bash
npm test
node tools/build.mjs --out out --budget 20 --candidate-pages 0
node tools/validate.mjs out
```

想让某个游戏尽快收录，可以提 PR 把它的 AppID 加进 `seed.json`。

## 许可

生成器代码使用 MIT 许可。数据来自 Steam 商店、Steam Web API 与 SteamSpy，相关名称、描述与图片的权利归 Valve 及各开发商 / 发行商所有，这里只为 Steam Stat 的个人统计用途做缓存分发。
