import type { InboundMessage } from "../channel/types.js";
import type { AgentDeps } from "../agent/loop.js";
import { runAgentLoop } from "../agent/loop.js";
import { KeyedQueue } from "../shared/session-queue.js";
import { createInboundDebouncer } from "../shared/inbound-debounce.js";
import { RateLimiter } from "../middleware/rate-limit.js";
import { RateLimitError } from "../shared/errors.js";
import type { RateLimitConfig } from "../config/types.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("router");

const sessionQueue = new KeyedQueue();

/** 消息过期阈值：超过此时间的补推消息直接丢弃 */
const STALE_MESSAGE_MS = 10 * 60_000;

export interface RouterDeps extends AgentDeps {
  rateLimitConfig: RateLimitConfig;
}

export function createRouter(deps: RouterDeps) {
  const rateLimiter = new RateLimiter(deps.rateLimitConfig.maxPerMinutePerUser, deps.rateLimitConfig.maxConcurrentGlobal);

  const debouncer = createInboundDebouncer<InboundMessage>({
    debounceMs: 300,
    buildKey: (msg) => `${msg.channelType}:${msg.chatId}:${msg.senderId}`,
    onFlush: async (messages) => {
      // 合并多条消息
      const merged: InboundMessage = {
        ...messages[messages.length - 1]!,
        content: messages.map((m) => m.content).join("\n"),
      };

      if (messages.length > 1) {
        log.info({ count: messages.length, senderId: merged.senderId }, "防抖合并 %d 条消息", messages.length);
      }

      const sessionKey = merged.isGroup
        ? `${merged.channelType}:${merged.chatId}`
        : `${merged.channelType}:${merged.chatId}:${merged.senderId}`;

      // 限流检查
      const waitSec = rateLimiter.check(merged.senderId);
      if (waitSec > 0) {
        log.warn({ senderId: merged.senderId, waitSec }, "触发限流，需等待 %d 秒", waitSec);
        const err = new RateLimitError(waitSec);
        await deps.channel.send({ chatId: merged.chatId, content: err.toUserMessage() }).catch(() => {});
        return;
      }

      // 串行队列
      await sessionQueue.enqueue(sessionKey, async () => {
        rateLimiter.acquire();
        try {
          await runAgentLoop(merged, deps);
        } finally {
          rateLimiter.release();
        }
      });
    },
  });

  return {
    /** 渠道消息回调入口 */
    onInboundMessage(msg: InboundMessage): void {
      log.info(
        { messageId: msg.messageId, senderId: msg.senderId, chatId: msg.chatId, isGroup: msg.isGroup },
        "收到消息: %s",
        msg.content.slice(0, 200),
      );

      // 丢弃过期的补推消息（服务器重启后飞书可能补投离线期间的旧消息）
      if (msg.messageCreatedAt) {
        const ageMs = Date.now() - msg.messageCreatedAt.getTime();
        if (ageMs > STALE_MESSAGE_MS) {
          log.warn(
            { messageId: msg.messageId, ageMs, ageMin: Math.round(ageMs / 60_000), createdAt: msg.messageCreatedAt.toISOString(), content: msg.content.slice(0, 100) },
            "丢弃过期补推消息 (%d分钟前)",
            Math.round(ageMs / 60_000),
          );
          return;
        }
      }

      debouncer.push(msg);
    },

    /** 优雅关闭 */
    async shutdown(): Promise<void> {
      await debouncer.flushAll();
    },
  };
}
