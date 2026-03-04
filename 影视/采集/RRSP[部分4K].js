/**
 * ============================================================================
 * RRSP资源 - OmniBox 爬虫脚本 (增强日志调试版)
 * ============================================================================
 */
const axios = require("axios");
const https = require("https");
const OmniBox = require("omnibox_sdk");

// ========== 全局配置 [1] ==========
const host = 'https://rrsp-api.kejiqianxian.com:60425';
const DANMU_API = process.env.DANMU_API || '';
const def_headers = {
    'User-Agent': 'rrsp.wang',
    'origin': '*',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
};

const headers = {
    ...def_headers,
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'accept-language': 'zh-CN'
};

const axiosInstance = axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
});

/**
 * 日志工具函数 [2]
 */
const logInfo = (message, data = null) => {
    const output = data ? `${message}: ${JSON.stringify(data)}` : message;
    OmniBox.log("info", `[RRSP-DEBUG] ${output}`);
};

const logError = (message, error) => {
    OmniBox.log("error", `[RRSP-DEBUG] ${message}: ${error.message || error}`);
};

/**
 * 图像地址修复 [1]
 */
const fixPicUrl = (url) => {
    if (!url) return '';
    if (url.startsWith('http')) return url;
    return url.startsWith('/') ? `${host}${url}` : `${host}/${url}`;
};

// ========== 弹幕工具函数 ==========
const preprocessTitle = (title) => {
    if (!title) return "";
    return title
        .replace(/4[kK]|[xX]26[45]|720[pP]|1080[pP]|2160[pP]/g, " ")
        .replace(/[hH]\.?26[45]/g, " ")
        .replace(/BluRay|WEB-DL|HDR|REMUX/gi, " ")
        .replace(/\.mp4|\.mkv|\.avi|\.flv/gi, " ");
};

const chineseToArabic = (cn) => {
    const map = { '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
    if (!isNaN(cn)) return parseInt(cn, 10);
    if (cn.length === 1) return map[cn] || cn;
    if (cn.length === 2) {
        if (cn[0] === '十') return 10 + map[cn[1]];
        if (cn[1] === '十') return map[cn[0]] * 10;
    }
    if (cn.length === 3) return map[cn[0]] * 10 + map[cn[2]];
    return cn;
};

const extractEpisode = (title) => {
    if (!title) return "";
    const processedTitle = preprocessTitle(title).trim();

    const cnMatch = processedTitle.match(/第\s*([零一二三四五六七八九十0-9]+)\s*[集话章节回期]/);
    if (cnMatch) return String(chineseToArabic(cnMatch[1]));

    const seMatch = processedTitle.match(/[Ss](?:\d{1,2})?[-._\s]*[Ee](\d{1,3})/i);
    if (seMatch) return seMatch[1];

    const epMatch = processedTitle.match(/\b(?:EP|E)[-._\s]*(\d{1,3})\b/i);
    if (epMatch) return epMatch[1];

    const bracketMatch = processedTitle.match(/[\[\(【(](\d{1,3})[\]\)】)]/);
    if (bracketMatch) {
        const num = bracketMatch[1];
        if (!["720", "1080", "480"].includes(num)) return num;
    }

    return "";
};

const buildFileNameForDanmu = (vodName, episodeTitle) => {
    if (!vodName) return "";
    if (!episodeTitle || episodeTitle === '正片' || episodeTitle === '播放') return vodName;

    const digits = extractEpisode(episodeTitle);
    if (digits) {
        const epNum = parseInt(digits, 10);
        if (epNum > 0) {
            if (epNum < 10) return `${vodName} S01E0${epNum}`;
            return `${vodName} S01E${epNum}`;
        }
    }
    return vodName;
};

const matchDanmu = async (fileName) => {
    if (!DANMU_API || !fileName) return [];

    try {
        logInfo(`匹配弹幕: ${fileName}`);
        const matchUrl = `${DANMU_API}/api/v2/match`;
        const response = await OmniBox.request(matchUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
            body: JSON.stringify({ fileName }),
        });

        if (response.statusCode !== 200) {
            logInfo(`弹幕匹配失败: HTTP ${response.statusCode}`);
            return [];
        }

        const matchData = JSON.parse(response.body);
        if (!matchData.isMatched) {
            logInfo("弹幕未匹配到");
            return [];
        }

        const matches = matchData.matches || [];
        if (matches.length === 0) return [];

        const firstMatch = matches[0];
        const episodeId = firstMatch.episodeId;
        const animeTitle = firstMatch.animeTitle || "";
        const episodeTitle = firstMatch.episodeTitle || "";
        if (!episodeId) return [];

        let danmakuName = "弹幕";
        if (animeTitle && episodeTitle) {
            danmakuName = `${animeTitle} - ${episodeTitle}`;
        } else if (animeTitle) {
            danmakuName = animeTitle;
        } else if (episodeTitle) {
            danmakuName = episodeTitle;
        }

        const danmakuURL = `${DANMU_API}/api/v2/comment/${episodeId}?format=xml`;
        logInfo(`弹幕匹配成功: ${danmakuName}`);

        return [{
            name: danmakuName,
            url: danmakuURL,
        }];
    } catch (error) {
        logInfo(`弹幕匹配失败: ${error.message}`);
        return [];
    }
};

