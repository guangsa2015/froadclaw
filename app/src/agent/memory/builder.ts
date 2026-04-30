/**
 * 三级记忆组装器 — 将 Tier1/2/3 合并为发送给 LLM 的最终消息数组
 *
 * 结构:
 *   [system_prompt + user_profile]   ← Tier 3 长期记忆
 *   [session_summary]                ← Tier 2 中期记忆
 *   [...recent_messages]             ← Tier 1 短期记忆
 */

import type { ChatMessage } from "../../llm/types.js";
import type { UserMemoryRow } from "../../session/store/interface.js";
import type { Scene } from "../scene-classifier.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("memory-builder");

export interface BuildResult {
  /** 完整的 system prompt（含用户画像） */
  systemPrompt: string;
  /** 组装后的消息列表（不含 system） */
  messages: ChatMessage[];
}

/**
 * 组装三级记忆消息
 *
 * 场景差异：
 *   work — 全量: system + 画像 + 摘要 + 原始消息
 *   life — 轻量: system + 摘要 + 最近消息（不注入画像详情，省 token）
 */
export function buildMemoryMessages(opts: {
  basePrompt: string;
  userMemories: UserMemoryRow[];
  sessionSummary: string | null;
  recentMessages: ChatMessage[];
  scene?: Scene;
  /** 工具自带的 systemHint 聚合文本（由 ToolRegistry.getSystemHints() 生成） */
  toolHints?: string;
}): BuildResult {
  const scene = opts.scene ?? "work";

  // Tier 3: 用户画像注入 system prompt（仅 work 场景）
  let systemPrompt = opts.basePrompt;
  if (scene === "work") {
    const profileBlock = formatUserProfile(opts.userMemories);
    if (profileBlock) {
      systemPrompt += `\n\n## 用户画像（长期记忆）\n${profileBlock}`;
    }
  }

  // 工具使用指南（动态聚合，与 prompt.ts 解耦）
  if (opts.toolHints) {
    systemPrompt += `\n\n${opts.toolHints}`;
  }

  // 组装消息
  const messages: ChatMessage[] = [];

  // Tier 2: 会话摘要
  if (opts.sessionSummary) {
    messages.push({
      role: "system",
      content: `[会话历史摘要]\n${opts.sessionSummary}`,
    });
  }

  // Tier 1: 最近原始消息
  messages.push(...opts.recentMessages);

  log.debug(
    { scene, profileItems: opts.userMemories.length, hasSummary: !!opts.sessionSummary, recentCount: opts.recentMessages.length },
    "三级记忆组装[%s]: 画像=%d, 摘要=%s, 近期=%d",
    scene,
    opts.userMemories.length,
    opts.sessionSummary ? "有" : "无",
    opts.recentMessages.length,
  );

  return { systemPrompt, messages };
}

/** 格式化用户画像为注入 prompt 的文本 */
function formatUserProfile(memories: UserMemoryRow[]): string {
  if (memories.length === 0) return "";

  const grouped: Record<string, string[]> = {};
  for (const m of memories) {
    (grouped[m.category] ??= []).push(m.content);
  }

  const labels: Record<string, string> = {
    preference: "偏好",
    viewpoint: "核心观点",
    style: "交互风格",
  };

  const lines: string[] = [];
  for (const [cat, items] of Object.entries(grouped)) {
    const label = labels[cat] ?? cat;
    lines.push(`- ${label}: ${items.join("；")}`);
  }

  return lines.join("\n");
}
