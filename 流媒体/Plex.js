// @name Plex
// @author Copilot
// @description 直连 Plex 接口，填好服务器地址和 Token 即可使用。支持多服务器、多库、剧集/电影播放
// @dependencies: axios
// @version 1.4.0
// @downloadURL https://gh-proxy.org/https://github.com/Silent1566/OmniBox-Spider/raw/refs/heads/main/流媒体/Plex.js

/**
 * ============================================================================
 * Plex OmniBox 爬虫
 * ============================================================================
 * 说明：
 * 1. 直连 Plex Media Server API，获取媒体库、电影、剧集并播放。
 * 2. Plex 默认端口 32400，需提供 X-Plex-Token 进行认证。
 * 3. 支持多 Plex 服务器配置，直接修改下方的 accounts 数组。
 * 4. 支持 plex.tv 账号 token 自动发现服务器 token（填账号 token 也能用）。
 * ============================================================================
 * Token 说明：
 * - 如果直接填服务器 token（设置→管理→访问令牌），直连速度最快
 * - 如果填 plex.tv 账号 token，脚本会自动通过 plex.tv 发现服务器和服务器 token
 * ============================================================================
 * 配置方式：直接修改下方 accounts 数组中的 host/token/name
 *   [{ "host": "http://...", "token": "...", "name": "我的Plex" }]
 * ============================================================================
 */

const axios = require("axios");
const http = require("http");
const https = require("https");
const OmniBox = require("omnibox_sdk");

// ==================== 账号配置（直接在这里填写你的 Plex 信息）====================
let accounts = [
  {
    host: "", // 例：http://192.168.1.100:32400
    token: "", // Plex Token（设置→管理→访问令牌，或 plex.tv 账号 token）
    name: "我的Plex",
  },
];

// ==================== 工具 ====================
const axiosInstance = axios.create({
  timeout: 15000,
  httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false }),
  httpAgent: new http.Agent({ keepAlive: true }),
  validateStatus: (status) => status >= 200,
});

const logInfo = (message, data = null) => {
  const output = data ? `${message}: ${JSON.stringify(data)}` : message;
  OmniBox.log("info", `[Plex] ${output}`);
};

const logError = (message, error) => {
  OmniBox.log("error", `[Plex] ${message}: ${error?.message || error}`);
};

function cleanText(text) {
  return String(text || "").trim();
}

