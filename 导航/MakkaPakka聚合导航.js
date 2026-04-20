// @name MakkaPakka聚合导航
// @author 梦
// @description 基于 AstrBot Widget 通用桥接的 OmniBox 导航源，动态读取远端 Widget Metadata 与模块函数
// @indexs 1
// @version 1.0.3
// @downloadURL https://gh-proxy.org/https://github.com/Silent1566/OmniBox-Spider/raw/refs/heads/main/综合/导航/MakkaPakka聚合导航.js

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");
const vm = require("vm");
const cheerio = require("cheerio");

const WIDGET_URL =
  process.env.MAKKA_WIDGET_URL ||
  "https://raw.githubusercontent.com/MakkaPakka518/FW/refs/heads/main/widgets/mk-2.0/MakkaPakka-ALL.js";
const CACHE_TTL_MS = parseInt(process.env.MAKKA_WIDGET_CACHE_MS || "1800000", 10);
const DEFAULT_PAGE_SIZE = 20;
const REQUEST_TIMEOUT_MS = parseInt(process.env.MAKKA_WIDGET_TIMEOUT_MS || "20000", 10);

const state = {
  loadedAt: 0,
  scriptText: "",
  widgetMetadata: null,
  sandbox: null,
};

module.exports = {
  home,
  category,
};

runner.run(module.exports);

async function home(params, context) {
  try {
    const widget = await loadWidgetRuntime();
    const modules = getModules(widget.widgetMetadata);

    const classes = modules.map((mod, index) => ({
      type_id: mod.functionName || `module_${index + 1}`,
      type_name: stripEmoji(mod.title || mod.functionName || `栏目${index + 1}`),
    }));

    const filters = {};
    for (const mod of modules) {
      const categoryId = mod.functionName;
      const paramDefs = normalizeParamDefs(mod.params || []);
      const filterList = [];
      for (const param of paramDefs) {
        if (param.type === "page") continue;
        if (param.type !== "enumeration" && param.type !== "input") continue;
        if (!param.name) continue;

        const filterItem = {
          key: param.name,
          name: buildFilterName(param),
          init: param.value !== undefined ? String(param.value) : "",
          value: [],
        };

        if (param.type === "enumeration") {
          const options = Array.isArray(param.enumOptions) ? param.enumOptions : [];
          filterItem.value = options.map((item) => ({
            name: String(item.title || item.name || item.value || ""),
            value: String(item.value ?? item.title ?? item.name ?? ""),
          }));
        } else {
          filterItem.value = [
            {
              name: String(param.title || param.name),
              value: filterItem.init,
            },
          ];
        }

        filterList.push(filterItem);
      }
      filters[categoryId] = filterList;
    }

    let list = [];
    for (const mod of modules) {
      const categoryId = mod.functionName;
      const initialParams = buildModuleParams(mod, 1, {});
      const items = await callWidgetModule(widget, categoryId, initialParams);
      const mapped = mapWidgetItemsToOmniBox(items, categoryId, mod, context);
      await safeLog("info", `Makka导航 home 模块尝试: ${categoryId} raw=${Array.isArray(items) ? items.length : 0} mapped=${mapped.length}`);
      if (mapped.length > 0) {
        list = mapped;
        break;
      }
    }

    return {
      class: classes,
      filters,
      list,
    };
  } catch (error) {
    await safeLog("error", `Makka导航 home 失败: ${error.message}`);
    return {
      class: [],
      filters: {},
      list: [
        buildTextVod({
          title: "导航初始化失败",
          description: error.message,
          typeName: "提示",
        }),
      ],
    };
  }
}

async function category(params, context) {
  const page = toPositiveInt(params.page, 1);
  const categoryId = String(params.categoryId || "").trim();
  const filterValues = normalizeFilters(params.filters);

  try {
    const widget = await loadWidgetRuntime();
    const moduleDef = getModules(widget.widgetMetadata).find(
      (item) => item.functionName === categoryId,
    );

    if (!moduleDef) {
      return {
        page,
        pagecount: 0,
        total: 0,
        list: [
          buildTextVod({
            title: "未找到对应栏目",
            description: `categoryId=${categoryId}`,
            typeName: "提示"
          }),
        ],
      };
    }

    const callParams = buildModuleParams(moduleDef, page, filterValues);
    const items = await callWidgetModule(widget, categoryId, callParams);
    const list = mapWidgetItemsToOmniBox(items, categoryId, moduleDef, context);

    const pagecount = list.length < DEFAULT_PAGE_SIZE ? page : page + 1;
    const total = (page - 1) * DEFAULT_PAGE_SIZE + list.length;

    return {
      page,
      pagecount,
      total,
      list,
    };
  } catch (error) {
    await safeLog("error", `Makka导航 category 失败(${categoryId}): ${error.message}`);
    return {
      page,
      pagecount: 0,
      total: 0,
      list: [
        buildTextVod({
          title: "加载失败",
          description: error.message,
          typeName: stripEmoji(categoryId || "提示"),
        }),
      ],
    };
  }
}

