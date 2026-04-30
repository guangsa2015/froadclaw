/**
 * LLM 层类型定义 — OpenAI 兼容协议
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /**
   * 是否启用深度思考（qwen3.5 系列默认开启）
   * 对结构化输出任务（如 JSON 筛选）建议关闭以减少 token 和延迟
   * 设为 false 时通过 extra_body 传递 enable_thinking: false
   */
  enableThinking?: boolean;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number };
  finishReason: string;
}

/** LLM Provider 接口 */
export interface Provider {
  id: string;
  chatCompletion(req: ChatRequest): Promise<ChatResponse>;
}
