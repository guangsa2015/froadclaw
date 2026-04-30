/**
 * 资讯工具 — 统一类型定义
 *
 * 所有数据源（渠道）必须将原始数据映射为 NewsItem，
 * 上层工具只依赖此统一结构，与具体渠道完全解耦。
 */

/** 标准化资讯条目 — 所有渠道的输出统一格式 */
export interface NewsItem {
  /** 来源渠道标识，如 "cls" "eastmoney" "sina" */
  source: string;
  /** 原始文章 ID（渠道内唯一） */
  sourceId: string;
  /** 发布时间（毫秒时间戳） */
  publishedAt: number;
  /** 标题（可为空） */
  title: string;
  /** 正文摘要 */
  summary: string;
  /** 重要程度：high / medium / low */
  importance: NewsImportance;
  /** 话题标签（可为空数组） */
  tags: string[];
  /** 原文链接（可选） */
  url?: string;
}

/** 资讯重要程度 */
export type NewsImportance = "high" | "medium" | "low";

/** 资讯获取参数 */
export interface NewsFetchOptions {
  /** 请求条数，默认 20 */
  count?: number;
  /** 请求超时（ms） */
  timeoutMs?: number;
}

/**
 * 资讯数据源接口 — 渠道契约
 *
 * 每个渠道实现此接口，完成：
 * 1. 原始数据抓取
 * 2. 映射为统一 NewsItem[]
 *
 * 上层不关心渠道细节，只消费 NewsItem。
 */
export interface NewsSource {
  /** 渠道唯一标识 */
  readonly id: string;
  /** 渠道中文名 */
  readonly name: string;
  /** 拉取最新资讯 */
  fetch(options?: NewsFetchOptions): Promise<NewsItem[]>;
}
