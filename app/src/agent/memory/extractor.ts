/**
 * Tier 3: 用户画像抽取器 — 从摘要中异步提取长期记忆（偏好/观点/风格）
 * 每次抽取时将已有画像一并喂给 LLM，由 LLM 负责语义去重 + 合并 + 淘汰过时条目
 */

import type { Provider } from "../../llm/types.js";
import type { SessionStore } from "../../session/store/interface.js";
import type { UserMemoryRow } from "../../session/store/interface.js";
import { jaccardSimilarity } from "../../shared/similarity.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("memory-extractor");

/** 每个 category 的条目上限 */
const MAX_PER_CATEGORY = 10;
/** 所有 category 条目总上限 */
const MAX_TOTAL = 25;

const VALID_CATEGORIES = new Set(["preference", "viewpoint", "style"]);

function buildExtractPrompt(existingMemories: UserMemoryRow[]): string {
  const existingBlock = existingMemories.length > 0
    ? `\n\n## 当前已有画像\n${formatExisting(existingMemories)}\n`
    : "";

  return `你是用户画像管理助手。根据对话摘要，维护用户的长期特征画像。
${existingBlock}
## 任务
结合对话摘要和已有画像，输出**合并去重后的完整画像列表**。

## 输出格式
JSON 数组，每项：{"action": "keep|add|update|remove", "category": "xxx", "content": "yyy"}
- keep: 保留已有条目不变（content 必须与已有条目完全一致）
- add: 新增条目
- update: 更新已有条目（语义相近但措辞更准确，或需要合并多条为一条）
- remove: 淘汰过时或不再成立的条目

## category 取值
- preference: 用户偏好（如：关注港股、偏好简洁回答）
- viewpoint: 核心观点和判断（如：看好新能源、认为A股估值偏低）
- style: 交互风格（如：不要寒暄、直接给结论）

## 规则
1. **语义去重**：含义相近的条目必须合并为一条（如"关注港股行情"和"对港股感兴趣"→"关注港股"）
2. **淘汰过时**：如果摘要表明用户观点已变化，标记旧条目为 remove
3. **排除系统行为**：不要将AI自身的行为准则、能力边界、工具使用方式提取为用户画像。例如"AI不应虚构能力""需要联网搜索""AI应标注数据来源"等描述的是AI行为而非用户特征，必须 remove
4. **排除测试行为**：用户单次测试某功能（如测试定时提醒、测试搜索）不代表长期偏好，不要提取
5. 每条 content 不超过 30 字，只保留有长期价值的**用户自身**特征
6. 每个 category 不超过 ${MAX_PER_CATEGORY} 条，总数不超过 ${MAX_TOTAL} 条
7. 如果无变化，返回所有已有条目的 keep 列表
8. 只输出 JSON，不要其他文字`;
}

function formatExisting(memories: UserMemoryRow[]): string {
  const labels: Record<string, string> = { preference: "偏好", viewpoint: "核心观点", style: "交互风格" };
  return memories.map((m) => `- [${labels[m.category] ?? m.category}] ${m.content}`).join("\n");
}

export interface ExtractorDeps {
  provider: Provider;
  model: string;
  store: SessionStore;
  /** 冷却时间（分钟），0 表示不限制 */
  cooldownMinutes: number;
  /** 上一次的摘要文本（用于变化率检测） */
  previousSummary?: string | null;
  /** Jaccard 相似度阈值（0~1），超过则跳过抽取，0 表示不检测 */
  similarityThreshold?: number;
}

interface ExtractedAction {
  action: "keep" | "add" | "update" | "remove";
  category: string;
  content: string;
}

/**
 * 异步抽取用户画像 — 不阻塞主流程
 * 将已有画像 + 新摘要一起喂给 LLM，由 LLM 做语义去重后全量替换
 */
