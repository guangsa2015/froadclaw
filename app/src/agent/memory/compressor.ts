/**
 * Tier 2: 会话摘要压缩器 — 异步调 LLM 对旧消息做语义去重 + 关键信息抽取
 */

import type { Provider, ChatMessage } from "../../llm/types.js";
import type { SessionStore } from "../../session/store/interface.js";
import type { MemoryConfig } from "../../config/types.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("memory-compressor");

/** 生成带字数限制的压缩 prompt */
function buildCompressPrompt(maxLen: number): string {
  return `你是对话摘要助手。请对以下对话进行压缩摘要：

规则：
1. 去除重复话题（如多次问候只保留一次"有过问候"）
2. 合并语义相近的问答（同一话题多次追问合并为一条要点）
3. 抽取关键信息点（具体数据、结论、用户明确的需求/意图）
4. 保留话题转换脉络
5. 输出纯文本，每个要点一行，严格不超过 ${maxLen} 字
6. 不要添加你的评论，只做信息压缩
7. 当内容过多需要取舍时，优先级：用户明确偏好 > 最近话题结论 > 历史话题概述 > 早期闲聊`;
}

export interface CompressorDeps {
  provider: Provider;
  model: string;
  store: SessionStore;
  config: MemoryConfig;
}

/** 封装 LLM 调用（压缩 + 二次压缩共用） */
async function callLlm(deps: CompressorDeps, systemPrompt: string, userPrompt: string): Promise<string | null> {
  const resp = await deps.provider.chatCompletion({
    model: deps.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
  });
  const text = resp.content.trim();
  return text || null;
}

/**
 * 异步压缩：不阻塞用户请求，在后台完成摘要
 * 返回 Promise，调用方用 void 忽略即可
 */
export async function compressSession(
  sessionId: string,
  existingSummary: string | null,
  messages: ChatMessage[],
  deps: CompressorDeps,
): Promise<string | null> {
  if (messages.length < deps.config.compressThreshold) return existingSummary;

  // 保留最近 N 条不压缩（Tier 1 短期记忆）
  const keepRecent = deps.config.recentKeep;
  const toCompress = messages.slice(0, -keepRecent);
  if (toCompress.length === 0) return existingSummary;

  log.info(
    { sessionId, toCompress: toCompress.length, keep: keepRecent, existingSummaryLen: existingSummary?.length ?? 0 },
    "开始异步摘要压缩，压缩 %d 条消息",
    toCompress.length,
  );

  // 构建摘要请求
  const messagesText = toCompress
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `[${m.role}]: ${(m.content ?? "").slice(0, 500)}`)
    .join("\n");

  const maxLen = deps.config.maxSummaryLength;
  const userPrompt = existingSummary
    ? `已有摘要（${existingSummary.length}字）：\n${existingSummary}\n\n新增对话：\n${messagesText}\n\n请将已有摘要与新增对话合并，输出更新后的完整摘要。注意：总字数严格不超过 ${maxLen} 字，超出时淘汰最早的、信息价值最低的内容。`
    : `对话内容：\n${messagesText}\n\n请输出压缩摘要，不超过 ${maxLen} 字。`;

  try {
    const compressPrompt = buildCompressPrompt(maxLen);
    let summary = await callLlm(deps, compressPrompt, userPrompt);
    if (!summary) {
      log.warn({ sessionId }, "摘要返回空内容");
      return existingSummary;
    }

    // 超限保护：LLM 未遵守字数限制时，发起二次压缩
    if (summary.length > maxLen * 1.2) {
      log.warn(
        { sessionId, summaryLen: summary.length, maxLen, overPercent: Math.round((summary.length / maxLen - 1) * 100) },
        "摘要超出上限 %d%%，触发二次压缩",
        Math.round((summary.length / maxLen - 1) * 100),
      );
      const recompressPrompt = `以下摘要过长（${summary.length}字），请精简到 ${maxLen} 字以内。\n优先保留：用户偏好 > 最近话题结论 > 历史概述。淘汰早期低价值内容。\n\n${summary}`;
      const shorter = await callLlm(deps, compressPrompt, recompressPrompt);
      if (shorter && shorter.length < summary.length) {
        summary = shorter;
      }
    }

    // 硬截断兜底（极端情况 LLM 仍不遵守）
    if (summary.length > maxLen * 1.5) {
      log.warn({ sessionId, summaryLen: summary.length }, "二次压缩后仍超限，硬截断");
      summary = summary.slice(0, maxLen) + "\n[摘要已截断]";
    }

    // 标记已压缩的消息（使用 DB 实际 seq，非数组索引）
    const unsummarized = deps.store.getUnsummarizedMessages(sessionId);
    if (unsummarized.length > 0) {
      // 取应压缩部分的最后一条 seq
      const compressEnd = unsummarized.length - deps.config.recentKeep;
      if (compressEnd > 0) {
        let maxSeq = unsummarized[compressEnd - 1]!.seq;
        // 向后扩展：如果 maxSeq 处是 assistant(tool_calls)，把后面的 tool 消息也标记
        for (let i = compressEnd; i < unsummarized.length; i++) {
          if (unsummarized[i]!.role === "tool") {
            maxSeq = unsummarized[i]!.seq;
          } else {
            break;
          }
        }
        deps.store.markSummarized(sessionId, maxSeq);
      }
    }

    log.info(
      { sessionId, summaryLen: summary.length, compressedCount: toCompress.length },
      "摘要压缩完成",
    );

    return summary;
  } catch (err) {
    log.error({ err, sessionId }, "摘要压缩失败，保留原有摘要");
    return existingSummary;
  }
}
