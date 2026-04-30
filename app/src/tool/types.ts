/**
 * 工具层类型定义
 */

import type { ToolCallContext } from "./tool-context.js";

export interface Tool {
  name: string;
  description: string;
  parameterSchema: Record<string, unknown>;
  /**
   * 系统提示词片段 — 告诉 LLM 何时/如何使用此工具
   * 注册时由 ToolRegistry 自动聚合，注入 system prompt。
   * 工具自带说明，无需修改 prompt.ts。
   */
  systemHint?: string;
  /**
   * 加载提示 — 工具执行前先发给用户的即时反馈文本
   * 适用于耗时较长的工具（如数据拉取 + LLM 筛选），
   * Agent Loop 检测到此字段时会先通过 channel 发送提示，再执行工具。
   */
  loadingHint?: string;
  /**
   * 工具级别超时（ms） — 覆盖 ToolExecutor 的全局默认超时
   * 适用于耗时较长的工具（如多源拉取 + LLM 筛选）
   */
  timeoutMs?: number;
  execute(params: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult>;
  /**
   * 启动钩子 — 注册后由 ToolRegistry 自动调用
   * 适用于需要后台定时任务的工具（如资讯定时刷新）
   */
  onStart?(): void;
  /**
   * 停止钩子 — 系统关闭时由 ToolRegistry.stopAll() 调用
   * 用于清理定时器、释放资源
   */
  onStop?(): void;
}

export interface ToolResult {
  content: string;
  isError: boolean;
  /** 若设置，Agent Loop 跳过下一轮 LLM 确认，直接把此文本发给用户 */
  directReply?: string;
}
