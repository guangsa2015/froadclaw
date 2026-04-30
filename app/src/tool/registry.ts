import type { Tool } from "./types.js";
import type { ToolDefinition } from "../llm/types.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("tool-registry");

/**
 * 工具注册表 — name → Tool 映射
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    log.info({ name: tool.name }, "注册工具");
    this.tools.set(tool.name, tool);
    // 如果工具实现了启动钩子，注册后自动调用
    if (tool.onStart) {
      try {
        tool.onStart();
        log.info({ name: tool.name }, "工具启动钩子已执行");
      } catch (err) {
        log.error({ name: tool.name, err }, "工具启动钩子执行失败");
      }
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 生成 LLM 所需的工具定义列表 */
  getDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameterSchema,
      },
    }));
  }

  listNames(): string[] {
    return [...this.tools.keys()];
  }

  /** 系统关闭时调用所有工具的停止钩子 */
  stopAll(): void {
    for (const tool of this.tools.values()) {
      if (tool.onStop) {
        try {
          tool.onStop();
          log.info({ name: tool.name }, "工具停止钩子已执行");
        } catch (err) {
          log.error({ name: tool.name, err }, "工具停止钩子执行失败");
        }
      }
    }
  }

  /**
   * 聚合所有已注册工具的 systemHint，拼接为 prompt 段落
   * agent loop 调用此方法动态注入 system prompt，
   * 新增工具只需设置 systemHint 字段，无需修改 prompt.ts。
   */
  getSystemHints(): string {
    const hints: string[] = [];
    for (const tool of this.tools.values()) {
      if (tool.systemHint) {
        hints.push(tool.systemHint);
      }
    }
    return hints.length > 0
      ? `## 工具使用策略\n${hints.join("\n")}`
      : "";
  }
}