function normalizeHost(host) {
  const raw = String(host || "").trim();
  if (!raw) return "";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function generateUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function getPlexHeaders(token) {
  return {
    "Accept": "application/json",
    "X-Plex-Token": token,
    "X-Plex-Client-Identifier": generateUUID(),
    "X-Plex-Product": "OmniBox",
    "X-Plex-Version": "1.0.0",
    "X-Plex-Device": "OmniBox",
    "X-Plex-Platform": "OmniBox",
  };
}

/**
 * 通过 plex.tv 自动发现服务器和服务器 token。
 * 两层缓存：
 *   1. 内存缓存（account._resolved）— 同一进程内复用
 *   2. OmniBox 持久化缓存（getCache/setCache）— 跨进程重启复用
 *
 * 支持用户只填写账号 token，自动通过 plex.tv 找到服务器和对应的服务器 token。
 */
async function resolvePlexServer(account) {
  const CACHE_KEY_PREFIX = "plex:resolved:";
  const CACHE_TTL = 86400 * 365; // 1年，用户很少更换服务器

  // 1) 内存缓存：同一进程内最快
  if (account._resolved) {
    return account._resolved;
  }

  const baseUrl = normalizeHost(account.host);
  const token = account.token;

  // 2) OmniBox 持久化缓存：跨进程重启复用
  if (baseUrl && token) {
    try {
      const cached = await OmniBox.getCache(`${CACHE_KEY_PREFIX}${baseUrl}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        // 验证缓存是否仍有效（快速直连测试）
        const testRes = await axiosInstance.get(`${parsed.url || baseUrl}/library/sections?X-Plex-Token=${parsed.token}`, {
          headers: { Accept: "application/json" },
          timeout: 3000,
        });
        if (testRes.status === 200) {
          logInfo("命中持久化缓存，直连成功");
          account._resolved = { baseUrl: parsed.url || baseUrl, token: parsed.token };
          return account._resolved;
        }
      }
    } catch (_) {
      // 缓存失效或被删，继续走正常流程
    }
  }

  // 3) 先尝试直连 PMS（仅当 token 可能是服务器 token 时）
  if (baseUrl && token) {
    try {
      const testRes = await axiosInstance.get(`${baseUrl}/library/sections?X-Plex-Token=${token}`, {
        headers: { Accept: "application/json" },
        timeout: 3000,
      });
      if (testRes.status === 200) {
        logInfo("服务器直连成功", { host: baseUrl });
        account._resolved = { baseUrl, token };
        // 持久化
        try { await OmniBox.setCache(`${CACHE_KEY_PREFIX}${baseUrl}`, JSON.stringify({ url: baseUrl, token }), CACHE_TTL); } catch (_) {}
        return account._resolved;
      }
    } catch (_) {
      // 直连失败（可能是账号 token），继续走发现流程
    }
  }

  // 4) 通过 plex.tv 发现服务器
  if (!token) throw new Error("未配置 Plex Token");

  try {
    const deviceId = generateUUID();
    const plexTvHeaders = {
      Accept: "application/json",
      "X-Plex-Token": token,
      "X-Plex-Client-Identifier": deviceId,
      "X-Plex-Product": "OmniBox",
      "X-Plex-Version": "1.0.0",
    };

    const res = await axiosInstance.get("https://plex.tv/api/v2/resources", {
      headers: plexTvHeaders,
      timeout: 10000,
    });

    if (res.status !== 200 || !Array.isArray(res.data)) {
      throw new Error("无法从 plex.tv 获取服务器列表");
    }

    // 匹配服务器
    let matched = null;
    for (const r of res.data) {
      if (!r.provides || !r.provides.includes("server")) continue;
      if (baseUrl) {
        for (const conn of r.connections || []) {
          const connUrl = `${conn.protocol}://${conn.address}:${conn.port}`;
          if (connUrl === baseUrl || conn.address === baseUrl) {
            matched = r;
            break;
          }
        }
      } else {
        const localConn = (r.connections || []).find(c => c.local);
        if (localConn) { matched = r; break; }
      }
      if (matched) break;
    }
    if (!matched) matched = res.data.find(r => r.provides && r.provides.includes("server"));
    if (!matched) throw new Error("未找到可用的 Plex 服务器");

    // 使用服务器专属 accessToken
    const serverToken = matched.accessToken || token;
    const localConn = (matched.connections || []).find(c => c.local);
    const conn = localConn || matched.connections?.[0];
    if (!conn) throw new Error("服务器没有可用连接地址");

    const discoveredUrl = `${conn.protocol}://${conn.address}:${conn.port}`;
    logInfo("通过 plex.tv 发现服务器", { name: matched.name, url: discoveredUrl });

    // 双缓存：内存 + OmniBox 持久化
    account._resolved = { baseUrl: discoveredUrl, token: serverToken };
    try { await OmniBox.setCache(`${CACHE_KEY_PREFIX}${baseUrl || discoveredUrl}`, JSON.stringify({ url: discoveredUrl, token: serverToken }), CACHE_TTL); } catch (_) {}

    return account._resolved;
  } catch (e) {
    logError("plex.tv 发现服务器失败", e);
    if (baseUrl && token) {
      account._resolved = { baseUrl, token };
      return account._resolved;
    }
    throw new Error(`无法连接到 Plex 服务器: ${e.message}`);
  }
}

/**
 * 构建 Plex 图片地址
 * Plex 图片访问也需要 token
 */
