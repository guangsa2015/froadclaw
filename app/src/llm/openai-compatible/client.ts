import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import type { Provider, ChatRequest, ChatResponse, ToolCall } from "../types.js";
import { LlmError } from "../../shared/errors.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("openai-compatible");

/** 可重试的 HTTP 状态码（欠费/限流/服务端异常） */
const RETRYABLE_STATUS = new Set([429, 402, 403, 500, 503]);

/** 可重试的错误关键词 */
const RETRYABLE_PATTERN = /rate.?limit|quota|billing|insufficient|balance|overloaded|capacity|throttl/i;

/**
 * OpenAI 兼容 Provider — 覆盖 Qwen/Deepseek/OpenAI 等所有兼容接口
 * 支持多模型自动降级：调用失败时按顺序尝试备用模型
 */
export class OpenAICompatibleProvider implements Provider {
  private client: OpenAI;

  constructor(
    public readonly id: string,
    baseUrl: string,
    apiKey: string,
    private readonly models: string[] = [],
  ) {
    this.client = new OpenAI({ baseURL: baseUrl, apiKey });
  }

  async chatCompletion(req: ChatRequest): Promise<ChatResponse> {
    // 构建尝试列表：请求的模型优先，然后按 models 顺序追加其余
    const tryList = [req.model, ...this.models.filter((m) => m !== req.model)];
    // 去重（保序）
    const seen = new Set<string>();
    const uniqueList = tryList.filter((m) => {
      if (seen.has(m)) return false;
      seen.add(m);
      return true;
    });

    let lastError: unknown;

    for (let i = 0; i < uniqueList.length; i++) {
      const model = uniqueList[i]!;
      try {
        return await this.doCall({ ...req, model });
      } catch (err) {
        lastError = err;

        // 还有备用模型 && 错误可重试 → 降级
        if (i < uniqueList.length - 1 && this.isRetryable(err)) {
          const nextModel = uniqueList[i + 1]!;
          log.warn(
            { model, nextModel, err: err instanceof Error ? err.message : String(err) },
            "模型 %s 调用失败，自动切换到 %s",
            model,
            nextModel,
          );
          continue;
        }

        // 不可重试 或 已是最后一个模型 → 抛出
        if (err instanceof LlmError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, provider: this.id, model }, "LLM 调用失败 (无可用备选)");
        throw new LlmError(message, this.id);
      }
    }

    // 理论上不会到这里
    throw lastError instanceof LlmError ? lastError : new LlmError("所有模型均调用失败", this.id);
  }

  /** 判断错误是否可重试（欠费/限流/服务端异常） */
  private isRetryable(err: unknown): boolean {
    if (err instanceof OpenAI.APIError) {
      return RETRYABLE_STATUS.has(err.status);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return RETRYABLE_PATTERN.test(msg);
  }

  /** 实际 LLM 调用 */
  private async doCall(req: ChatRequest): Promise<ChatResponse> {
    log.debug(
      { provider: this.id, model: req.model, messageCount: req.messages.length, hasTools: !!req.tools },
      "LLM 请求: model=%s, %d 条消息, tools=%s",
      req.model,
      req.messages.length,
      req.tools ? req.tools.map((t) => t.function.name).join(",") : "无",
    );

    const startMs = Date.now();

    const response = await this.client.chat.completions.create({
      model: req.model,
      messages: req.messages.map((m) => this.toOpenAIMessage(m)),
      tools: req.tools?.map((t) => ({
        type: "function" as const,
        function: t.function,
      })),
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      // qwen3.5 系列：控制深度思考开关（DashScope Node.js SDK 需作为顶层参数传入）
      ...(req.enableThinking !== undefined ? { enable_thinking: req.enableThinking } : {}),
    } as ChatCompletionCreateParamsNonStreaming);

    const choice = response.choices[0];
    if (!choice) throw new LlmError("LLM 返回空响应", this.id);

    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));

    const durationMs = Date.now() - startMs;
    log.info(
      {
        provider: this.id,
        model: req.model,
        durationMs,
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        finishReason: choice.finish_reason,
        toolCallCount: toolCalls.length,
      },
      "LLM 响应: %dms, finish=%s",
      durationMs,
      choice.finish_reason,
    );

    return {
      content: choice.message.content ?? "",
      toolCalls,
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
      },
      finishReason: choice.finish_reason ?? "stop",
    };
  }

  private toOpenAIMessage(msg: ChatRequest["messages"][number]): OpenAI.ChatCompletionMessageParam {
    if (msg.role === "tool") {
      return { role: "tool", tool_call_id: msg.toolCallId ?? "", content: msg.content ?? "" };
    }
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      return {
        role: "assistant",
        content: msg.content ?? null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    return { role: msg.role as "system" | "user" | "assistant", content: msg.content ?? "" };
  }
}
