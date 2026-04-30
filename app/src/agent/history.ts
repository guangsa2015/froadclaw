import type { ChatMessage } from "../llm/types.js";
import { estimateTokens } from "../shared/token-count.js";

/**
 * 按完整对话轮次截断历史消息
 * 保证 tool-call 链 (user→assistant(toolCall)→tool→assistant) 不会被打断
 */
export function truncateHistory(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  const turns = splitIntoTurns(messages);

  let totalTokens = 0;
  let keepFromIndex = turns.length;

  for (let i = turns.length - 1; i >= 0; i--) {
    const turnTokens = turns[i]!.reduce(
      (sum, msg) => sum + estimateTokens(msg.content ?? "") + estimateTokens(JSON.stringify(msg.toolCalls ?? [])),
      0,
    );

    if (totalTokens + turnTokens > maxTokens) break;
    totalTokens += turnTokens;
    keepFromIndex = i;
  }

  // 防御：截断后清理开头的孤立 tool 消息
  return stripOrphanedToolMessages(turns.slice(keepFromIndex).flat());
}

/** 按 user 消息分组为完整轮次 */
function splitIntoTurns(messages: ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = [];
  let current: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(msg);
  }

  if (current.length > 0) turns.push(current);
  return turns;
}

/**
 * 清理所有孤立 tool 消息（没有前置 assistant(tool_calls) 匹配的 tool result）
 * 防止截断/压缩后出现无配对 tool 消息导致 LLM API 400 错误
 */
export function stripOrphanedToolMessages(messages: ChatMessage[]): ChatMessage[] {
  // 收集所有 assistant 消息中声明的 tool_call_id
  const validToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.toolCalls) {
      for (const tc of msg.toolCalls) validToolCallIds.add(tc.id);
    }
  }
  // 过滤：保留非 tool 消息，以及有配对的 tool 消息
  return messages.filter(
    (msg) => msg.role !== "tool" || (msg.toolCallId && validToolCallIds.has(msg.toolCallId)),
  );
}