function getImageUrl(baseUrl, thumbPath, token) {
  if (!thumbPath) return "";
  if (thumbPath.startsWith("http")) return thumbPath;
  const path = thumbPath.startsWith("/") ? thumbPath : `/${thumbPath}`;
  return `${baseUrl}${path}?X-Plex-Token=${token}`;
}

async function requestJson(url, options, token) {
  const start = Date.now();
  try {
    const headers = { ...getPlexHeaders(token), ...(options.headers || {}) };
    const res = await axiosInstance.request({ url, ...options, headers });
    const cost = Date.now() - start;
    logInfo(`请求完成 ${url.substring(0, 120)}`, { status: res.status, cost: `${cost}ms` });
    if (res.status >= 400) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.data;
  } catch (error) {
    const cost = Date.now() - start;
    logError(`请求失败 ${url.substring(0, 120)} cost=${cost}ms`, error);
    throw error;
  }
}

function parseId(compositeId) {
  const parts = String(compositeId || "").split("@", 2);
  if (parts.length !== 2) {
    throw new Error(`无效的复合ID格式: ${compositeId}`);
  }
  const accountIndex = parseInt(parts[0], 10);
  const itemId = parts[1];
  if (Number.isNaN(accountIndex) || accountIndex < 0 || accountIndex >= accounts.length) {
    throw new Error(`账号索引越界: ${accountIndex}, 总数: ${accounts.length}`);
  }
  return { account: accounts[accountIndex], accountIndex, itemId };
}

/**
 * 解析复合 ID 并自动获取已解析的服务器连接信息
 */
async function resolveFromId(compositeId) {
  const { account, accountIndex, itemId } = parseId(compositeId);
  const { baseUrl, token } = await resolvePlexServer(account);
  return { account, accountIndex, itemId, baseUrl, token };
}

/**
 * 从 XML/JSON 的 MediaContainer 响应中提取 MediaContainer 对象
 * Plex 返回 JSON 时结构为 { MediaContainer: { ... } }
 */
function extractContainer(data) {
  if (!data) return null;
  // Plex JSON 格式总是包在 MediaContainer 里
  if (data.MediaContainer) return data.MediaContainer;
  return data;
}

// ==================== 解析函数 ====================

/**
 * 解析视频列表项（适用于电影、剧集、剧集列表）
 */
function mapVideoItem(item, accountIndex, baseUrl, token, typeHint) {
  const ratingKey = String(item.ratingKey || item.key || "").replace(/^\D+/g, "");
  const compositeVodId = `${accountIndex}@${ratingKey}`;

  const title = cleanText(item.title || "");
  const year = item.year ? String(item.year) : "";
  const thumb = getImageUrl(baseUrl, item.thumb || item.art, token);
  const summary = cleanText(item.summary || "");

  // 判断类型
  let type_name = typeHint || "";
  if (!type_name) {
    if (item.type === "movie" || item.librarySectionType === "movie") type_name = "电影";
    else if (item.type === "show" || item.librarySectionType === "show") type_name = "剧集";
    else type_name = item.type || "";
  }

  // 备注：显示分辨率和年份
  let remarks = year;
  if (item.contentRating) remarks = `${item.contentRating} ${year}`;

  return {
    vod_id: compositeVodId,
    vod_name: title,
    vod_pic: thumb,
    vod_remarks: remarks.trim(),
    type_name,
    vod_year: year,
  };
}

/**
 * 获取媒体项的子项（用于 Seaso/Episode 展开）
 */
async function getChildren(baseUrl, ratingKey, token) {
  const url = `${baseUrl}/library/metadata/${ratingKey}/children`;
  const data = await requestJson(url, {}, token);
  const container = extractContainer(data);
  return container?.Metadata || [];
}

// ==================== Handler ====================

module.exports = { home, category, detail, search, play };
const runner = require("spider_runner");
runner.run(module.exports);

/**
 * 首页 - 获取 Plex 媒体库列表
 */
