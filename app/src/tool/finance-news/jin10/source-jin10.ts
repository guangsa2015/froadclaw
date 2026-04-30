/**
 * 金十数据快讯数据源
 *
 * 接口: GET https://flash-api.jin10.com/get_flash_list
 * 特点: 无需签名、免费、国内直连、国际/期货/宏观覆盖最全
 *
 * 快讯流包含两种 type:
 *   type=0 — 新闻快讯（有 important 字段区分重要度）
 *   type=1 — 经济数据发布（即财经日历，有 star 星级）
 *
 * 入库策略:
 *   快讯: 仅入库 important=1 的加红条目
 *   经济数据: 仅入库 star >= 3 的重要数据
 *
 * 翻页: 用 max_time 参数传上一页最后一条的 time 字段
 *
 * 必要请求头:
 *   x-app-id: bVBF4FyRTn5NJF5n
 *   Referer: https://www.jin10.com/
 */
import type { NewsItem, NewsSource, NewsFetchOptions, NewsImportance } from "../types.js";
import { createLogger } from "../../../shared/logger.js";

const log = createLogger("news-jin10");

/* ────────────── 常量 ────────────── */

const JIN10_API_URL = "https://flash-api.jin10.com/get_flash_list";

/** 默认频道（综合快讯） */
const DEFAULT_CHANNEL = -8200;

/** 经济数据最低星级（含），低于此星级不入库 */
const MIN_DATA_STAR = 3;

/** 单次翻页最大页数 */
const MAX_PAGES = 5;

const DEFAULT_COUNT = 20;
const DEFAULT_TIMEOUT_MS = 15_000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

/** 请求必需的额外头 */
const EXTRA_HEADERS: Record<string, string> = {
  "x-app-id": "bVBF4FyRTn5NJF5n",
  "x-version": "1.0.0",
};

/* ────────────── 原始类型（仅声明必要字段） ────────────── */

/** 快讯条目（type=0）的 data 结构 */
interface Jin10FlashData {
  pic: string;
  title: string;
  source: string;
  content: string;
  vip_level?: number;
  source_link: string;
}

/** 经济数据条目（type=1）的 data 结构 */
interface Jin10EconData {
  name: string;
  country: string;
  star: number;
  actual: number | null;
  previous: string | null;
  consensus: string | null;
  affect: number;
  unit: string;
  pub_time: string;
  indicator_id: number;
  time_period: string;
}

/** 快讯列表中的单条原始数据 */
interface Jin10RawItem {
  id: string;
  time: string;
  type: number;
  data: Jin10FlashData & Jin10EconData;
  important: number;
  tags: unknown[] | null;
  channel: number[];
  remark: unknown[] | null;
  extras: { ad?: boolean } | null;
}

/** API 响应结构 */
interface Jin10ApiResponse {
  status: number;
  message: string;
  data: Jin10RawItem[];
}

/* ────────────── 映射逻辑 ────────────── */

/** 清理 HTML 标签，提取纯文本 */
function stripHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * 解析金十时间字符串为毫秒时间戳
 * 格式: "2026-03-26 23:28:20"
 */
function parseTime(timeStr: string): number {
  const ts = new Date(timeStr.replace(" ", "T") + "+08:00").getTime();
  return Number.isNaN(ts) ? Date.now() : ts;
}

/**
 * 从快讯 content 中提取标题和摘要
 *
 * 金十快讯 content 有两种格式：
 * 1. 【标题】正文内容...
 * 2. 纯正文（无标题，可能带 <b> 加粗）
 */
function extractTitleAndSummary(raw: Jin10RawItem): { title: string; summary: string } {
  // 优先使用 data.title 字段
  if (raw.data.title) {
    const summary = stripHtml(raw.data.content || "");
    return { title: raw.data.title.trim(), summary };
  }

  const text = stripHtml(raw.data.content || "");

  // 尝试匹配 【标题】 格式
  const titleMatch = text.match(/^【([^】]+)】/);
  if (titleMatch) {
    const title = titleMatch[1]!.trim();
    const summary = text.slice(titleMatch[0].length).trim();
    return { title, summary: summary || title };
  }

  return { title: "", summary: text };
}

/**
 * 经济数据的影响方向映射
 * affect: 0=无影响, 1=利多, 2=利空
 */
const AFFECT_LABEL: Record<number, string> = {
  0: "",
  1: "利多",
  2: "利空",
};

/**
 * 将经济数据（type=1）格式化为可读摘要
 */
