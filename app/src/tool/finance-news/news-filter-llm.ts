/**
 * LLM 二次筛选 — 批量对 pending 资讯进行语义过滤
 *
 * 职责:
 * 1. 将待筛选条目格式化为 prompt
 * 2. 调用 flash 模型做批量判断
 * 3. 解析返回的 JSON 结果
 * 4. 更新 news_cache.llm_status
 *
 * 设计决策:
 * - 一次发 30~50 条，单次 LLM 调用完成
 * - 用 flash 模型（便宜快），不走主对话模型
 * - 返回结构化 JSON，便于解析更新
 */
import type { Provider, ChatMessage } from "../../llm/types.js";
import type { SessionStore, NewsCacheRow } from "../../session/store/interface.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("news-llm-filter");

/** 筛选配置 */
export interface NewsLlmFilterOptions {
  /** LLM Provider 实例 */
  provider: Provider;
  /** 使用的模型 ID（推荐 flash 级别） */
  model: string;
  /** SessionStore 实例 */
  store: SessionStore;
  /** 单次最大筛选条数 */
  batchSize?: number;
}

/** LLM 返回的单条筛选结果 */
interface FilterDecision {
  id: number;
  status: "kept" | "dropped" | "duplicate";
  reason?: string;
}

/** 构建筛选 prompt */
function buildFilterPrompt(items: NewsCacheRow[]): ChatMessage[] {
  const itemsList = items.map((it) => {
    const time = new Date(it.publishedAt).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const impTag = it.importance === "high" ? " [加红]" : it.importance === "medium" ? " [加粗]" : "";
    return `[ID:${it.id}] [${time}] [${it.source}]${impTag} ${it.title || "(快讯)"}\n${it.summary.slice(0, 150)}`;
  }).join("\n---\n");

  const systemPrompt = `你是财经资讯筛选助手，为一位关注宏观经济和ETF投资的用户筛选资讯。

## 用户关注领域（优先保留）
- A股/港股大盘走势、指数涨跌（沪深300、创业板、恒生科技）
- 宏观经济政策（央行货币政策、财政政策、监管动态）
- 重要经济数据发布（GDP、CPI、PMI、社融、进出口等）
- 期货与大宗商品（原油、黄金、有色金属）
- 国际市场联动（美股、美债、美联储、地缘政治对市场影响）
- 行业重大事件（科技、新能源、半导体等影响指数权重的板块）
- ETF/基金相关（规模变动、折溢价、申赎异动）

## 筛选规则
**kept** — 符合上述关注领域，或有实质信息价值的财经资讯
**dropped** — 满足任一条件:
- 纯广告/软文/研报营销（如"这家公司"式荐股）
- 无具体数据的水文（空泛标题无实质内容）
- 地方政务宣传、招商活动、论坛发言稿
- 非财经内容（社会新闻、天文科技、纯政治外交）
- 单只个股的琐碎公告（停复牌、小额回购等，除非涉及权重股或异常波动）
**duplicate** — 同一事件保留最详细的一条，其余标 duplicate

## 特殊标记
- [加红] 条目为渠道编辑推荐，优先保留（除非是广告）
- 涉及沪深300/创业板/恒生科技成分股的重大新闻优先保留

## 输出格式（严格JSON数组，不要markdown包裹）
[{"id":123,"status":"kept"},{"id":456,"status":"dropped","reason":"软文"},{"id":789,"status":"duplicate","reason":"同ID:123"}]

## 注意
- 每条都必须判断，不可遗漏
- 宁留勿删，不确定就保留
- reason 尽量简短（≤10字），kept 不写 reason`;

  return [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: `筛选以下 ${items.length} 条:\n\n${itemsList}` },
  ];
}

/** 解析 LLM 返回的 JSON 结果 */
function parseFilterResult(content: string, itemIds: Set<number>): FilterDecision[] {
  // 尝试提取 JSON 数组（兼容 LLM 可能包裹在 markdown code block 中）
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    log.warn("LLM 返回内容中未找到 JSON 数组");
    return [];
  }

  try {
    const raw = JSON.parse(jsonMatch[0]) as unknown[];
    const decisions: FilterDecision[] = [];

    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const obj = item as Record<string, unknown>;
      const id = Number(obj["id"]);
      const status = String(obj["status"] ?? "");
      const reason = obj["reason"] ? String(obj["reason"]) : undefined;

      if (!itemIds.has(id)) continue;
      if (!["kept", "dropped", "duplicate"].includes(status)) continue;

      decisions.push({ id, status: status as FilterDecision["status"], reason });
    }

    return decisions;
  } catch (err) {
    log.warn({ err }, "解析 LLM 筛选结果 JSON 失败");
    return [];
  }
}

/**
 * 对 pending 资讯执行 LLM 二次筛选
 *
 * @param withinHours 筛选最近 N 小时内的 pending 条目
 * @returns 本次筛选处理的条目数
 */
export async function filterNewsByLlm(
  options: NewsLlmFilterOptions,
  withinHours: number = 48,
): Promise<number> {
  const { provider, model, store, batchSize = 40 } = options;

  const pending = store.getPendingNews(withinHours, batchSize);
  if (pending.length === 0) {
    log.debug("无待筛选资讯");
    return 0;
  }

  log.info({ count: pending.length, model }, "开始 LLM 资讯筛选: %d 条", pending.length);

  const messages = buildFilterPrompt(pending);
  const itemIds = new Set(pending.map((it) => it.id));

  try {
    const resp = await provider.chatCompletion({
      model,
      messages,
      temperature: 0.1,
      maxTokens: 4096,
      enableThinking: false,
    });

    const decisions = parseFilterResult(resp.content, itemIds);
    log.info(
      { parsed: decisions.length, total: pending.length,
        promptTokens: resp.usage.promptTokens, completionTokens: resp.usage.completionTokens },
      "LLM 筛选完成: 解析 %d/%d 条",
      decisions.length,
      pending.length,
    );

    if (decisions.length > 0) {
      store.updateNewsLlmStatus(decisions);
    }

    // 未被 LLM 覆盖的条目默认保留（宁留勿删）
    const decidedIds = new Set(decisions.map((d) => d.id));
    const fallback = pending
      .filter((it) => !decidedIds.has(it.id))
      .map((it) => ({ id: it.id, status: "kept" as const, reason: "LLM 未覆盖，默认保留" }));

    if (fallback.length > 0) {
      store.updateNewsLlmStatus(fallback);
      log.info({ count: fallback.length }, "LLM 未覆盖 %d 条，默认标记 kept", fallback.length);
    }

    return pending.length;
  } catch (err) {
    log.error({ err }, "LLM 筛选调用失败，全部默认保留");
    // 失败时 fallback: 全部标记 kept，确保用户不会看到空
    store.updateNewsLlmStatus(pending.map((it) => ({ id: it.id, status: "kept" })));
    return pending.length;
  }
}