async function home(params) {
  logInfo("进入首页，获取媒体库列表");

  const externalAccounts = (() => {
    const extend = params.extend || params.ext || params.config;
    if (!extend) return null;
    if (Array.isArray(extend)) return extend;
    try {
      const raw = Buffer.from(String(extend), "base64").toString("utf8");
      return JSON.parse(raw);
    } catch (_) {
      try { return JSON.parse(String(extend)); } catch (e) { return null; }
    }
  })();

  if (externalAccounts && externalAccounts.length > 0) {
    accounts = externalAccounts;
    logInfo("使用外部账号配置", { count: accounts.length });
  } else if (accounts.length === 0 || (accounts.length === 1 && !accounts[0].host)) {
    logError("未配置 Plex 信息", new Error("请在脚本 accounts 数组中填写 host 和 token"));
    return { class: [], list: [] };
  }

  const classList = [];

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    try {
      if (!account.host && !account.token) continue;
      // 通过 resolvePlexServer 自动发现（支持 plex.tv 账号 token）
      const { baseUrl, token } = await resolvePlexServer(account);
      const accountName = account.name || `Server ${i + 1}`;
      logInfo(`连接服务器 ${accountName}`, { url: baseUrl });

      const data = await requestJson(`${baseUrl}/library/sections`, {}, token);
      const container = extractContainer(data);
      const directories = container?.Directory || [];

      for (const dir of directories) {
        const key = dir.key || "";
        const type = dir.type || "";
        const title = dir.title || "";

        // 只保留视频类库（movie / show），排除 music / photo
        if (type !== "movie" && type !== "show") continue;

        const compositeCid = `${i}@${key}`;
        classList.push({
          type_id: compositeCid,
          type_name: `[${accountName}] ${title}`,
        });
      }

      logInfo(`服务器 ${accountName} 媒体库获取完成`, { count: directories.length });

      // 检查每个媒体库是否有合集，有则添加"合集"分类
      for (const dir of directories) {
        const libKey = dir.key || "";
        const libType = dir.type || "";
        if (libType !== "movie" && libType !== "show") continue;
        try {
          const collData = await requestJson(`${baseUrl}/library/sections/${libKey}/collections`, {}, token);
          const collContainer = extractContainer(collData);
          const collCount = collContainer?.size || 0;
          if (collCount > 0) {
            classList.push({
              type_id: `${i}@coll_${libKey}`,
              type_name: `[${accountName}] ${dir.title}合集`,
            });
          }
        } catch (_) {}
      }
    } catch (e) {
      logError(`首页获取失败 ${account.name || `Server ${i + 1}`}`, e);
    }
  }

  return { class: classList, list: [] };
}

/**
 * 分类分页 - 获取媒体库中的视频列表
 */
async function category(params) {
  const categoryId = params.categoryId || params.type_id || params.t || "";
  const pg = Math.max(1, parseInt(params.page || params.pg || "1", 10));
  logInfo("请求分类列表", { categoryId, page: pg });

  try {
    const { baseUrl, token, itemId, accountIndex } = await resolveFromId(categoryId);

    // 合集分类：从指定媒体库获取合集列表
    if (itemId.startsWith("coll_")) {
      const libKey = itemId.replace("coll_", "");
      const collData = await requestJson(`${baseUrl}/library/sections/${libKey}/collections`, {}, token);
      const collContainer = extractContainer(collData);
      const collections = collContainer?.Metadata || [];

      const list = collections
        .filter(coll => coll.type === "collection")
        .map(coll => ({
          vod_id: `${accountIndex}@${coll.ratingKey}`,
          vod_name: cleanText(coll.title || ""),
          vod_pic: getImageUrl(baseUrl, coll.thumb || coll.art, token),
          vod_remarks: `合集 · ${coll.childCount || 0}部`,
          type_name: "合集",
        }));

      return { list, page: 1, pagecount: 1, total: list.length };
    }

    // 普通分类：获取媒体库中的视频列表（按发行时间倒序）
    const limit = 50;
    const start = (pg - 1) * limit;
    const url = `${baseUrl}/library/sections/${itemId}/all`;
    const data = await requestJson(url, {
      headers: {
        "X-Plex-Container-Start": String(start),
        "X-Plex-Container-Size": String(limit),
      },
      params: {
        sort: "year:desc",
      },
    }, token);

    const container = extractContainer(data);
    const items = container?.Metadata || [];
    // container.size 是当前页条数，container.totalSize 才是全局总数
    const total = parseInt(container?.totalSize || container?.size || items.length, 10);

    const list = items
      .filter(item => item.type === "movie" || item.type === "show")
      .map(item => mapVideoItem(item, accountIndex, baseUrl, token));

    const pagecount = total > 0 ? Math.ceil(total / limit) : pg;

    return { list, page: pg, pagecount, total };
  } catch (e) {
    logError("分类请求失败", e);
    return { list: [], page: pg, pagecount: 0, total: 0 };
  }
}

