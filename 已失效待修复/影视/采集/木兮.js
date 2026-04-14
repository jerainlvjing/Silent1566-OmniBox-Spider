// @name 木兮
// @author https://github.com/hjdhnx/drpy-node/blob/main/spider/js_dr2/%E6%9C%A8%E5%85%AE%5B%E4%BC%98%5D.js
// @description 刮削：支持，弹幕：支持，嗅探：支持
// @dependencies: axios, crypto
// @version 1.0.10
// @downloadURL https://gh-proxy.org/https://github.com/Silent1566/OmniBox-Spider/raw/refs/heads/main/已失效待修复/影视/采集/木兮.js

/**
 * ============================================================================
 * 木兮资源 - OmniBox 爬虫脚本
 * 来源：dr2 规则转换（木兮[优].js）
 *
 * 特性：
 * - 接入系统动态鉴权（cookie + reportId/session/traceId）
 * - 支持验证码态附加 cookie（如 captcha_v4_user）透传
 * - 支持分类、搜索、详情、播放
 * - 支持刮削元数据回填剧集标题
 * - 支持弹幕预热 + 播放地址嗅探
 *
 * 可选环境变量：
 * - SYMX_CAPTCHA_V4_USER：浏览器完成 GeeTest v4 后拿到的 captcha_v4_user
 * - SYMX_EXTRA_COOKIE：额外 cookie 串，多个键值直接按 `a=1; b=2` 传
 * ============================================================================
 */

const axios = require("axios");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const OmniBox = require("omnibox_sdk");

// ========== 全局配置 ==========
const HOST = String(process.env.SYMX_HOST || "https://film.symx.club").trim().replace(/\/$/, "");
const API_BASE = `${HOST}/api`;
const PAGE_SIZE = 15;
const SEARCH_PAGE_SIZE = 10;
const AUTH_REFRESH_MS = 20 * 60 * 1000;
const VERIFY_TOKEN = String(process.env.SYMX_VERIFY_TOKEN || "e426ccdcb0104c30b266f12de31e7130").trim();
const CLIENT_ID = String(process.env.SYMX_CLIENT_ID || "dcc7a937bf01b1f206c7dca3620cb217").trim();
const AUTHORIZATION = String(process.env.SYMX_AUTHORIZATION || "").trim();
const PRESET_REPORT_ID = String(process.env.SYMX_REPORT_ID || "").trim();
const PRESET_SESSION = String(process.env.SYMX_SESSION || "").trim();
const PRESET_TRACE_ID = String(process.env.SYMX_TRACE_ID || "").trim();
const PRESET_COOKIE = String(process.env.SYMX_COOKIE || "server_name_session=f1256108616947d34176d85e823082f8").trim();
const CAPTCHA_V4_USER = String(process.env.SYMX_CAPTCHA_V4_USER || process.env.CAPTCHA_V4_USER || "").trim();
const EXTRA_COOKIE = String(process.env.SYMX_EXTRA_COOKIE || "").trim();
const PARSE_PAGE_MODE = String(process.env.SYMX_PARSE_PAGE_MODE || "0").trim() === "1";

const BASE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
  "X-Platform": "web",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
  "Content-Type": "application/json;charset=utf-8",
  DNT: "1",
  "Sec-GPC": "1",
  "Sec-CH-UA": '"Chromium";v="146", "Not-A.Brand";v="24", "Microsoft Edge";v="146"',
  "Sec-CH-UA-Mobile": "?0",
  "Sec-CH-UA-Platform": '"Windows"',
};

const CLASS_LIST = [
  { type_id: "1", type_name: "电视剧" },
  { type_id: "2", type_name: "电影" },
  { type_id: "3", type_name: "综艺" },
  { type_id: "4", type_name: "动漫" },
  { type_id: "5", type_name: "短剧" },
];

const TYPE_MAP = {
  1: "电视剧",
  2: "电影",
  3: "综艺",
  4: "动漫",
  5: "短剧",
};

