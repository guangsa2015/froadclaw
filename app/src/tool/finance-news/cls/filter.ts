/**
 * 资讯本地过滤器
 *
 * 职责：对多渠道汇聚后的 NewsItem[] 进行本地筛选排序，
 * 在送入 LLM 前减少无效信息，节省 token。
 *
 * 过滤流水线：去重 → 重要度筛选 → 时间排序 → 截断
 */
import type { NewsItem, NewsImportance } from "../types.js";

/** 过滤器配置 */
export interface NewsFilterOptions {
  /** 最低重要度（含），low=全部, medium=中高, high=仅高 */
  minImportance?: NewsImportance;
  /** 最大返回条数 */
  maxItems?: number;
  /** 只保留最近 N 小时内的资讯，0 表示不限 */
  withinHours?: number;
}

/** 重要度权重，用于排序和筛选 */
const IMPORTANCE_WEIGHT: Record<NewsImportance, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * 过滤并排序资讯列表
 *
 * 流水线：
 * 1. 去重（source + sourceId 组合键）
 * 2. 时间范围过滤
 * 3. 重要度筛选
 * 4. 排序：重要度降序 → 时间降序
 * 5. 截断
 */
export function filterNews(
  items: NewsItem[],
  options?: NewsFilterOptions,
): NewsItem[] {
  const minImportance = options?.minImportance ?? "low";
  const maxItems = options?.maxItems ?? 15;
  const withinHours = options?.withinHours ?? 0;

  const minWeight = IMPORTANCE_WEIGHT[minImportance];
  const cutoffMs = withinHours > 0
    ? Date.now() - withinHours * 3600_000
    : 0;

  // Step 1: 去重
  const seen = new Set<string>();
  const unique: NewsItem[] = [];
  for (const item of items) {
    const key = `${item.source}:${item.sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  // Step 2 + 3: 时间 + 重要度过滤
  const filtered = unique.filter((item) => {
    if (cutoffMs > 0 && item.publishedAt < cutoffMs) return false;
    return IMPORTANCE_WEIGHT[item.importance] >= minWeight;
  });

  // Step 4: 排序 — 重要度降序，同级按时间降序
  filtered.sort((a, b) => {
    const wDiff = IMPORTANCE_WEIGHT[b.importance] - IMPORTANCE_WEIGHT[a.importance];
    if (wDiff !== 0) return wDiff;
    return b.publishedAt - a.publishedAt;
  });

  // Step 5: 截断
  return filtered.slice(0, maxItems);
}