/**
 * 详情 - 获取视频/剧集详情和播放源
 */
async function detail(params) {
  const ids = params.ids || params.id || params.videoId || "";
  const idList = Array.isArray(ids) ? ids
    : String(ids).split(",").map(s => s.trim()).filter(Boolean);

  logInfo("请求详情", { ids: idList });
  const result = { list: [] };

  for (const id of idList) {
    try {
      const { baseUrl, token, itemId, accountIndex } = await resolveFromId(id);

      // 获取元数据
      const data = await requestJson(`${baseUrl}/library/metadata/${itemId}`, {}, token);
      const container = extractContainer(data);
      const item = container?.Metadata?.[0];
      if (!item) throw new Error("未找到媒体信息");

      // 构建基本信息
      const year = item.year ? String(item.year) : "";
      const vod = {
        vod_id: id,
        vod_name: cleanText(item.title || ""),
        vod_pic: getImageUrl(baseUrl, item.thumb || item.art, token),
        type_name: item.type === "movie" ? "电影" : item.type === "show" ? "剧集" : item.type === "collection" ? "合集" : "",
        vod_year: year,
        vod_content: cleanText(item.summary || (item.type === "collection" ? `合集，共 ${item.childCount || 0} 部影片` : "")),
        vod_remarks: item.type === "collection" ? `合集 · ${item.childCount || 0}部` : (item.contentRating ? `${item.contentRating} ${year}`.trim() : year),
      };

      // 提取演员、导演
      if (item.Director) {
        vod.vod_director = (Array.isArray(item.Director) ? item.Director : [item.Director])
          .map(d => d.tag || "").filter(Boolean).join(",");
      }
      if (item.Role) {
        vod.vod_actor = (Array.isArray(item.Role) ? item.Role : [item.Role])
          .slice(0, 5).map(r => r.tag || "").filter(Boolean).join(",");
      }

      // 类型标签：取前几个 genre 作为补充（不覆盖 type_name）
      if (item.Genre && (!vod.type_name || vod.type_name === "电影" || vod.type_name === "剧集")) {
        const genres = (Array.isArray(item.Genre) ? item.Genre : [item.Genre])
          .map(g => g.tag || "").filter(Boolean).slice(0, 5);
        if (genres.length > 0) {
          vod.type_name = genres.join("/");
        }
      }

      // 构建播放源
      const playSources = [];

      if (item.type === "collection") {
        // 合集：获取合集内的电影列表，每部电影作为一条线路
        try {
          const collItemsData = await requestJson(`${baseUrl}/library/collections/${itemId}/items`, {}, token);
          const collContainer = extractContainer(collItemsData);
          const collItems = collContainer?.Metadata || [];
          for (const ci of collItems) {
            if (ci.type !== "movie") continue;
            const ciId = `${accountIndex}@${ci.ratingKey}`;
            playSources.push({
              name: cleanText(ci.title) || "未知",
              episodes: [{
                name: cleanText(ci.title) || "正片",
                playId: ciId,
              }],
            });
          }
        } catch (collError) {
          logError("获取合集内容失败", collError);
        }
      } else if (item.type === "movie") {
        // 电影：从 Media → Part 获取播放地址
        const mediaList = item.Media || [];
        for (let mi = 0; mi < mediaList.length; mi++) {
          const media = mediaList[mi];
          const parts = media.Part || [];
          for (let pi = 0; pi < parts.length; pi++) {
            const part = parts[pi];
            const partId = part.id || "";
            if (partId) {
              const compositePid = `${accountIndex}@${itemId}|${mi}|${pi}`;
              playSources.push({
                name: `${media.videoResolution || ""} ${media.videoCodec || ""} ${media.audioCodec || ""}`.trim() || "默认",
                episodes: [{
                  name: cleanText(item.title) || "正片",
                  playId: compositePid,
                  size: part.size || 0,
                }],
              });
            }
          }
        }
        // 如果 Media 中没有 Part，直接使用 itemId
        if (playSources.length === 0) {
          playSources.push({
            name: "Plex",
            episodes: [{ name: cleanText(item.title) || "正片", playId: `${accountIndex}@${itemId}` }],
          });
        }
      } else if (item.type === "show") {
        // 剧集：获取各季和各集
        try {
          const seasons = await getChildren(baseUrl, itemId, token);
          for (const season of seasons) {
            if (season.type !== "season" || !season.ratingKey) continue;
            // 跳过无季
            if (season.title === "无季" || season.title === "No Season" || season.index === 0) continue;

            // 获取该季的所有剧集
            const episodes = await getChildren(baseUrl, season.ratingKey, token);
            const seasonIndex = season.index || "";
            const episodeList = episodes
              .filter(ep => ep.type === "episode")
              .map(ep => ({
                name: `第${seasonIndex}季 第${ep.index || ""}集 ${cleanText(ep.title) || ""}`.trim(),
                playId: `${accountIndex}@${season.ratingKey}|${ep.ratingKey}`,
              }));

            if (episodeList.length > 0) {
              playSources.push({
                name: season.title || `第${season.index || seasons.indexOf(season) + 1}季`,
                episodes: episodeList,
              });
            }
          }
        } catch (seasonError) {
          logError("获取剧集失败", seasonError);
          // 回退：尝试直接获取所有子项
          try {
            const allChildren = await getChildren(baseUrl, itemId, token);
            const episodes = allChildren
              .filter(ep => ep.type === "episode")
              .map(ep => ({
                name: `第${ep.parentIndex || ""}季 第${ep.index || ""}集 ${cleanText(ep.title) || ""}`.trim(),
                playId: `${accountIndex}@${itemId}|${ep.ratingKey}`,
              }));
            if (episodes.length > 0) {
              playSources.push({ name: "全部剧集", episodes });
            }
          } catch (_) {}
        }
      }

      vod.vod_play_sources = playSources.length > 0 ? playSources : undefined;
      result.list.push(vod);
    } catch (e) {
      logError(`详情获取失败 id=${id}`, e);
      result.list.push({ vod_id: id, vod_name: "获取详情失败" });
    }
  }

  return result;
}