/**
 * 核心：解析 CMS 字符串为结构化播放源 [1][2]
 * 逻辑：将 "来源1$$$来源2" 和 "第1集$ID1#第2集$ID2" 转换为 UI 识别的数组
 */
const parsePlaySources = (fromStr, urlStr, vodName = '') => {
    logInfo("开始解析播放源字符串", { from: fromStr, url: urlStr });
    const playSources = [];
    if (!fromStr || !urlStr) return playSources;

    const froms = fromStr.split('$$$');
    const urls = urlStr.split('$$$');

    for (let i = 0; i < froms.length; i++) {
        const sourceName = froms[i] || `线路${i + 1}`;
        const sourceItems = urls[i] ? urls[i].split('#') : [];

        const episodes = sourceItems.map(item => {
            const parts = item.split('$');
            const episodeName = parts[0] || '正片';
            const actualPlayId = parts[1] || parts[0];
            return {
                name: episodeName,
                playId: `${actualPlayId}|${vodName}|${episodeName}`
            };
        }).filter(e => e.playId);

        if (episodes.length > 0) {
            playSources.push({
                name: sourceName,
                episodes: episodes
            });
        }
    }
    logInfo("播放源解析结果", playSources);
    return playSources;
};

const arr2vods = (arr) => {
    const videos = [];
    if (!arr) return videos;
    for (const i of arr) {
        let remarks;
        if (i.vod_serial === '1') {
            remarks = `${i.vod_serial}集`;
        } else {
            remarks = `评分:${i.vod_score || i.vod_douban_score || ''}`;
        }
        videos.push({
            vod_id: i.vod_id,
            vod_name: i.vod_name,
            vod_pic: i.vod_pic,
            vod_remarks: remarks,
            vod_year: null
        });
    }
    return videos;
};

// ========== 接口实现 ==========

async function home(params) {
    logInfo("进入首页");
    return {
        class: [
            { 'type_id': '1', 'type_name': '电影' },
            { 'type_id': '2', 'type_name': '电视剧' },
            { 'type_id': '3', 'type_name': '综艺' },
            { 'type_id': '5', 'type_name': '动漫' },
            { 'type_id': '4', 'type_name': '纪录片' },
            { 'type_id': '6', 'type_name': '短剧' }
        ],
        list: []
    };
}

