/**
 * 资讯入库服务
 *
 * 职责:
 * 1. 将 NewsItem[] 转为 NewsCacheRow 批量入库
 * 2. 基于 content_hash 进行跨源去重标记
 *
 * 哈希算法: 提取摘要中的关键词集合 → 排序 → 拼接 → 简单 hash
 * 目的是让"同一事件的不同渠道报道"产生相同 hash
 */
import type { SessionStore, NewsCacheRow } from "../../session/store/interface.js";
import type { NewsItem } from "./types.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("news-store");

/**
 * 从摘要中生成内容哈希
 *
 * 策略: 去除停用词 → 提取关键汉字/数字 → 取前 30 个 token → 排序 → 拼接 → 简单 hash
 * 同一事件在不同渠道的报道会包含相同的关键实体和数字，从而产生相同 hash
 */
export function contentHash(summary: string): string {
  // 提取所有中文词组（2字以上）和数字
  const tokens = summary
    .replace(/[^\u4e00-\u9fa5\d.%]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 30);

  // 排序保证顺序无关性
  tokens.sort();
  const raw = tokens.join("|");

  // FNV-1a 32bit hash → hex
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 将 NewsItem 转为入库行 */
function toRow(item: NewsItem): Omit<NewsCacheRow, "id"> {
  return {
    source: item.source,
    sourceId: item.sourceId,
    publishedAt: new Date(item.publishedAt).toISOString(),
    title: item.title,
    summary: item.summary,
    importance: item.importance,
    tags: JSON.stringify(item.tags),
    url: item.url ?? null,
    contentHash: contentHash(item.summary),
    llmStatus: "pending",
    llmReason: null,
    createdAt: Date.now(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 批量入库 + 跨源去重标记
 *
 * @returns 新插入条数
 */
export function persistNewsItems(store: SessionStore, items: NewsItem[]): number {
  if (items.length === 0) return 0;

  const rows = items.map(toRow);

  // 跨源去重: 如果 hash 已存在且已被 kept/dropped，则新条目直接标记 duplicate
  for (const row of rows) {
    const existing = store.findNewsByHash(row.contentHash);
    if (existing && existing.source !== row.source) {
      row.llmStatus = "duplicate";
      row.llmReason = `与 ${existing.source}:${existing.sourceId} 内容重复`;
    }
  }

  const inserted = store.insertNewsItems(rows);
  log.info({ total: items.length, inserted }, "资讯入库: %d 条, 新增 %d 条", items.length, inserted);
  return inserted;
}