/**
 * 搜索 - 在所有已配置的 Plex 服务器中搜索
 * 官方 API：GET /hubs/search?query={keyword}&limit=50
 */
async function search(params) {
  const keyword = params.keyword || params.wd || "";
  const pg = Math.max(1, parseInt(params.page || params.pg || "1", 10));
  logInfo("搜索", { keyword, page: pg });

  if (!keyword) {
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }

  const list = [];

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    try {
      if (!account.host && !account.token) continue;
      const { baseUrl, token } = await resolvePlexServer(account);
      const accountName = account.name || `Server ${i + 1}`;

      // 官方推荐的搜索端点：/hubs/search 返回按类型分组的 Hub 结果
      const data = await requestJson(
        `${baseUrl}/hubs/search?query=${encodeURIComponent(keyword)}&limit=50`, {}, token
      );
      const container = extractContainer(data);
      const hubs = container?.Hub || [];

      // 从各个 Hub 中提取 movie 和 show 类型的结果
      for (const hub of hubs) {
        const items = hub.Metadata || [];
        for (const item of items) {
          if (item.type !== "movie" && item.type !== "show") continue;
          const vod = mapVideoItem(item, i, baseUrl, token);
          vod.vod_name = `[${accountName}] ${vod.vod_name}`;
          list.push(vod);
        }
      }
    } catch (e) {
      logError(`搜索失败 ${account.name || `Server ${i + 1}`}`, e);
    }
  }

  return { list, page: pg, pagecount: list.length > 0 ? pg + 1 : pg, total: list.length };
}