export async function extractUserMemory(
  userId: string,
  sessionId: string,
  summary: string,
  deps: ExtractorDeps,
): Promise<void> {
  if (!summary) return;

  // 冷却检查：距上次抽取不足 N 分钟则跳过
  if (deps.cooldownMinutes > 0) {
    const lastTime = deps.store.getLastExtractTime(userId);
    if (lastTime) {
      const elapsed = Date.now() - new Date(lastTime).getTime();
      const cooldownMs = deps.cooldownMinutes * 60_000;
      if (elapsed < cooldownMs) {
        const remainMin = Math.ceil((cooldownMs - elapsed) / 60_000);
        log.info({ userId, lastTime, remainMin }, "画像抽取冷却中，距下次还剩 %d 分钟", remainMin);
        return;
      }
    }
  }

  // 摘要变化率检测：新旧摘要相似度超过阈值则跳过
  const threshold = deps.similarityThreshold ?? 0;
  if (threshold > 0 && deps.previousSummary) {
    const similarity = jaccardSimilarity(deps.previousSummary, summary);
    if (similarity >= threshold) {
      log.info(
        { userId, similarity: similarity.toFixed(3), threshold },
        "摘要变化率过低 (Jaccard=%s >= %s)，跳过画像抽取",
        similarity.toFixed(3),
        threshold,
      );
      return;
    }
    log.info(
      { userId, similarity: similarity.toFixed(3), threshold },
      "摘要有变化 (Jaccard=%s < %s)，继续画像抽取",
      similarity.toFixed(3),
      threshold,
    );
  }

  const existingMemories = deps.store.getUserMemories(userId);
  log.info(
    { userId, sessionId, summaryLen: summary.length, existingCount: existingMemories.length },
    "开始抽取用户画像 (已有 %d 条)",
    existingMemories.length,
  );

  try {
    const systemPrompt = buildExtractPrompt(existingMemories);
    const resp = await deps.provider.chatCompletion({
      model: deps.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `对话摘要：\n${summary}` },
      ],
      temperature: 0.2,
    });

    let actions: ExtractedAction[];
    try {
      const cleaned = resp.content.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
      actions = JSON.parse(cleaned) as ExtractedAction[];
    } catch {
      log.warn({ userId, raw: resp.content.slice(0, 200) }, "画像抽取返回非 JSON，跳过");
      return;
    }

    if (!Array.isArray(actions) || actions.length === 0) return;

    // 构建最终画像列表：keep + add + update 的条目
    const finalMemories: Array<{ category: string; content: string }> = [];
    const removedContents = new Set<string>();
    let addCount = 0;
    let updateCount = 0;
    let removeCount = 0;

    for (const act of actions) {
      if (!VALID_CATEGORIES.has(act.category) || !act.content?.trim()) continue;
      const content = act.content.trim().slice(0, 100);

      switch (act.action) {
        case "keep":
        case "add":
        case "update":
          finalMemories.push({ category: act.category, content });
          if (act.action === "add") addCount++;
          if (act.action === "update") updateCount++;
          break;
        case "remove":
          removedContents.add(content);
          removeCount++;
          break;
      }
    }

    // 数量上限校验
    const byCategory = new Map<string, number>();
    const trimmed: typeof finalMemories = [];
    for (const m of finalMemories) {
      const count = byCategory.get(m.category) ?? 0;
      if (count >= MAX_PER_CATEGORY) continue;
      if (trimmed.length >= MAX_TOTAL) break;
      byCategory.set(m.category, count + 1);
      trimmed.push(m);
    }

    // 全量替换：先删除该用户所有画像，再批量插入
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    deps.store.replaceUserMemories(
      userId,
      trimmed.map((m) => ({
        userId,
        category: m.category,
        content: m.content,
        sourceSession: sessionId,
        createdAt: now,
        updatedAt: now,
      })),
    );

    log.info(
      { userId, total: trimmed.length, added: addCount, updated: updateCount, removed: removeCount, before: existingMemories.length },
      "用户画像更新: %d 条 (新增 %d, 更新 %d, 淘汰 %d)",
      trimmed.length,
      addCount,
      updateCount,
      removeCount,
    );
  } catch (err) {
    log.error({ err, userId }, "用户画像抽取失败");
  }
}