function formatEconSummary(data: Jin10EconData): string {
  const stars = "★".repeat(data.star || 0);
  const actual = data.actual !== null ? String(data.actual) : "待公布";
  const prev = data.previous ?? "-";
  const consensus = data.consensus ?? "-";
  const affect = AFFECT_LABEL[data.affect] ?? "";
  const unit = data.unit || "";
  const period = data.time_period || "";

  const parts = [
    `${data.country}${period} ${data.name} ${stars}`,
    `前值:${prev}${unit} 预期:${consensus}${unit} 实际:${actual}${unit}`,
  ];
  if (affect) parts.push(`影响:${affect}`);
  return parts.join("\n");
}

/** 将快讯（type=0, important=1）映射为标准 NewsItem */
function flashToNewsItem(raw: Jin10RawItem): NewsItem {
  const { title, summary } = extractTitleAndSummary(raw);
  return {
    source: "jin10",
    sourceId: raw.id,
    publishedAt: parseTime(raw.time),
    title,
    summary,
    importance: "high" as NewsImportance,
    tags: [],
    url: `https://www.jin10.com/flash_detail/${raw.id}.html`,
  };
}

/** 将经济数据（type=1, star>=3）映射为标准 NewsItem */
function econToNewsItem(raw: Jin10RawItem): NewsItem {
  const data = raw.data as Jin10EconData;
  const importance: NewsImportance = data.star >= 4 ? "high" : "medium";

  return {
    source: "jin10",
    sourceId: raw.id,
    publishedAt: parseTime(raw.time),
    title: `${data.country} ${data.name}`,
    summary: formatEconSummary(data),
    importance,
    tags: [data.country, "经济数据"],
    url: `https://rili.jin10.com/`,
  };
}

/* ────────────── 单页请求 ────────────── */

async function fetchPage(
  maxTime: string | null,
  channel: number,
  timeoutMs: number,
): Promise<Jin10RawItem[]> {
  const params = new URLSearchParams({
    channel: String(channel),
    vip: "0",
  });
  if (maxTime) params.set("max_time", maxTime);

  const url = `${JIN10_API_URL}?${params.toString()}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      Referer: "https://www.jin10.com/",
      Origin: "https://www.jin10.com",
      ...EXTRA_HEADERS,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    log.warn({ status: resp.status }, "金十请求失败");
    return [];
  }

  const json = (await resp.json()) as Jin10ApiResponse;

  if (json.status !== 200 || !json.data) {
    log.warn({ status: json.status, message: json.message }, "金十返回异常");
    return [];
  }

  return json.data;
}

/* ────────────── NewsSource 实现 ────────────── */

/** 创建金十数据源实例 */
export function createJin10Source(): NewsSource {
  return {
    id: "jin10",
    name: "金十数据",

    async fetch(options?: NewsFetchOptions): Promise<NewsItem[]> {
      const count = options?.count ?? DEFAULT_COUNT;
      const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      log.info({ count }, "拉取金十数据快讯");

      const allRaw: Jin10RawItem[] = [];
      let maxTime: string | null = null;

      for (let page = 0; page < MAX_PAGES; page++) {
        try {
          const items = await fetchPage(maxTime, DEFAULT_CHANNEL, timeoutMs);
          if (items.length === 0) break;
          allRaw.push(...items);
          maxTime = items[items.length - 1]!.time;

          // 已收集足够的加红+经济数据则提前退出
          const collected = allRaw.filter(
            (it) => (it.type === 0 && it.important === 1) || (it.type === 1 && (it.data as Jin10EconData).star >= MIN_DATA_STAR),
          );
          if (collected.length >= count) break;
        } catch (err) {
          if (err instanceof Error && err.name === "TimeoutError") {
            log.warn({ page }, "金十第 %d 页请求超时", page + 1);
          } else {
            log.error({ err, page }, "金十第 %d 页请求异常", page + 1);
          }
          break;
        }
      }

      // 过滤: 快讯仅加红 + 经济数据仅高星级
      const flashItems = allRaw
        .filter((it) => it.type === 0 && it.important === 1)
        .filter((it) => !it.extras?.ad)
        .map(flashToNewsItem);

      const econItems = allRaw
        .filter((it) => it.type === 1 && (it.data as Jin10EconData).star >= MIN_DATA_STAR)
        .map(econToNewsItem);

      // ID 去重（翻页可能重复）
      const seen = new Set<string>();
      const unique = [...flashItems, ...econItems].filter((it) => {
        if (seen.has(it.sourceId)) return false;
        seen.add(it.sourceId);
        return true;
      });

      const result = unique.slice(0, count);
      log.info(
        { fetched: result.length, rawTotal: allRaw.length, flash: flashItems.length, econ: econItems.length },
        "金十数据拉取完成（加红%d + 经济数据%d）",
        flashItems.length,
        econItems.length,
      );
      return result;
    },
  };
}
