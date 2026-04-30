import type { ChatMessage } from "../llm/types.js";
import type { Session } from "./types.js";
import type { SessionStore } from "./store/interface.js";
import { estimateTokens } from "../shared/token-count.js";
import type { SessionConfig } from "../config/types.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("session-manager");

/**
 * 会话管理 — 获取/创建/追加消息/持久化
 */
export class SessionManager {
  constructor(
    private store: SessionStore,
    private config: SessionConfig,
    private defaultModel: string,
  ) {}

  /** 获取或创建 session，加载历史消息 */
  getOrCreate(sessionKey: string, channelType: string, chatId: string, isGroup: boolean): Session {
    const existing = this.store.getSession(sessionKey);

    if (existing) {
      // 只加载未摘要的消息（已摘要的由 session.summary 代替）
      const rows = existing.summary
        ? this.store.getUnsummarizedMessages(sessionKey)
        : this.store.getMessages(sessionKey);
      const messages: ChatMessage[] = rows.map((r) => ({
        role: r.role as ChatMessage["role"],
        content: r.content ?? undefined,
        toolCalls: r.toolCalls ? JSON.parse(r.toolCalls) : undefined,
        toolCallId: r.toolCallId ?? undefined,
      }));
      const maxTurn = rows.reduce((max, r) => Math.max(max, r.turn), 0);

      return {
        id: existing.id,
        channelType: existing.channelType,
        chatId: existing.chatId,
        isGroup: existing.isGroup === 1,
        currentModel: existing.currentModel,
        estimatedTokens: existing.estimatedTokens,
        summary: existing.summary,
        messages,
        currentTurn: maxTurn,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
        expiresAt: existing.expiresAt,
      };
    }

    // 创建新 session
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const expiresAt = new Date(Date.now() + this.config.ttlHours * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");

    const session: Session = {
      id: sessionKey,
      channelType,
      chatId,
      isGroup,
      currentModel: this.defaultModel,
      estimatedTokens: 0,
      summary: null,
      messages: [],
      currentTurn: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt,
    };

    this.store.upsertSession({
      id: session.id,
      channelType: session.channelType,
      chatId: session.chatId,
      isGroup: isGroup ? 1 : 0,
      currentModel: session.currentModel,
      estimatedTokens: 0,
      summary: null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
    });

    log.info({ sessionId: sessionKey }, "创建新会话");
    return session;
  }

  /** 追加消息到 session 并持久化 */
  appendMessage(session: Session, msg: ChatMessage): number {
    const seq = this.store.getMaxSeq(session.id) + 1;
    const tokenEst = estimateTokens(msg.content ?? "") + estimateTokens(JSON.stringify(msg.toolCalls ?? []));

    session.messages.push(msg);
    session.estimatedTokens += tokenEst;

    return this.store.appendMessage({
      sessionId: session.id,
      seq,
      role: msg.role,
      content: msg.content ?? null,
      toolCalls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
      toolCallId: msg.toolCallId ?? null,
      tokenEstimate: tokenEst,
      turn: session.currentTurn,
      summarized: 0,
    });
  }

  /** 保存 session 元信息 */
  save(session: Session): void {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    // 续期
    const expiresAt = new Date(Date.now() + this.config.ttlHours * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");

    this.store.upsertSession({
      id: session.id,
      channelType: session.channelType,
      chatId: session.chatId,
      isGroup: session.isGroup ? 1 : 0,
      currentModel: session.currentModel,
      estimatedTokens: session.estimatedTokens,
      summary: session.summary,
      createdAt: session.createdAt,
      updatedAt: now,
      expiresAt,
    });
  }
}
