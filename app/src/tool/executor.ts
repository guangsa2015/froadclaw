import type { ToolResult } from "./types.js";
import type { ToolCallContext } from "./tool-context.js";
import { ToolRegistry } from "./registry.js";
import { truncateToolResult } from "./result-truncation.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("tool-executor");

/** 工具结果最大字符数：上下文窗口的 30% */
const MAX_RESULT_CONTEXT_SHARE = 0.3;
const HARD_MAX_CHARS = 400_000;

export class ToolExecutor {
  constructor(
    private registry: ToolRegistry,
    private contextWindow: number,
    private timeoutMs: number = 30_000,
  ) {}

  async execute(name: string, argsJson: string, ctx: ToolCallContext): Promise<ToolResult & { rawLength: number; durationMs: number }> {
    const tool = this.registry.get(name);
    if (!tool) {
      return { content: `未知工具: ${name}`, isError: true, rawLength: 0, durationMs: 0 };
    }

    const maxChars = Math.min(this.contextWindow * MAX_RESULT_CONTEXT_SHARE * 4, HARD_MAX_CHARS);
    const start = Date.now();

    try {
      const params = JSON.parse(argsJson) as Record<string, unknown>;
      const timeout = tool.timeoutMs ?? this.timeoutMs;
      const result = await this.executeWithTimeout(tool.name, () => tool.execute(params, ctx), timeout);
      const rawLength = result.content.length;

      return {
        content: truncateToolResult(result.content, maxChars),
        isError: result.isError,
        directReply: result.directReply,
        rawLength,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, tool: name }, "工具执行失败");
      return { content: `工具执行失败: ${message}`, isError: true, rawLength: 0, durationMs: Date.now() - start };
    }
  }

  private executeWithTimeout<T>(name: string, fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`工具 ${name} 执行超时`)), timeoutMs);
      fn()
        .then(resolve)
        .catch(reject)
        .finally(() => clearTimeout(timer));
    });
  }
}