async function loadWidgetRuntime(force = false) {
  const now = Date.now();
  if (
    !force &&
    state.sandbox &&
    state.widgetMetadata &&
    state.scriptText &&
    now - state.loadedAt < CACHE_TTL_MS
  ) {
    return {
      sandbox: state.sandbox,
      widgetMetadata: state.widgetMetadata,
      scriptText: state.scriptText,
    };
  }

  const response = await OmniBox.request(WIDGET_URL, {
    method: "GET",
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "text/plain,application/javascript,*/*",
      Referer: "https://github.com/",
    },
  });

  if (response.statusCode !== 200 || !response.body) {
    throw new Error(`拉取 Widget 源失败: HTTP ${response.statusCode}`);
  }

  const scriptText = typeof response.body === "string" ? response.body : String(response.body);
  const sandbox = createWidgetSandbox();
  vm.createContext(sandbox);
  vm.runInContext(scriptText, sandbox, {
    filename: "MakkaPakka-ALL.js",
    timeout: REQUEST_TIMEOUT_MS,
  });

  const widgetMetadata = sandbox.WidgetMetadata;
  if (!widgetMetadata || !Array.isArray(widgetMetadata.modules)) {
    throw new Error("WidgetMetadata.modules 缺失或格式异常");
  }

  state.loadedAt = now;
  state.scriptText = scriptText;
  state.sandbox = sandbox;
  state.widgetMetadata = widgetMetadata;

  return { sandbox, widgetMetadata, scriptText };
}

function createWidgetSandbox() {
  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    Promise,
    URL,
    Buffer,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    decodeURIComponent,
    parseInt,
    parseFloat,
    isNaN,
    process: { env: process.env },
  };

  sandbox.Widget = {
    http: {
      get: async (url, options = {}) => {
        const res = await OmniBox.request(url, {
          method: "GET",
          timeout: REQUEST_TIMEOUT_MS,
          headers: options.headers || {},
        });
        return {
          status: res.statusCode,
          statusCode: res.statusCode,
          data: typeof res.body === "string" ? res.body : String(res.body || ""),
          body: typeof res.body === "string" ? res.body : String(res.body || ""),
          headers: res.headers || {},
        };
      },
    },
    html: {
      load: (html) => cheerio.load(html || ""),
    },
    tmdb: {
      get: async (endpoint, options = {}) => {
        return await tmdbGet(endpoint, options.params || {});
      },
    },
  };

  return sandbox;
}

async function tmdbGet(endpoint, params = {}) {
  const base = process.env.TMDB_API_BASE_URL || "https://api.tmdb.org/3";
  const url = new URL(`${base.replace(/\/$/, "")}/${String(endpoint || "").replace(/^\//, "")}`);

  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  const headers = {
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  };

  const bearer = (
    process.env.TMDB_BEARER_TOKEN ||
    process.env.TMDB_AUTH_TOKEN ||
    process.env.TMDB_ACCESS_TOKEN ||
    ""
  ).trim();
  const apiKey = (process.env.TMDB_API_KEY || process.env.TMDB_KEY || "").trim();

  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  } else if (apiKey) {
    url.searchParams.set("api_key", apiKey);
  } else {
    throw new Error("TMDB 未配置：请设置 TMDB_API_KEY/TMDB_KEY 或 TMDB_BEARER_TOKEN");
  }

  const res = await OmniBox.request(url.toString(), {
    method: "GET",
    timeout: REQUEST_TIMEOUT_MS,
    headers,
  });

  if (res.statusCode !== 200 || !res.body) {
    throw new Error(`TMDB 请求失败: HTTP ${res.statusCode}`);
  }

  const text = typeof res.body === "string" ? res.body : String(res.body);
  return JSON.parse(text);
}

function getModules(widgetMetadata) {
  return Array.isArray(widgetMetadata?.modules) ? widgetMetadata.modules : [];
}

function normalizeParamDefs(params) {
  return Array.isArray(params) ? params : [];
}

function buildFilterName(param) {
  const title = String(param.title || param.name || "筛选");
  if (param.belongTo && param.belongTo.paramName) {
    return `${title}(${param.belongTo.paramName})`;
  }
  return title;
}