const httpClient = axios.create({
  timeout: 15000,
  httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false }),
  httpAgent: new http.Agent({ keepAlive: true }),
});

const buildPresetCookie = () => {
  const cookieParts = [];
  if (PRESET_COOKIE) cookieParts.push(PRESET_COOKIE);
  if (CAPTCHA_V4_USER) cookieParts.push(`captcha_v4_user=${CAPTCHA_V4_USER}`);
  if (EXTRA_COOKIE) cookieParts.push(EXTRA_COOKIE);
  return mergeCookie("", cookieParts);
};

const authState = {
  cookie: buildPresetCookie(),
  reportId: PRESET_REPORT_ID,
  session: PRESET_SESSION,
  traceId: PRESET_TRACE_ID,
  updatedAt: PRESET_REPORT_ID && PRESET_SESSION && PRESET_TRACE_ID ? Date.now() : 0,
};

const LOCK_PRESET_COOKIE = Boolean(PRESET_COOKIE && VERIFY_TOKEN && CLIENT_ID);

/**
 * 日志工具
 */
const logInfo = (message, data = null) => {
  const output = data ? `${message}: ${JSON.stringify(data)}` : message;
  OmniBox.log("info", `[木兮] ${output}`);
};

const logWarn = (message, data = null) => {
  const output = data ? `${message}: ${JSON.stringify(data)}` : message;
  OmniBox.log("warn", `[木兮] ${output}`);
};

const logError = (message, error) => {
  OmniBox.log("error", `[木兮] ${message}: ${error?.message || error}`);
};

/**
 * 编码/解码元数据（用于 playId 透传）
 */
const encodeMeta = (obj) => {
  try {
    return Buffer.from(JSON.stringify(obj || {}), "utf8").toString("base64");
  } catch {
    return "";
  }
};

