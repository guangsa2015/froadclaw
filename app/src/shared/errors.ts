/**
 * 统一错误类型
 */

/** 业务错误基类 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = "AppError";
  }

  /** 生成用户可见的异常概要 */
  toUserMessage(): string {
    return `❌ ${this.message}`;
  }
}

/** LLM 调用失败 */
export class LlmError extends AppError {
  constructor(message: string, public readonly provider?: string) {
    super(message, "LLM_ERROR");
    this.name = "LlmError";
  }

  toUserMessage(): string {
    return `❌ AI 响应异常: ${this.message}`;
  }
}

/** 工具执行失败 */
export class ToolError extends AppError {
  constructor(message: string, public readonly toolName?: string) {
    super(message, "TOOL_ERROR");
    this.name = "ToolError";
  }
}

/** 限流触发 */
export class RateLimitError extends AppError {
  constructor(public readonly retryAfterSec: number) {
    super(`请求太频繁，请等待 ${retryAfterSec} 秒`, "RATE_LIMIT", 429);
    this.name = "RateLimitError";
  }

  toUserMessage(): string {
    return `⏳ 请求太频繁，请等待 ${this.retryAfterSec} 秒后重试`;
  }
}

/** SSRF 防护拦截 */
export class SsrfError extends AppError {
  constructor(message: string) {
    super(message, "SSRF_BLOCKED", 403);
    this.name = "SsrfError";
  }
}

/** 将未知错误转为用户可见消息 */
export function toUserErrorMessage(err: unknown): string {
  if (err instanceof AppError) return err.toUserMessage();
  if (err instanceof Error) return `❌ 处理异常: ${err.message}`;
  return "❌ 未知异常，请重试";
}