function normalizeFilters(filters) {
  if (!filters || typeof filters !== "object") return {};
  const result = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue;
    result[key] = typeof value === "string" ? value : String(value);
  }
  return result;
}

function buildModuleParams(moduleDef, page, filters) {
  const result = {};
  const params = normalizeParamDefs(moduleDef.params || []);

  for (const param of params) {
    if (!param || !param.name) continue;
    if (param.type === "page") {
      result[param.name] = page;
      continue;
    }

    const filterValue = filters[param.name];
    if (filterValue !== undefined && filterValue !== null && filterValue !== "") {
      result[param.name] = filterValue;
      continue;
    }

    if (param.value !== undefined) {
      result[param.name] = param.value;
    }
  }

  if (!Object.prototype.hasOwnProperty.call(result, "page")) {
    result.page = page;
  }

  return result;
}

async function callWidgetModule(widget, functionName, callParams) {
  const fn = widget.sandbox[functionName];
  if (typeof fn !== "function") {
    throw new Error(`Widget 函数不存在: ${functionName}`);
  }

  const result = await fn(callParams || {});
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.list)) return result.list;
  if (result && Array.isArray(result.items)) return result.items;
  return [];
}

function mapWidgetItemsToOmniBox(items, categoryId, moduleDef, context) {
  if (!Array.isArray(items)) return [];
  const typeName = stripEmoji(moduleDef?.title || categoryId || "导航");

  return items.map((item, index) => mapSingleItem(item, index, typeName, context)).filter(Boolean);
}

function mapSingleItem(item, index, typeName, context) {
  if (!item || typeof item !== "object") {
    return buildTextVod({
      title: `无效条目 ${index + 1}`,
      description: "返回项不是对象",
      typeName,
    });
  }

  if (String(item.type || "") === "text") {
    return buildTextVod({
      title: item.title || `提示 ${index + 1}`,
      description: item.description || item.desc || "",
      typeName,
    });
  }

  const mediaType = String(item.mediaType || item.type || "");
  const title = String(item.title || item.name || `未命名${index + 1}`);
  const releaseDate = String(item.releaseDate || item.date || "");
  const yearMatch = releaseDate.match(/^(\d{4})/);
  const year = yearMatch ? yearMatch[1] : "";
  const posterPath = normalizePoster(item.posterPath || item.poster || item.vod_pic || "", context);
  const genreTitle = String(item.genreTitle || item.genre || "").trim();
  const subTitle = String(item.subTitle || "").trim();
  const description = String(item.description || item.desc || "").trim();

  let remarks = subTitle || genreTitle || year || "";
  if (!remarks && mediaType) {
    remarks = mediaType === "tv" ? "剧集" : mediaType === "movie" ? "电影" : mediaType;
  }

  return {
    // 豆瓣推荐的兼容做法：保留原始 id / tmdbId，只通过 search: true 提示宿主走搜索。
    vod_id: String(item.tmdbId || item.id || `${typeName}_${index + 1}`),
    vod_name: title,
    vod_pic: posterPath,
    type_id: String(mediaType || "widget"),
    type_name: typeName,
    vod_year: year,
    vod_remarks: remarks,
    vod_subtitle: genreTitle || subTitle || "",
    vod_content: description,
    vod_douban_score: normalizeScore(item.rating),
    search: true,
    link: buildSearchLink(title),
  };
}

function normalizePoster(url, context) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) return value;
  return value;
}

function buildSearchLink(title) {
  return `https://www.themoviedb.org/search?query=${encodeURIComponent(String(title || ""))}`;
}

function normalizeScore(score) {
  if (score === undefined || score === null || score === "") return "";
  const num = Number(score);
  if (!Number.isFinite(num)) return String(score);
  return num.toFixed(num % 1 === 0 ? 0 : 1);
}

function buildTextVod({ title, description, typeName }) {
  return {
    vod_id: `text_${simpleHash(`${title}|${description}`)}`,
    vod_name: String(title || "提示"),
    vod_pic: "",
    type_id: "text",
    type_name: String(typeName || "提示"),
    vod_year: "",
    vod_remarks: "提示",
    vod_subtitle: "",
    vod_content: String(description || ""),
    search: false,
  };
}

function stripEmoji(text) {
  return String(text || "")
    .replace(/[\u{1F000}-\u{1FAFF}\u2600-\u27BF]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function toPositiveInt(value, fallback) {
  const num = parseInt(value, 10);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function simpleHash(input) {
  const text = String(input || "");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

async function safeLog(level, message) {
  try {
    await OmniBox.log(level, message);
  } catch (_) { }
}