const decodeMeta = (str) => {
  try {
    const raw = Buffer.from(str || "", "base64").toString("utf8");
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
};

/**
 * 对接口返回的十六进制字符串做异或解密
 */
const decryptHexXor = (hexData) => {
  const key = "0x1A2B3C4D5E6F7A8B9C";
  let output = "";
  const src = String(hexData || "");

  for (let i = 0; i < src.length; i += 2) {
    const hexChar = src.slice(i, i + 2);
    const intVal = parseInt(hexChar, 16);
    if (Number.isNaN(intVal)) {
      continue;
    }
    const charCode = intVal ^ key.charCodeAt((i / 2) % key.length);
    output += String.fromCharCode(charCode);
  }
  return output;
};

/**
 * 生成 13 位校验时间戳（兼容旧规则 gettime）
 */
const getChecksumTimestamp = (ts) => {
  const raw = String(ts || Date.now());
  const prefix = raw.slice(0, 12);
  let sum = 0;
  for (let i = 0; i < prefix.length; i += 1) {
    const n = parseInt(prefix.charAt(i), 10);
    sum += Number.isNaN(n) ? 0 : n;
  }
  const checkDigit = sum % 10;
  return `${prefix}${checkDigit}`;
};

/**
 * 生成动态签名（兼容旧规则 i4e）
 */
const buildSign = (url, timestamp, session, traceId) => {
  const cleanUrl = String(url || "").split("?")[0];
  const path = cleanUrl.replace(`${API_BASE}`, "");
  const salt = `symx_${session}`;
  const mapObj = { p: path, t: String(timestamp), s: salt };

  let payload = String(traceId || "")
    .split("")
    .map((char) => mapObj[char] || "")
    .join("");

  payload = payload.replaceAll("1", "i").replaceAll("0", "o").replaceAll("5", "s");
  return crypto.createHmac("sha256", String(session || "")).update(payload).digest("hex");
};

const mergeCookie = (oldCookie, setCookieHeaders) => {
  const store = {};

  const appendCookiePair = (pairStr) => {
    const pair = String(pairStr || "").split(";")[0].trim();
    const index = pair.indexOf("=");
    if (index <= 0) return;
    const key = pair.slice(0, index).trim();
    const val = pair.slice(index + 1).trim();
    if (!key) return;
    store[key] = val;
  };

  String(oldCookie || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach(appendCookiePair);

  const cookieList = Array.isArray(setCookieHeaders) ? setCookieHeaders : [];
  cookieList.forEach(appendCookiePair);

  return Object.entries(store)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
};

const buildHeaders = (extra = {}) => ({
  ...BASE_HEADERS,
  ...(authState.cookie ? { Cookie: authState.cookie } : {}),
  ...(AUTHORIZATION ? { Authorization: AUTHORIZATION } : {}),
  ...(VERIFY_TOKEN ? { "X-Verify-Token": VERIFY_TOKEN } : {}),
  ...(CLIENT_ID ? { "X-Client-Id": CLIENT_ID } : {}),
  ...extra,
});

const hasCaptchaCookie = () => /(?:^|;\s*)captcha_v4_user=/.test(String(authState.cookie || ""));

/**
 * 初始化/刷新鉴权状态：
 * 1) /api/stats/track 获取 cookie
 * 2) /api/system/config 解密 reportId/session/traceId
 */
const ensureAuth = async (force = false) => {
  const hasPresetAuth = authState.reportId && authState.session && authState.traceId;
  const fresh = Date.now() - authState.updatedAt < AUTH_REFRESH_MS;
  if (!force && hasPresetAuth && fresh) {
    return;
  }

  logInfo("刷新鉴权信息", {
    hasVerifyToken: Boolean(VERIFY_TOKEN),
    hasClientId: Boolean(CLIENT_ID),
    hasAuthorization: Boolean(AUTHORIZATION),
    hasPresetAuth,
  });

  const trackUrl = `${API_BASE}/stats/track`;
  const trackResp = await httpClient.get(trackUrl, {
    headers: buildHeaders({ Referer: `${HOST}/`, Origin: HOST }),
    validateStatus: () => true,
  });
  if (!LOCK_PRESET_COOKIE) {
    authState.cookie = mergeCookie(authState.cookie, trackResp?.headers?.["set-cookie"] || []);
  } else {
    logInfo("保持预置验证 cookie，不接受 /stats/track 回写的新 cookie");
  }

  if ((trackResp?.status === 401 || trackResp?.status === 403) && !VERIFY_TOKEN) {
    logWarn("站点触发安全验证，当前未提供 SYMX_VERIFY_TOKEN / SYMX_CLIENT_ID", {
      hasCaptchaCookie: hasCaptchaCookie(),
    });
  }

  const configUrl = `${API_BASE}/system/config`;
  const configResp = await httpClient.get(configUrl, {
    headers: buildHeaders({ Referer: `${HOST}/`, Origin: HOST }),
    validateStatus: () => true,
  });

  if (!LOCK_PRESET_COOKIE) {
    authState.cookie = mergeCookie(authState.cookie, configResp?.headers?.["set-cookie"] || []);
  } else {
    logInfo("保持预置验证 cookie，不接受 /system/config 回写的新 cookie");
  }

  if (configResp?.status >= 400) {
    if (hasPresetAuth) {
      authState.updatedAt = Date.now();
      logWarn("system/config 请求失败，回退到环境变量预置鉴权参数", {
        status: configResp?.status,
        hasCookie: Boolean(authState.cookie),
      });
      return;
    }

    const errMsg =
      configResp?.data?.message ||
      configResp?.data?.msg ||
      `system/config 请求失败，HTTP ${configResp?.status || "unknown"}`;
    throw new Error(
      `${errMsg}；如站点已启用验证，请配置 SYMX_VERIFY_TOKEN、SYMX_CLIENT_ID，必要时再补 SYMX_REPORT_ID / SYMX_SESSION / SYMX_TRACE_ID / SYMX_COOKIE / SYMX_CAPTCHA_V4_USER / SYMX_EXTRA_COOKIE`
    );
  }

  const data = configResp?.data?.data || {};
  authState.reportId = decryptHexXor(data.reportId || "") || authState.reportId;
  authState.session = decryptHexXor(data.session || "") || authState.session;
  authState.traceId = decryptHexXor(data.traceId || "") || authState.traceId;
  authState.updatedAt = Date.now();

  if (!authState.reportId || !authState.session || !authState.traceId) {
    throw new Error("鉴权参数初始化失败：reportId/session/traceId 缺失");
  }

  logInfo("鉴权刷新完成", {
    cookieReady: Boolean(authState.cookie),
    hasCaptchaCookie: hasCaptchaCookie(),
    reportIdLen: authState.reportId.length,
    sessionLen: authState.session.length,
    traceIdLen: authState.traceId.length,
    lockPresetCookie: LOCK_PRESET_COOKIE,
  });
};

/**
 * 带签名 GET 请求
 */
const signedGet = async (url, options = {}) => {
  const { timestampMode = "checksum", referer = HOST, timeout = 15000 } = options;
  await ensureAuth();

  const now = Date.now();
  const timestamp = timestampMode === "checksum" ? getChecksumTimestamp(now) : String(now);
  const requestPath = url.replace(API_BASE, "");
  const sign = buildSign(requestPath, timestamp, authState.session, authState.traceId);

  const headers = buildHeaders({
    [authState.reportId || "X-Report-Id"]: sign,
    "X-Timestamp": timestamp,
    Referer: referer,
    Origin: HOST,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  });

  logInfo("签名请求", {
    url,
    requestPath,
    timestampMode,
    referer,
    reportId: authState.reportId || "X-Report-Id",
    hasVerifyToken: Boolean(VERIFY_TOKEN),
    hasClientId: Boolean(CLIENT_ID),
  });
  return httpClient.get(url, { headers, timeout });
};

const normalizePic = (url) => {
  const pic = String(url || "").trim();
  if (!pic) return "";
  if (pic.startsWith("http://") || pic.startsWith("https://")) return pic;
  if (pic.startsWith("//")) return `https:${pic}`;
  if (pic.startsWith("/")) return `${HOST}${pic}`;
  return `${HOST}/${pic}`;
};

const parseFilmItem = (item) => ({
  vod_id: String(item?.id || ""),
  vod_name: String(item?.name || ""),
  vod_pic: normalizePic(item?.cover),
  vod_remarks: String(item?.updateStatus || ""),
  vod_content: String(item?.blurb || ""),
});

const buildScrapedEpisodeName = (scrapeData, mapping, originalName) => {
  if (!mapping || mapping.episodeNumber === 0 || (mapping.confidence && mapping.confidence < 0.5)) {
    return originalName;
  }
  if (mapping.episodeName) {
    const epName = mapping.episodeNumber + "." + mapping.episodeName;
    return epName;
  }
  if (scrapeData && Array.isArray(scrapeData.episodes)) {
    const hit = scrapeData.episodes.find(
      (ep) => ep.episodeNumber === mapping.episodeNumber && ep.seasonNumber === mapping.seasonNumber
    );
    if (hit?.name) {
      return `${hit.episodeNumber}.${hit.name}`;
    }
  }
  return originalName;
};

// ========== 接口实现 ==========

async function home() {
  logInfo("进入首页");
  const result = { class: CLASS_LIST, list: [] };

  try {
    await ensureAuth();
    const url = `${API_BASE}/film/category`;
    const resp = await httpClient.get(url, {
      headers: buildHeaders({ Referer: `${HOST}/`, Origin: HOST }),
    });
    const categories = Array.isArray(resp?.data?.data) ? resp.data.data : [];

    const dedupe = new Map();
    categories.forEach((category) => {
      (category?.filmList || []).forEach((item) => {
        const id = String(item?.id || "");
        if (!id || dedupe.has(id)) return;
        dedupe.set(id, parseFilmItem(item));
      });
    });

    result.list = Array.from(dedupe.values());
    logInfo("首页获取完成", { count: result.list.length });
  } catch (error) {
    logError("首页获取失败", error);
  }

  return result;
}

async function category(params) {
  const categoryId = String(params?.categoryId || "1");
  const page = Math.max(1, parseInt(params?.page, 10) || 1);
  const ext = params?.extend || params?.filters || {};

  logInfo("请求分类", { categoryId, page, ext });

  try {
    await ensureAuth();

    const query = new URLSearchParams({
      categoryId,
      language: String(ext?.lang || ""),
      pageNum: String(page),
      pageSize: String(PAGE_SIZE),
      sort: String(ext?.by || "updateTime"),
      year: String(ext?.year || ""),
    });

    const url = `${API_BASE}/film/category/list?${query.toString()}`;
    const resp = await httpClient.get(url, {
      headers: buildHeaders({ Referer: `${HOST}/m/category/${encodeURIComponent(categoryId)}`, Origin: HOST }),
    });

    const list = (resp?.data?.data?.list || []).map(parseFilmItem);
    const hasMore = list.length >= PAGE_SIZE;

    logInfo("分类获取完成", { categoryId, page, count: list.length });
    return {
      list,
      page,
      pagecount: hasMore ? page + 1 : page,
    };
  } catch (error) {
    logError("分类获取失败", error);
    return { list: [], page, pagecount: 0 };
  }
}

async function search(params) {
  const keyword = String(params?.keyword || params?.wd || "").trim();
  const page = Math.max(1, parseInt(params?.page, 10) || 1);
  logInfo("执行搜索", { keyword, page });

  if (!keyword) {
    return { list: [], page, pagecount: 0 };
  }

  try {
    const query = new URLSearchParams({
      keyword,
      pageNum: String(page),
      pageSize: String(SEARCH_PAGE_SIZE),
    });
    const url = `${API_BASE}/film/search?${query.toString()}`;
    const referer = `${HOST}/m/search?keyword=${encodeURIComponent(keyword)}`;

    const resp = await signedGet(url, { timestampMode: "checksum", referer });
    const list = (resp?.data?.data?.list || []).map(parseFilmItem);
    const hasMore = list.length >= SEARCH_PAGE_SIZE;

    logInfo("搜索完成", { keyword, page, count: list.length });
    return {
      list,
      page,
      pagecount: hasMore ? page + 1 : page,
    };
  } catch (error) {
    logError("搜索失败", error);
    return { list: [], page, pagecount: 0 };
  }
}

async function detail(params) {
  const videoId = String(params?.videoId || "").trim();
  logInfo("请求详情", { videoId });

  if (!videoId) {
    return { list: [] };
  }

  try {
    const url = `${API_BASE}/film/detail/play?filmId=${encodeURIComponent(videoId)}`;
    const resp = await signedGet(url, { timestampMode: "raw", referer: HOST });
    const data = resp?.data?.data;

    if (!data) {
      logWarn("详情数据为空", { videoId });
      return { list: [] };
    }

    const playSources = [];
    const scrapeCandidates = [];

    (data.playLineList || []).forEach((line, lineIndex) => {
      const sourceName = String(line?.playerName || `线路${lineIndex + 1}`);
      const episodes = [];

      (line?.lines || []).forEach((ep, epIndex) => {
        const episodeName = String(ep?.name || `第${epIndex + 1}集`);
        const lineId = String(ep?.id || "");
        if (!lineId) return;

        const fid = `${videoId}#${lineIndex}#${epIndex}`;
        const meta = encodeMeta({
          sid: videoId,
          cid: String(data?.categoryId || ""),
          fid,
          e: episodeName,
          lineId,
        });

        episodes.push({
          name: episodeName,
          playId: `${lineId}|||${meta}`,
          _fid: fid,
          _rawName: episodeName,
        });

        scrapeCandidates.push({
          fid,
          file_id: fid,
          file_name: episodeName,
          name: episodeName,
          format_type: "video",
        });
      });

      if (episodes.length > 0) {
        playSources.push({ name: sourceName, episodes });
      }
    });

    let scrapeData = null;
    let videoMappings = [];

    if (scrapeCandidates.length > 0) {
      try {
        await OmniBox.processScraping(videoId, data?.name || "", data?.name || "", scrapeCandidates);
        const metadata = await OmniBox.getScrapeMetadata(videoId);
        scrapeData = metadata?.scrapeData || null;
        videoMappings = metadata?.videoMappings || [];
        logInfo("刮削元数据获取完成", { mappingCount: videoMappings.length, hasScrapeData: Boolean(scrapeData) });
      } catch (error) {
        logWarn("刮削流程失败，降级使用站内数据", { message: error?.message || String(error) });
      }
    }

    playSources.forEach((source) => {
      (source.episodes || []).forEach((ep) => {
        const mapping = videoMappings.find((m) => m?.fileId === ep._fid);
        if (!mapping) return;
        const newName = buildScrapedEpisodeName(scrapeData, mapping, ep.name);
        if (newName && newName !== ep.name) {
          logInfo("应用刮削剧集名", { oldName: ep.name, newName });
          ep.name = newName;
        }
      });
    });

    const normalizedPlaySources = playSources.map((source) => ({
      name: source.name,
      episodes: (source.episodes || []).map((ep) => ({
        name: ep.name,
        playId: ep.playId,
      })),
    }));

    return {
      list: [
        {
          vod_id: String(data?.id || videoId),
          vod_name: scrapeData?.title || String(data?.name || ""),
          type_name: TYPE_MAP[data?.categoryId] || "",
          vod_pic: scrapeData?.posterPath
            ? `https://image.tmdb.org/t/p/w500${scrapeData.posterPath}`
            : normalizePic(data?.cover),
          vod_remarks: String(data?.updateStatus || ""),
          vod_content: scrapeData?.overview || String(data?.blurb || ""),
          vod_actor:
            (scrapeData?.credits?.cast || [])
              .slice(0, 8)
              .map((c) => c?.name)
              .filter(Boolean)
              .join(",") || "",
          vod_director:
            (scrapeData?.credits?.crew || [])
              .filter((c) => c?.job === "Director" || c?.department === "Directing")
              .slice(0, 4)
              .map((c) => c?.name)
              .filter(Boolean)
              .join(",") || "",
          vod_play_sources: normalizedPlaySources,
        },
      ],
    };
  } catch (error) {
    logError("详情获取失败", error);
    return { list: [] };
  }
}

async function play(params) {
  const rawPlayId = String(params?.playId || "");
  logInfo("请求播放", { rawPlayId: rawPlayId.slice(0, 80) });

  try {
    let lineId = rawPlayId;
    let meta = {};
    if (rawPlayId.includes("|||")) {
      const [mainPlayId, b64] = rawPlayId.split("|||");
      lineId = String(mainPlayId || "");
      meta = decodeMeta(b64 || "");
    }

    if (!lineId) {
      throw new Error("lineId 为空");
    }

    // 已经是可播放链接时直接返回
    if (/^https?:\/\//i.test(lineId) && /\.(m3u8|mp4|flv|avi|mkv|ts)(?:\?|#|$)/i.test(lineId)) {
      logInfo("检测到直接可播地址");
      return {
        urls: [{ name: "默认线路", url: lineId }],
        parse: 0,
        header: {
          "User-Agent": BASE_HEADERS["User-Agent"],
          Referer: `${HOST}/`,
          Origin: HOST,
        },
      };
    }

    const filmId = String(meta?.sid || params?.vodId || "");
    const cid = String(meta?.cid || "");

    // 先请求弹幕接口做会话预热，不阻塞主流程；未完成验证时直接跳过，避免白等超时
    if (filmId && cid) {
      if (!VERIFY_TOKEN || !CLIENT_ID) {
        logWarn("跳过弹幕接口预热：缺少 SYMX_VERIFY_TOKEN / SYMX_CLIENT_ID", { filmId, cid, lineId });
      } else {
        const danmakuUrl = `${API_BASE}/danmaku?filmId=${encodeURIComponent(filmId)}&index=${encodeURIComponent(
          cid
        )}&lineId=${encodeURIComponent(lineId)}`;

        try {
          await signedGet(danmakuUrl, {
            timestampMode: "checksum",
            referer: `${HOST}/m/player?cid=${encodeURIComponent(cid)}&film_id=${encodeURIComponent(
              filmId
            )}&line_id=${encodeURIComponent(lineId)}`,
            timeout: 5000,
          });
          logInfo("弹幕接口预热完成", { filmId, cid, lineId });
        } catch (error) {
          logWarn("弹幕接口预热失败（不影响播放）", { message: error?.message || String(error) });
        }
      }
    }

    const playerPageUrl =
      filmId && cid
        ? `${HOST}/player?cid=${encodeURIComponent(cid)}&film_id=${encodeURIComponent(filmId)}&line_id=${encodeURIComponent(lineId)}`
        : `${HOST}/player`;

    if (PARSE_PAGE_MODE) {
      logInfo("启用页面播放模式", { playerPageUrl });
      return {
        urls: [{ name: "默认线路", url: playerPageUrl }],
        parse: 1,
        header: {
          "User-Agent": BASE_HEADERS["User-Agent"],
          Referer: `${HOST}/`,
          Origin: HOST,
        },
      };
    }

    try {
      const parseUrl = `${API_BASE}/line/play/parse?lineId=${encodeURIComponent(lineId)}`;
      const parseResp = await signedGet(parseUrl, {
        timestampMode: "checksum",
        referer: playerPageUrl,
      });

      const parsePayload = parseResp?.data || {};
      let realUrl = String(parsePayload?.data || "").trim();
      if (!realUrl) {
        if (parsePayload?.code === 1004) {
          throw new Error(
            `站点返回“请先完成验证”，当前需要提供 SYMX_VERIFY_TOKEN 与 SYMX_CLIENT_ID${hasCaptchaCookie() ? "" : "；如果浏览器验证后拿到了 captcha_v4_user，也可一并通过 SYMX_CAPTCHA_V4_USER 注入"}`
          );
        }
        logWarn("解析接口未返回播放地址", {
          code: parsePayload?.code,
          message: parsePayload?.message || "",
          dataType: typeof parsePayload?.data,
        });
        throw new Error(`解析接口未返回播放地址${parsePayload?.message ? `：${parsePayload.message}` : ""}`);
      }

      if (/^https?:\/\//i.test(realUrl) && !/\.(m3u8|mp4|flv|avi|mkv|ts)(?:\?|#|$)/i.test(realUrl)) {
        try {
          const sniffed = await OmniBox.sniffVideo(realUrl);
          if (sniffed?.url) {
            logInfo("嗅探成功，使用嗅探结果");
            return {
              urls: [{ name: "默认线路", url: sniffed.url }],
              parse: 0,
              header: sniffed.header || {},
            };
          }
        } catch (error) {
          logWarn("嗅探失败，返回原始地址", { message: error?.message || String(error) });
        }
      }

      return {
        urls: [{ name: "默认线路", url: realUrl }],
        parse: 0,
        header: {
          "User-Agent": BASE_HEADERS["User-Agent"],
          Referer: `${HOST}/`,
          Origin: HOST,
        },
      };
    } catch (error) {
      const status = error?.response?.status;
      const body = typeof error?.response?.data === "string" ? error.response.data.slice(0, 200) : "";
      if (status === 403 || /请先完成验证|Request failed with status code 403/i.test(error?.message || "")) {
        logWarn("parse 接口疑似验证失效，回退到页面播放模式", { playerPageUrl, status, body });
        return {
          urls: [{ name: "默认线路", url: playerPageUrl }],
          parse: 1,
          header: {
            "User-Agent": BASE_HEADERS["User-Agent"],
            Referer: `${HOST}/`,
            Origin: HOST,
          },
        };
      }
      throw error;
    }
  } catch (error) {
    logError("播放解析失败", error);
    return { urls: [], parse: 1, header: {} };
  }
}

module.exports = { home, category, search, detail, play };

const runner = require("spider_runner");
runner.run(module.exports);
