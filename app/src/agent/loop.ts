import type { InboundMessage } from "../channel/types.js";
import type { Channel } from "../channel/types.js";
import type { SessionManager } from "../session/manager.js";
import type { SessionStore } from "../session/store/interface.js";
import type { ToolExecutor } from "../tool/executor.js";
import type { ToolRegistry } from "../tool/registry.js";
import type { ModelRouter } from "../llm/model-router.js";
import type { ProviderRegistry } from "../llm/registry.js";
import type { SessionConfig } from "../config/types.js";

import { getBasePrompt } from "./prompt.js";
import { truncateHistory } from "./history.js";
import { buildMemoryMessages } from "./memory/builder.js";
import { compressSession } from "./memory/compressor.js";
import { extractUserMemory } from "./memory/extractor.js";
import { estimateTokens } from "../shared/token-count.js";
import { toUserErrorMessage } from "../shared/errors.js";
import { classifyScene } from "./scene-classifier.js";
import type { Scene } from "./scene-classifier.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("agent-loop");

const MAX_ITERATIONS = 10;

export interface AgentDeps {
  providerRegistry: ProviderRegistry;
  modelRouter: ModelRouter;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  sessionManager: SessionManager;
  sessionStore: SessionStore;
  sessionConfig: SessionConfig;
  channel: Channel;
}

/**
 * Agent 主循环 — 接收消息 → 三级记忆组装 → LLM ↔ Tool 迭代 → 回复 → 异步摘要
 */
