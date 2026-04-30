/**
 * 财联社电报数据源
 *
 * 接口: GET https://www.cls.cn/nodeapi/telegraphList
 * 特点: 无需签名、免费、国内直连、响应快（~400ms）
 *
 * 原始字段映射:
 *   level A/B + recommend=1 → high
 *   level B + recommend=0   → medium
 *   level C                 → low
 */
import type { NewsItem, NewsSource, NewsFetchOptions, NewsImportance } from "../types.js";
import { createLogger } from "../../../shared/logger.js";

const log = createLogger("news-cls");

/* ────────────── 常量 ────────────── */

const CLS_API_URL = "https://www.cls.cn/nodeapi/telegraphList";

/** 默认请求参数 */
const BASE_PARAMS: Record<string, string> = {
  app: "CailianpressWeb",
  os: "web",
  sv: "8.4.6",
};

const DEFAULT_COUNT = 20;
const DEFAULT_TIMEOUT_MS = 15_000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

/* ────────────── 原始类型（仅声明必要字段） ────────────── */

interface ClsRawItem {
  id: number;
  ctime: number;
  content: string;
  brief: string;
  title: string;
  level: string;
  recommend: number;
  bold: number;
  subjects: Array<{ subject_id: number; subject_name: string }>;
}

interface ClsApiResponse {
  error: number;
  data: {
    roll_data: ClsRawItem[];
  };
}

/* ────────────── 映射逻辑 ────────────── */

/**
 * 将 CLS level + recommend + bold 映射为统一重要度
 *
 * 加红（recommend=1 或 level A）→ high
 * 加粗（bold=1 或 level B）      → medium
 * 其余                            → low
 */
function mapImportance(level: string, recommend: number, bold: number): NewsImportance {
  if (recommend === 1 || level === "A") return "high";
  if (bold === 1 || level === "B") return "medium";
  return "low";
}

/** 清理 HTML 标签，提取纯文本 */
function stripHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 将单条原始数据映射为标准 NewsItem */
function toNewsItem(raw: ClsRawItem): NewsItem {
  const title = raw.title?.trim() || "";
  const summary = stripHtml(raw.brief || raw.content || "");

  return {
    source: "cls",
    sourceId: String(raw.id),
    publishedAt: raw.ctime * 1000,
    title,
    summary,
    importance: mapImportance(raw.level, raw.recommend, raw.bold ?? 0),
    tags: raw.subjects?.map((s) => s.subject_name) ?? [],
    url: `https://www.cls.cn/detail/${raw.id}`,
  };
}

/* ────────────── NewsSource 实现 ────────────── */

/** 创建财联社数据源实例 */
export function createClsSource(): NewsSource {
  return {
    id: "cls",
    name: "财联社",

    async fetch(options?: NewsFetchOptions): Promise<NewsItem[]> {
      const count = options?.count ?? DEFAULT_COUNT;
      const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      const params = new URLSearchParams({
        ...BASE_PARAMS,
        rn: String(count),
        page: "1",
      });
      const url = `${CLS_API_URL}?${params.toString()}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        log.info({ count }, "拉取财联社电报");

        const resp = await fetch(url, {
          method: "GET",
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json",
            Referer: "https://www.cls.cn/telegraph",
          },
          signal: controller.signal,
        });

        if (!resp.ok) {
          log.warn({ status: resp.status }, "财联社请求失败");
          return [];
        }

        const json = (await resp.json()) as ClsApiResponse;

        if (json.error !== 0) {
          log.warn({ error: json.error }, "财联社返回错误码");
          return [];
        }

        const items = json.data.roll_data
          .filter((raw) => raw.recommend === 1)
          .filter((raw) => !raw.title?.includes("盘中宝"))
          .map(toNewsItem);
        log.info({ fetched: items.length, rawTotal: json.data.roll_data.length }, "财联社电报拉取完成（仅加红）");
        return items;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          log.warn("财联社请求超时");
        } else {
          log.error({ err }, "财联社请求异常");
        }
        return [];
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