/**
 * 播放 - 获取 Plex 视频的直接播放地址
 */
async function play(params) {
  const rawPlayId = params.playId || params.id || "";
  logInfo("准备播放", { playId: rawPlayId });

  try {
    // playId 格式：
    // 电影: "accountIndex@itemId" 或 "accountIndex@itemId|mediaIndex|partIndex"
    // 剧集: "accountIndex@seasonId|episodeRatingKey"
    const { baseUrl, token, itemId } = await resolveFromId(rawPlayId);

    // 解析子 ID
    const parts = itemId.split("|");

    if (parts.length >= 3) {
      // 格式：itemId|mediaIndex|partIndex — 直接从 Part 获取文件下载链接
      const mediaIndex = parseInt(parts[1], 10);
      const partIndex = parseInt(parts[2], 10);

      // 获取元数据以找到正确的 Part
      const data = await requestJson(`${baseUrl}/library/metadata/${parts[0]}`, {}, token);
      const container = extractContainer(data);
      const item = container?.Metadata?.[0];
      const media = item?.Media?.[mediaIndex];
      const part = media?.Part?.[partIndex];

      if (part?.key) {
        const playUrl = `${baseUrl}${part.key}?X-Plex-Token=${token}`;
        logInfo("播放地址 (Part File)");
        return {
          parse: 0,
          urls: [{ name: "播放", url: playUrl }],
          flag: "Plex",
          header: { Referer: `${baseUrl}/` },
        };
      }
    }

    if (parts.length >= 2) {
      // 剧集：parts[0]=seasonId, parts[1]=episodeRatingKey
      // 获取该集元数据，找到 Media → Part 的 key
      const epData = await requestJson(`${baseUrl}/library/metadata/${parts[1]}`, {}, token);
      const epContainer = extractContainer(epData);
      const epItem = epContainer?.Metadata?.[0];

      if (epItem?.Media?.[0]?.Part?.[0]?.key) {
        const playUrl = `${baseUrl}${epItem.Media[0].Part[0].key}?X-Plex-Token=${token}`;
        logInfo("播放地址 (Episode Part File)");
        return {
          parse: 0,
          urls: [{ name: "播放", url: playUrl }],
          flag: "Plex",
          header: { Referer: `${baseUrl}/` },
        };
      }
    }

    // 通用方案：获取元数据，取第一个 Media 的第一个 Part
    const data = await requestJson(`${baseUrl}/library/metadata/${parts[0]}`, {}, token);
    const container = extractContainer(data);
    const item = container?.Metadata?.[0];
    const partKey = item?.Media?.[0]?.Part?.[0]?.key;

    if (partKey) {
      const playUrl = `${baseUrl}${partKey}?X-Plex-Token=${token}`;
      logInfo("播放地址 (通用 Part File)");
      return {
        parse: 0,
        urls: [{ name: "播放", url: playUrl }],
        flag: "Plex",
        header: { Referer: `${baseUrl}/` },
      };
    }

    throw new Error("无法获取播放地址");
  } catch (e) {
    logError("播放解析失败", e);
    return {
      parse: 0,
      urls: [],
      flag: String(params.flag || "Plex"),
      header: {},
      msg: `播放错误: ${e.message}`,
    };
  }
}