async function category(params) {
    const { categoryId, page } = params;
    const pg = parseInt(page) || 1;
    logInfo(`请求分类: ${categoryId}, 页码: ${pg}`);
    try {
        const res = await axiosInstance.post(`${host}/api.php/main_program/moviesAll/`, {
            type: categoryId || '',
            sort: 'vod_time',
            page: pg,
            limit: '60'
        }, { headers: headers });

        logInfo("分类接口返回原始数据", res.data);

        const r = {
            list: arr2vods(res.data.data.list),
            page: res.data.data.page || pg,
            pagecount: res.data.data.pagecount || 100
        };

        OmniBox.log("info", `category r：${JSON.stringify(r)}`)

        return r;
    } catch (e) {
        logError("分类请求失败", e);
        return { list: [], page: pg, pagecount: 0 };
    }
}

async function detail(params) {
    const videoId = params.videoId;
    logInfo(`请求详情 ID: ${videoId}`);
    try {
        const res = await axiosInstance.post(`${host}/api.php/player/details/`, { id: videoId }, { headers: headers });
        const data = res.data.detailData;

        logInfo("详情接口返回原始数据", data);

        // 修复：补全图片并解析播放源 [1][2]
        const playSources = parsePlaySources(data.vod_play_from, data.vod_play_url, data.vod_name);

        return {
            list: [{
                vod_id: String(data.vod_id),
                vod_name: data.vod_name,
                vod_pic: fixPicUrl(data.vod_pic),
                vod_content: data.vod_content,
                vod_play_sources: playSources, // 关键：荐片架构必须返回此数组
                vod_year: data.vod_year,
                vod_area: data.vod_area,
                vod_actor: data.vod_actor,
                type_name: data.vod_class
            }]
        };
    } catch (e) {
        logError("详情获取失败", e);
        return { list: [] };
    }
}

async function search(params) {
    const wd = params.keyword || params.wd || "";
    const pg = parseInt(params.page) || 1;
    logInfo(`搜索关键词: ${wd}, 页码: ${pg}`);
    try {
        const res = await axiosInstance.post(`${host}/api.php/search/syntheticalSearch/`, {
            keyword: wd,
            page: pg,
            limit: '20'
        }, { headers: headers });

        const data = res.data.data;
        const videos = [...arr2vods(data.chasingFanCorrelation), ...arr2vods(data.moviesCorrelation)];

        return {
            list: videos,
            page: pg,
            pagecount: data.pagecount || 10
        };
    } catch (e) {
        logError("搜索失败", e);
        return { list: [], page: pg, pagecount: 0 };
    }
}

async function play(params) {
    let playId = params.playId;
    logInfo(`准备播放 ID: ${playId}`);
    let vodName = "";
    let episodeName = "";

    if (playId && playId.includes('|')) {
        const parts = playId.split('|');
        playId = parts.shift() || '';
        vodName = parts.shift() || '';
        episodeName = parts.join('|') || '';
        logInfo(`解析透传信息 - 视频: ${vodName}, 集数: ${episodeName}`);
    }

    let url = '';

    try {
        const res = await axiosInstance.post(`${host}/api.php/player/payVideoUrl/`, { url: playId }, { headers: def_headers });
        logInfo("解析接口返回", res.data);
        url = res.data.data.url;
    } catch (e) {
        logError("解析播放地址失败", e);
    }

    const finalUrl = (url && url.startsWith('http')) ? url : playId;
    logInfo(`最终播放地址: ${finalUrl}`);

    const playResponse = {
        urls: [{ name: "极速云", url: finalUrl }],
        parse: 0,
        header: { ...def_headers, 'referer': 'https://docs.qq.com/' }
    };

    if (DANMU_API && vodName) {
        const fileName = buildFileNameForDanmu(vodName, episodeName);
        logInfo(`尝试匹配弹幕文件名: ${fileName}`);
        if (fileName) {
            const danmakuList = await matchDanmu(fileName);
            if (danmakuList && danmakuList.length > 0) {
                playResponse.danmaku = danmakuList;
                logInfo(`弹幕已添加到播放响应`);
            }
        }
    } else if (!DANMU_API) {
        logInfo("DANMU_API 未配置，跳过弹幕匹配");
    }

    return playResponse;
}

module.exports = { home, category, search, detail, play };

const runner = require("spider_runner");
runner.run(module.exports);
