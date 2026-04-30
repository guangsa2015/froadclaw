/**
 * 场景分类器 — 自动区分工作（财经）与生活场景
 *
 * 判定逻辑：
 *   1. 关键词命中 → 直接判定
 *   2. 上下文连续性 — 如果最近几条都是同一场景，默认延续
 */
import type { ChatMessage } from "../llm/types.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("scene-classifier");

export type Scene = "work" | "life";

/** 财经/投资相关关键词（部分匹配即可） */
const WORK_KEYWORDS = [
  // 市场
  "股", "A股", "港股", "美股", "大盘", "指数", "ETF", "基金", "期货", "期权", "债券",
  "板块", "涨停", "跌停", "涨幅", "跌幅", "成交量", "换手率", "市值", "估值",
  // 财经
  "财经", "财报", "年报", "季报", "利润", "营收", "净资产", "ROE", "PE", "PB", "市盈率",
  "分红", "股息", "派息", "送股", "配股",
  // 投资
  "投资", "仓位", "持仓", "加仓", "减仓", "止损", "止盈", "套利", "对冲",
  "牛市", "熊市", "行情", "走势", "K线", "均线", "MACD", "RSI", "布林",
  // 宏观
  "GDP", "CPI", "PPI", "PMI", "降息", "加息", "利率", "汇率", "央行",
  "货币政策", "财政政策", "通胀", "通缩", "降准",
  // 具体标的
  "恒生", "纳斯达克", "标普", "道琼斯", "上证", "深证", "创业板", "科创板",
  "茅台", "腾讯", "阿里", "比亚迪", "宁德",
  // 命令词
  "/analyze",
];

/** 判定单条消息是否命中工作场景 */
function matchesWorkScene(text: string): boolean {
  const normalized = text.toUpperCase();
  return WORK_KEYWORDS.some(kw => normalized.includes(kw.toUpperCase()));
}

/**
 * 分类当前消息场景
 *
 * @param currentContent 当前用户消息
 * @param recentMessages 最近的消息历史（用于上下文延续判断）
 * @returns 场景类型
 */
export function classifyScene(currentContent: string, recentMessages: ChatMessage[]): Scene {
  // 1. 当前消息直接命中
  if (matchesWorkScene(currentContent)) {
    log.debug({ scene: "work", reason: "keyword" }, "场景判定: work (关键词命中)");
    return "work";
  }

  // 2. 检查最近 3 轮用户消息的上下文连续性
  const recentUserMsgs = recentMessages
    .filter(m => m.role === "user" && m.content)
    .slice(-3);

  const recentWorkCount = recentUserMsgs.filter(m => matchesWorkScene(m.content!)).length;

  // 最近 3 条中有 2 条以上是工作场景 → 延续工作场景
  if (recentWorkCount >= 2) {
    log.debug({ scene: "work", reason: "context", recentWorkCount }, "场景判定: work (上下文延续)");
    return "work";
  }

  log.debug({ scene: "life", reason: "default" }, "场景判定: life");
  return "life";
}
