/**
 * 东方财富资讯数据源
 *
 * 接口: GET https://np-listapi.eastmoney.com/comm/web/getNewsByColumns
 * 特点: 无需签名、免费、国内直连、聚合多家媒体（财联社/新华社/21世纪等）
 *
 * 频道映射 (column):
 *   350 — 综合实时要闻
 *   351 — 国际/时政
 *   353 — 快讯/市场短消息（默认，信噪比更高）
 *
 * 限制:
 *   - 单页固定最多 10 条，pageSize 参数不生效
 *   - 支持 page_index 分页翻页
 *   - 需要 req_trace 随机追踪 ID
 */
import type { NewsItem, NewsSource, NewsFetchOptions } from "../types.js";
import { createLogger } from "../../../shared/logger.js";

const log = createLogger("news-dfcf");

/* ────────────── 常量 ────────────── */

const DFCF_API_URL = "https://np-listapi.eastmoney.com/comm/web/getNewsByColumns";

/** 默认频道: 快讯/市场短消息（信噪比高于综合要闻） */
const DEFAULT_COLUMN = 353;

/** 每页固定返回条数（API 限制） */
const PAGE_SIZE = 10;

/** 最大翻页数，防止无限请求 */
const MAX_PAGES = 5;

const DEFAULT_COUNT = 20;
const DEFAULT_TIMEOUT_MS = 15_000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

/* ────────────── 原始类型 ────────────── */

interface DfcfRawItem {
  /** 文章唯一编码 */
  code: string;
  /** 标题 */
  title: string;
  /** 摘要/正文 */
  summary: string;
  /** 发布时间: "2026-03-24 16:34:30" */
  showTime: string;
  /** 来源媒体 */
  mediaName: string;
  /** 原文链接 */
  uniqueUrl: string;
  /** 排序权重 */
  realSort: string;
}

interface DfcfApiResponse {
  code: string;
  message: string;
  data: {
    page_index: number;
    list: DfcfRawItem[];
  } | null;
}

/* ────────────── 映射逻辑 ────────────── */

/** 生成随机请求追踪 ID */
function genReqTrace(): string {
  return "0b2" + Math.random().toString(36).slice(2, 10);
}

/**
 * 解析东方财富时间字符串为毫秒时间戳
 * 格式: "2026-03-24 16:34:30"
 */
function parseShowTime(showTime: string): number {
  const ts = new Date(showTime + "+08:00").getTime();
  return Number.isNaN(ts) ? Date.now() : ts;
}

/** 清理摘要中的 HTML 标签和 【】包裹的标题前缀 */
function cleanSummary(summary: string): string {
  return summary
    .replace(/<[^>]+>/g, "")
    .replace(/^【[^】]*】/, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 将单条原始数据映射为标准 NewsItem */
function toNewsItem(raw: DfcfRawItem): NewsItem {
  return {
    source: "dfcf",
    sourceId: raw.code,
    publishedAt: parseShowTime(raw.showTime),
    title: raw.title?.trim() || "",
    summary: cleanSummary(raw.summary || ""),
    // 东方财富 API 无重要度字段，统一标记 medium，由 LLM 二次筛选决定
    importance: "medium",
    tags: raw.mediaName ? [raw.mediaName] : [],
    url: raw.uniqueUrl || undefined,
  };
}

/* ────────────── 单页请求 ────────────── */

async function fetchPage(
  pageIndex: number,
  column: number,
  reqTrace: string,
  timeoutMs: number,
): Promise<DfcfRawItem[]> {
  const params = new URLSearchParams({
    column: String(column),
    pageSize: String(PAGE_SIZE),
    page_index: String(pageIndex),
    client: "web",
    biz: "web_kx",
    req_trace: reqTrace,
  });
  const url = `${DFCF_API_URL}?${params.toString()}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      Referer: "https://www.eastmoney.com/",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    log.warn({ status: resp.status, pageIndex }, "东方财富请求失败");
    return [];
  }

  const json = (await resp.json()) as DfcfApiResponse;

  if (json.code !== "1" || !json.data?.list) {
    log.warn({ code: json.code, message: json.message }, "东方财富返回异常");
    return [];
  }

  return json.data.list;
}

/* ────────────── NewsSource 实现 ────────────── */

/** 创建东方财富数据源实例 */
export function createEastmoneySource(): NewsSource {
  return {
    id: "dfcf",
    name: "东方财富",

    async fetch(options?: NewsFetchOptions): Promise<NewsItem[]> {
      const count = options?.count ?? DEFAULT_COUNT;
      const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const reqTrace = genReqTrace();
      const pages = Math.min(Math.ceil(count / PAGE_SIZE), MAX_PAGES);

      log.info({ count, pages }, "拉取东方财富资讯");

      const allItems: DfcfRawItem[] = [];

      for (let page = 1; page <= pages; page++) {
        try {
          const items = await fetchPage(page, DEFAULT_COLUMN, reqTrace, timeoutMs);
          if (items.length === 0) break;
          allItems.push(...items);
          // 已够数则提前退出
          if (allItems.length >= count) break;
        } catch (err) {
          if (err instanceof Error && err.name === "TimeoutError") {
            log.warn({ page }, "东方财富第 %d 页请求超时", page);
          } else {
            log.error({ err, page }, "东方财富第 %d 页请求异常", page);
          }
          break;
        }
      }

      // 去重: 1) code 去重（跨页可能重复）
      const seenCode = new Set<string>();
      const uniqueByCode = allItems.filter((it) => {
        if (seenCode.has(it.code)) return false;
        seenCode.add(it.code);
        return true;
      });

      // 去重: 2) 标题去重（东方财富聚合多家媒体，同一新闻不同code但标题相同）
      const seenTitle = new Set<string>();
      const unique = uniqueByCode.filter((it) => {
        const normalizedTitle = it.title?.trim();
        if (!normalizedTitle) return true; // 无标题的保留
        if (seenTitle.has(normalizedTitle)) {
          log.debug({ code: it.code, title: normalizedTitle }, "标题去重: 跳过重复条目");
          return false;
        }
        seenTitle.add(normalizedTitle);
        return true;
      });

      if (uniqueByCode.length !== unique.length) {
        log.info(
          { before: uniqueByCode.length, after: unique.length, dropped: uniqueByCode.length - unique.length },
          "东方财富标题去重: 去除 %d 条同标题重复",
          uniqueByCode.length - unique.length,
        );
      }

      const result = unique.slice(0, count).map(toNewsItem);
      log.info({ fetched: result.length }, "东方财富资讯拉取完成");
      return result;
    },
  };
}
