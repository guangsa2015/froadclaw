/**
 * 工具执行上下文 — 每次 Agent Loop 调用工具时传入，替代全局变量注入
 *
 * 解决全局 setXxxContext() 在并发场景下的竞态问题，
 * 所有工具通过 execute(params, ctx) 的第二个参数获取调用上下文。
 */

/** 工具执行时的上下文信息 */
export interface ToolCallContext {
  /** 发送者 ID（飞书 open_id） */
  senderId: string;
  /** 会话 chatId */
  chatId: string;
  /** 渠道类型（feishu / ...） */
  channelType: string;
  /** 当前 toolCallId（LLM 分配） */
  toolCallId: string;
}