export async function runAgentLoop(msg: InboundMessage, deps: AgentDeps): Promise<void> {
  const sessionKey = msg.isGroup ? `${msg.channelType}:${msg.chatId}` : `${msg.channelType}:${msg.chatId}:${msg.senderId}`;

  try {
    const session = deps.sessionManager.getOrCreate(sessionKey, msg.channelType, msg.chatId, msg.isGroup);

    // 新轮次
    session.currentTurn += 1;

    log.info(
      { sessionId: sessionKey, turn: session.currentTurn, historyLen: session.messages.length, sender: msg.senderId },
      "开始处理: %s",
      msg.content.slice(0, 200),
    );

    // 追加用户消息
    deps.sessionManager.appendMessage(session, { role: "user", content: msg.content });

    // 场景分类
    const scene: Scene = classifyScene(msg.content, session.messages);

    // 路由模型（按场景选择）
    const route = deps.modelRouter.resolve(msg.content, scene);
    const provider = deps.providerRegistry.getOrThrow(route.providerId);
    log.info({ provider: route.providerId, model: route.modelId, scene }, "模型路由 [%s]", scene);

    // ── 三级记忆组装（每轮重建，以包含最新的工具调用结果） ──
    const memoryConfig = deps.sessionConfig.memory;
    const userMemories = deps.sessionStore.getUserMemories(msg.senderId);
    const tokenBudget = deps.sessionConfig.maxHistoryTokens;
    const basePrompt = getBasePrompt();
    const toolHints = deps.toolRegistry.getSystemHints();
    let reachedMaxIterations = false;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      // 每轮重新截断 + 组装，确保 LLM 能看到上一轮工具调用的结果
      const recentMessages = truncateHistory(session.messages, tokenBudget);
      const { systemPrompt, messages: memoryMessages } = buildMemoryMessages({
        basePrompt,
        userMemories,
        sessionSummary: session.summary,
        recentMessages,
        scene,
        toolHints,
      });
      const allMessages = [{ role: "system" as const, content: systemPrompt }, ...memoryMessages];

      log.info(
        { iteration: i + 1, totalMessages: session.messages.length, sentMessages: allMessages.length, hasSummary: !!session.summary, profileCount: userMemories.length },
        "LLM 调用 (第 %d 轮), 发送 %d 条消息",
        i + 1,
        allMessages.length,
      );
      // log.info("━━ System Prompt ━━\n%s", systemPrompt);
      // log.info("━━ 发送给LLM的完整消息 ━━\n%s", JSON.stringify(allMessages, null, 2));

      const resp = await provider.chatCompletion({
        model: route.modelId,
        messages: allMessages,
        tools: deps.toolRegistry.getDefinitions().length > 0 ? deps.toolRegistry.getDefinitions() : undefined,
      });

      log.info(
        {
          finishReason: resp.finishReason,
          toolCallCount: resp.toolCalls.length,
          promptTokens: resp.usage.promptTokens,
          completionTokens: resp.usage.completionTokens,
        },
        "LLM 响应: %s",
        resp.content ? resp.content.slice(0, 300) : "(无文本, 仅工具调用)",
      );

      // 记录用量
      deps.sessionStore.logUsage({
        sessionId: session.id,
        providerId: route.providerId,
        modelId: route.modelId,
        promptTokens: resp.usage.promptTokens,
        completionTokens: resp.usage.completionTokens,
        totalTokens: resp.usage.promptTokens + resp.usage.completionTokens,
        hasTools: deps.toolRegistry.getDefinitions().length > 0 ? 1 : 0,
        loopIteration: i,
        finishReason: resp.finishReason,
      });

      // 追加 assistant 回复
      deps.sessionManager.appendMessage(session, {
        role: "assistant",
        content: resp.content || undefined,
        toolCalls: resp.toolCalls.length > 0 ? resp.toolCalls : undefined,
      });

      // 无工具调用 → 发送最终回复并退出
      if (resp.toolCalls.length === 0) {
        if (resp.content) {
          log.info({ chatId: msg.chatId, replyLen: resp.content.length }, "发送最终回复");
          await deps.channel.send({ chatId: msg.chatId, replyToMsgId: msg.messageId, content: resp.content });
        }
        break;
      }

      // 执行工具调用
      const toolResults: Array<{ directReply?: string; isError: boolean }> = [];
      for (const tc of resp.toolCalls) {
        log.info({ tool: tc.name, callId: tc.id }, "执行工具: %s(%s)", tc.name, tc.arguments.slice(0, 200));

        // 耗时工具先发加载提示（如"正在获取资讯…"）
        const toolDef = deps.toolRegistry.get(tc.name);
        if (toolDef?.loadingHint) {
          await deps.channel.send({ chatId: msg.chatId, content: toolDef.loadingHint });
        }

        const toolCtx = { senderId: msg.senderId, chatId: msg.chatId, channelType: msg.channelType, toolCallId: tc.id };
        const result = await deps.toolExecutor.execute(tc.name, tc.arguments, toolCtx);
        toolResults.push({ directReply: result.directReply, isError: result.isError });

        log.info(
          { tool: tc.name, isError: result.isError, durationMs: result.durationMs, rawLength: result.rawLength },
          "工具结果: %s",
          result.content.slice(0, 200),
        );

        const msgId = deps.sessionManager.appendMessage(session, {
          role: "tool",
          toolCallId: tc.id,
          content: result.content,
        });

        deps.sessionStore.logToolExecution({
          sessionId: session.id,
          messageId: msgId,
          toolCallId: tc.id,
          toolName: tc.name,
          inputParams: tc.arguments,
          outputContent: result.content,
          rawLength: result.rawLength,
          isError: result.isError ? 1 : 0,
          errorMessage: result.isError ? result.content : null,
          durationMs: result.durationMs,
        });
      }

      // 工具全部成功且均有 directReply → 跳过 LLM 确认轮，直接回复用户
      const directReplies = toolResults.filter(r => !r.isError && r.directReply).map(r => r.directReply!);
      if (directReplies.length === toolResults.length && directReplies.length > 0) {
        const directMsg = directReplies.join("\n");
        deps.sessionManager.appendMessage(session, { role: "assistant", content: directMsg });
        log.info({ chatId: msg.chatId, replyLen: directMsg.length }, "工具直接回复，跳过 LLM 确认");
        await deps.channel.send({ chatId: msg.chatId, replyToMsgId: msg.messageId, content: directMsg });
        break;
      }

      // token 预算检查
      const usedTokens = session.messages.reduce(
        (sum, m) => sum + estimateTokens(m.content ?? "") + estimateTokens(JSON.stringify(m.toolCalls ?? [])),
        0,
      );
      if (usedTokens > tokenBudget * 0.9) {
        log.warn({ usedTokens, budget: tokenBudget }, "上下文接近 token 上限，终止循环");
        await deps.channel.send({ chatId: msg.chatId, content: "⚠️ 上下文接近上限，已结束工具调用。如需继续请发新消息。" });
        break;
      }

      // 标记是否到达最后一轮
      if (i === MAX_ITERATIONS - 1) {
        reachedMaxIterations = true;
      }
    }

    // 循环耗尽 MAX_ITERATIONS 仍未产出文本回复时，发送兜底消息
    if (reachedMaxIterations) {
      log.warn({ maxIterations: MAX_ITERATIONS }, "工具调用循环达到上限，发送兜底回复");
      await deps.channel.send({ chatId: msg.chatId, content: "⚠️ 处理轮次已达上限，暂时无法继续。请简化指令后重试。" });
    }

    log.info({ sessionId: sessionKey, totalMessages: session.messages.length }, "轮次结束，持久化会话");

    // 持久化 session
    deps.sessionManager.save(session);

    // ── 异步摘要压缩（不阻塞用户） ──
    const unsummarizedCount = deps.sessionStore.countUnsummarized(sessionKey);
    log.debug({ sessionId: sessionKey, unsummarizedCount, threshold: memoryConfig.compressThreshold }, "摘要压缩判断");
    if (unsummarizedCount >= memoryConfig.compressThreshold) {
      log.info({ sessionId: sessionKey, unsummarizedCount, threshold: memoryConfig.compressThreshold }, "未摘要消息达到阈值，触发异步压缩");
      void (async () => {
        try {
          const summaryProvider = deps.providerRegistry.getOrThrow(route.providerId);
          const newSummary = await compressSession(sessionKey, session.summary, session.messages, {
            provider: summaryProvider,
            model: memoryConfig.summaryModel,
            store: deps.sessionStore,
            config: memoryConfig,
          });

          if (newSummary && newSummary !== session.summary) {
            const oldSummary = session.summary;
            session.summary = newSummary;
            // 压缩后裁剪内存中的已摘要消息，对齐到 user 消息边界以保持 tool-call 链完整
            const keepCount = memoryConfig.recentKeep;
            if (session.messages.length > keepCount) {
              const totalLen = session.messages.length;
              let cutIndex = totalLen - keepCount;
              // 向后查找最近的 user 消息作为安全切割点
              while (cutIndex < totalLen && session.messages[cutIndex]!.role !== "user") {
                cutIndex++;
              }
              const before = totalLen;
              session.messages = session.messages.slice(cutIndex);
              log.info({ keepCount, before, after: session.messages.length }, "内存消息裁剪");
            }
            deps.sessionManager.save(session);

            // 异步抽取用户画像
            void extractUserMemory(msg.senderId, sessionKey, newSummary, {
              provider: summaryProvider,
              model: memoryConfig.summaryModel,
              store: deps.sessionStore,
              cooldownMinutes: memoryConfig.extractCooldownMinutes ?? 0,
              previousSummary: oldSummary,
              similarityThreshold: memoryConfig.extractSimilarityThreshold ?? 0,
            });
          }
        } catch (err) {
          log.error({ err, sessionId: sessionKey }, "异步摘要/画像抽取失败");
        }
      })();
    }
  } catch (err) {
    log.error({ err, messageId: msg.messageId }, "Agent Loop 异常");
    const errorMsg = toUserErrorMessage(err);
    await deps.channel.send({ chatId: msg.chatId, content: errorMsg }).catch(() => {});
  }
}
