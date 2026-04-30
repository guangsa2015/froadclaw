/**
 * web_search 工具 — 联网搜索，让 LLM 获取实时信息
 *
 * 使用 Bing 中国版（cn.bing.com），国内网络可直连，无需 API Key。
 * 工厂函数模式，按配置创建工具实例。
 */
import type { Tool, ToolResult } from "../types.js";
import type { ToolCallContext } from "../tool-context.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("tool-web-search");

/** 搜索结果条目 */
interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

/** 工厂函数配置 */
export interface WebSearchToolOptions {
  /** 搜索请求超时（ms） */
  timeoutMs: number;
  /** 抓取详情页最大体积（KB） */
  maxBodySizeKB: number;
  /** 是否抓取前 N 个结果的正文详情 */
  fetchDetail: boolean;
  /** 抓取详情的最大页面数 */
  fetchDetailMax: number;
}

const MAX_RESULTS = 6;
const BING_SEARCH_URL = "https://cn.bing.com/search";

/** 创建联网搜索工具 */
export function createWebSearchTool(options: WebSearchToolOptions): Tool {
  const { timeoutMs, maxBodySizeKB, fetchDetail, fetchDetailMax } = options;

  return {
    name: "web_search",
    description: `联网搜索实时信息。当用户询问最新新闻、实时数据、近期事件、天气、股市行情、赛事比分等需要最新信息的问题时，调用此工具。
注意：
- 搜索关键词应精简准确，中文搜索效果更好
- 适用场景：实时资讯、最新政策、近期事件、产品价格、天气预报等
- 不适用：通用知识问答、编程问题、数学计算等（这些你已经知道）`,
    systemHint: `web_search: 需要联网查询的内容。`,
    parameterSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索关键词，简洁精准，如'2026年3月沪深300ETF走势'、'今日A股大盘行情'",
        },
      },
      required: ["query"],
    },

    async execute(params: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
      const query = String(params["query"] ?? "").trim();
      if (!query) {
        return { content: "搜索关键词不能为空", isError: true };
      }

      log.info({ query }, "执行联网搜索");

      // Step 1: Bing 搜索
      const results = await bingSearch(query, timeoutMs);
      if (results.length === 0) {
        log.warn({ query }, "搜索无结果");
        return { content: `搜索"${query}"未找到相关结果，请尝试调整关键词。`, isError: false };
      }

      log.info({ query, resultCount: results.length }, "搜索返回 %d 条结果", results.length);

      // Step 2: 组装搜索摘要
      let output = `搜索关键词: ${query}\n搜索结果（共 ${results.length} 条）:\n\n`;

      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        output += `[${i + 1}] ${r.title}\n`;
        output += `    来源: ${r.url}\n`;
        if (r.snippet) {
          output += `    摘要: ${r.snippet}\n`;
        }
        output += "\n";
      }

      // Step 3: 可选——抓取前 N 个结果的正文详情
      if (fetchDetail && results.length > 0) {
        const detailCount = Math.min(results.length, fetchDetailMax);
        const detailPromises = results.slice(0, detailCount).map(async (r, i) => {
          try {
            const text = await fetchPageText(r.url, timeoutMs, maxBodySizeKB);
            if (text.length > 100) {
              return `\n--- 详情 [${i + 1}] ${r.title} ---\n${text}`;
            }
          } catch { /* 忽略单个页面失败 */ }
          return "";
        });

        const details = await Promise.all(detailPromises);
        const detailText = details.filter(Boolean).join("\n");
        if (detailText) {
          output += "\n=== 详细内容 ===\n" + detailText;
        }
      }

      log.info({ query, outputLen: output.length }, "搜索结果组装完成");
      return { content: output, isError: false };
    },
  };
}

// ─────────────── Bing 搜索引擎 ───────────────

/** Bing 中国版 HTML 搜索（免费，国内可直连） */
async function bingSearch(query: string, timeoutMs: number): Promise<SearchResultItem[]> {
  const url = `${BING_SEARCH_URL}?${new URLSearchParams({ q: query, setlang: "zh-CN" })}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Accept": "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });

    if (!resp.ok) {
      log.warn({ status: resp.status }, "Bing 搜索请求失败");
      return [];
    }

    const html = await resp.text();
    return parseBingResults(html);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      log.warn({ query }, "搜索请求超时");
    } else {
      log.error({ err, query }, "搜索请求异常");
    }
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析 Bing 搜索结果 HTML
 * 结构: <li class="b_algo"> → <h2><a href="...">标题</a></h2> → <div class="b_caption"><p>摘要</p>
 */
function parseBingResults(html: string): SearchResultItem[] {
  const results: SearchResultItem[] = [];

  // 提取所有 b_algo 结果块
  const algoRegex = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
  let algoMatch: RegExpExecArray | null;

  while ((algoMatch = algoRegex.exec(html)) !== null && results.length < MAX_RESULTS) {
    const block = algoMatch[1]!;

    // 提取标题和链接：<h2><a href="...">标题</a></h2>
    const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;

    const url = decodeHtmlEntities(titleMatch[1]!);
    const title = stripHtml(titleMatch[2]!).trim();
    if (!title || !url.startsWith("http")) continue;

    // 提取摘要：<div class="b_caption"><p>摘要</p> 或直接取 <p> 标签
    let snippet = "";
    const captionMatch = block.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    if (captionMatch) {
      snippet = stripHtml(captionMatch[1]!).trim();
    }

    results.push({ title, url, snippet });
  }

  return results;
}

// ─────────────── 页面正文抓取 ───────────────

/** 抓取单个 URL 的正文文本（轻量级提取） */
async function fetchPageText(url: string, timeoutMs: number, maxSizeKB: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    if (!resp.ok) return "";

    const contentType = resp.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) return "";

    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength > maxSizeKB * 1024) return "";

    const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    return extractMainContent(text);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/** 从 HTML 中提取主要文本内容 */
function extractMainContent(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "");

  text = stripHtml(text);
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  const maxChars = 3000;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + "\n[内容截断]";
  }
  return text;
}

// ─────────────── HTML 工具函数 ───────────────

/** 剥离所有 HTML 标签 */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
}

/** 解码 HTML 实体 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#0*183;/g, "·")
    .replace(/&ensp;/g, " ");
}
