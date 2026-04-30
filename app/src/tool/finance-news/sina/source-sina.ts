/**
 * 新浪财经7x24数据源
 *
 * 接口: GET https://zhibo.sina.com.cn/api/zhibo/feed
 * 特点: 无需签名、免费、国内直连、港美股/全球市场覆盖最全
 *
 * 关键参数:
 *   zhibo_id=152  — 财经直播（固定值）
 *   page_size     — 每页条数（支持自定义，最大约 50）
 *   page          — 页码
 *   tag_id        — 分类标签（0=全部, 9=焦点, 102=国际）
 *   type=0        — 普通图文
 *
 * 单条结构:
 *   id            — 唯一ID
 *   rich_text     — 正文（Unicode 编码，需 unescape）
 *   create_time   — "2026-03-24 22:52:34"
 *   tag[]         — [{id:"102", name:"国际"}, ...]
 *   ext.stocks[]  — 关联股票 [{market:"hk", symbol:"04338", key:"微软"}]
 *   docurl        — 详情链接
 *   is_repeat     — "0"/"1" 标记重复内容
 */
import type { NewsItem, NewsSource, NewsFetchOptions, NewsImportance } from "../types.js";
import { createLogger } from "../../../shared/logger.js";

const log = createLogger("news-sina");

/* ────────────── 常量 ────────────── */

const SINA_API_URL = "https://zhibo.sina.com.cn/api/zhibo/feed";

/** 固定直播间ID: 财经7x24 */
const ZHIBO_ID = 152;

/** 默认拉取全部分类 */
const DEFAULT_TAG_ID = 0;

const DEFAULT_COUNT = 20;
const DEFAULT_TIMEOUT_MS = 15_000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

/** 焦点标签——用于判定重要度 */
const FOCUS_TAG_IDS = new Set(["9", "102"]);

/* ────────────── 原始类型 ────────────── */

interface SinaTag {
  id: string;
  name: string;
}

interface SinaStockRef {
  market: string;
  symbol: string;
  key: string;
}

interface SinaRawItem {
  id: number;
  rich_text: string;
  create_time: string;
  tag: SinaTag[];
  ext: string;
  docurl: string;
  is_repeat: string;
  is_focus: number;
  top_value: number;
}

interface SinaApiResponse {
  result: {
    status: { code: number; msg: string };
    data: {
      feed: {
        list: SinaRawItem[];
        page_info: { totalPage: number; page: number };
      };
    };
  };
}

/* ────────────── 映射逻辑 ────────────── */

/**
 * 解析时间字符串为毫秒时间戳
 * 格式: "2026-03-24 22:52:34"
 */
function parseCreateTime(timeStr: string): number {
  const ts = new Date(timeStr.replace(" ", "T") + "+08:00").getTime();
  return Number.isNaN(ts) ? Date.now() : ts;
}

/** 从 ext JSON 中提取关联股票 */
function parseStocks(extJson: string): SinaStockRef[] {
  try {
    const ext = JSON.parse(extJson) as { stocks?: SinaStockRef[] };
    return ext.stocks ?? [];
  } catch {
    return [];
  }
}

/**
 * 从 rich_text 中提取标题和摘要
 *
 * 新浪7x24的 rich_text 有两种格式：
 * 1. 【标题】正文内容...
 * 2. 纯正文（无标题）
 */
function extractTitleAndSummary(richText: string): { title: string; summary: string } {
  const text = richText.trim();

  // 尝试匹配 【标题】 格式
  const titleMatch = text.match(/^【([^】]+)】/);
  if (titleMatch) {
    const title = titleMatch[1]!.trim();
    const summary = text.slice(titleMatch[0].length).trim();
    return { title, summary: summary || title };
  }

  // 无标题：截取前30字作为标题
  const briefTitle = text.length > 30 ? text.slice(0, 30) + "..." : text;
  return { title: "", summary: briefTitle.length > 0 ? text : "" };
}

/**
 * 判定重要度
 *
 * 规则:
 * - top_value > 0 或 is_focus=1 → high
 * - 包含焦点/国际标签 → medium
 * - 其他 → low
 */
function mapImportance(raw: SinaRawItem): NewsImportance {
  if (raw.top_value > 0 || raw.is_focus === 1) return "high";
  if (raw.tag.some((t) => FOCUS_TAG_IDS.has(t.id))) return "medium";
  return "low";
}

/** 将单条原始数据映射为标准 NewsItem */
function toNewsItem(raw: SinaRawItem): NewsItem {
  const { title, summary } = extractTitleAndSummary(raw.rich_text);
  const stocks = parseStocks(raw.ext);

  // 标签 = 分类标签 + 关联股票名（去重）
  const tagSet = new Set<string>();
  for (const t of raw.tag) { if (t.name) tagSet.add(t.name); }
  for (const s of stocks) { if (s.key) tagSet.add(s.key); }
  const tags = [...tagSet];

  return {
    source: "sina",
    sourceId: String(raw.id),
    publishedAt: parseCreateTime(raw.create_time),
    title,
    summary,
    importance: mapImportance(raw),
    tags,
    url: raw.docurl || undefined,
  };
}

/* ────────────── NewsSource 实现 ────────────── */

/** 创建新浪财经7x24数据源实例 */
export function createSinaSource(): NewsSource {
  return {
    id: "sina",
    name: "新浪财经",

    async fetch(options?: NewsFetchOptions): Promise<NewsItem[]> {
      const count = options?.count ?? DEFAULT_COUNT;
      const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      // 新浪 page_size 支持自定义，一次请求即可拿够
      const pageSize = Math.min(count, 50);

      const params = new URLSearchParams({
        zhibo_id: String(ZHIBO_ID),
        page: "1",
        page_size: String(pageSize),
        tag_id: String(DEFAULT_TAG_ID),
        type: "0",
      });
      const url = `${SINA_API_URL}?${params.toString()}`;

      log.info({ count, pageSize }, "拉取新浪财经7x24资讯");

      try {
        const resp = await fetch(url, {
          method: "GET",
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json",
            Referer: "https://finance.sina.com.cn/7x24/",
          },
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!resp.ok) {
          log.warn({ status: resp.status }, "新浪请求失败");
          return [];
        }

        const json = (await resp.json()) as SinaApiResponse;

        if (json.result.status.code !== 0) {
          log.warn({ code: json.result.status.code, msg: json.result.status.msg }, "新浪返回错误");
          return [];
        }

        const rawList = json.result.data.feed.list;

        // 过滤重复内容（is_repeat="1" 的跳过）+ 标题去重
        const seenTitle = new Set<string>();
        const filtered = rawList.filter((item) => {
          if (item.is_repeat === "1") return false;
          const { title } = extractTitleAndSummary(item.rich_text);
          if (title && seenTitle.has(title)) return false;
          if (title) seenTitle.add(title);
          return true;
        });

        const items = filtered.slice(0, count).map(toNewsItem);
        log.info({ fetched: items.length, rawTotal: rawList.length, afterFilter: filtered.length }, "新浪资讯拉取完成");
        return items;
      } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") {
          log.warn("新浪请求超时");
        } else {
          log.error({ err }, "新浪请求异常");
        }
        return [];
      }
    },
  };
}
