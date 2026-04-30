import initSqlJs, { type Database, type SqlValue } from "sql.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  SessionStore, SessionRow, MessageRow, UsageLogRow, ToolExecutionRow, UserMemoryRow, NewsCacheRow, NewsRefreshConfigRow,
} from "./interface.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("sqlite-store");

/**
 * sql.js 是纯 WASM 实现，无需 C++ 编译环境
 * 数据库文件手动持久化（定期 + 关闭时写入磁盘）
 */
export class SqliteSessionStore implements SessionStore {
  private db!: Database;
  private dbPath: string;
  private saveTimer?: ReturnType<typeof setInterval>;

  private constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /** 获取底层 sql.js Database 实例（供 SchedulerStore 复用） */
  getDatabase(): Database {
    return this.db;
  }

  /** 异步工厂方法（sql.js 初始化是异步的） */
  static async create(dbPath: string): Promise<SqliteSessionStore> {
    const store = new SqliteSessionStore(dbPath);
    await store.init();
    return store;
  }

  private async init(): Promise<void> {
    const SQL = await initSqlJs();

    // 尝试加载已有数据库文件
    if (existsSync(this.dbPath)) {
      const buffer = readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      this.db = new SQL.Database();
    }

    this.db.run("PRAGMA foreign_keys = ON");
    this.initSchema();

    // 每 30 秒自动持久化
    this.saveTimer = setInterval(() => this.persist(), 30_000);

    log.info({ path: this.dbPath }, "SQLite (sql.js) 已初始化");
  }

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, chat_id TEXT NOT NULL,
        is_group INTEGER NOT NULL DEFAULT 0, current_model TEXT NOT NULL DEFAULT 'qwen/qwen-plus',
        estimated_tokens INTEGER NOT NULL DEFAULT 0, summary TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        expires_at TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS message (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT, tool_calls TEXT,
        tool_call_id TEXT, token_estimate INTEGER NOT NULL DEFAULT 0,
        turn INTEGER NOT NULL DEFAULT 0,
        summarized INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tool_execution (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        message_id INTEGER, tool_call_id TEXT NOT NULL, tool_name TEXT NOT NULL,
        input_params TEXT, output_content TEXT, raw_length INTEGER,
        is_error INTEGER NOT NULL DEFAULT 0, error_message TEXT, duration_ms INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0, has_tools INTEGER NOT NULL DEFAULT 0,
        loop_iteration INTEGER NOT NULL DEFAULT 0, finish_reason TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS message_dedup (
        message_id TEXT PRIMARY KEY, channel_type TEXT NOT NULL,
        received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        source_session TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_user_memory_user ON user_memory(user_id)");

    // ── 资讯缓存表 ──
    this.db.run(`
      CREATE TABLE IF NOT EXISTS news_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        published_at TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL,
        importance TEXT NOT NULL DEFAULT 'low',
        tags TEXT NOT NULL DEFAULT '[]',
        url TEXT,
        content_hash TEXT NOT NULL,
        llm_status TEXT NOT NULL DEFAULT 'pending',
        llm_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT '',
        UNIQUE(source, source_id)
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_news_published ON news_cache(published_at)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_news_llm_status ON news_cache(llm_status, published_at)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_news_content_hash ON news_cache(content_hash)");

    // ── 资讯刷新配置表（单行记录） ──
    this.db.run(`
      CREATE TABLE IF NOT EXISTS news_refresh_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 1,
        cron_expr TEXT NOT NULL DEFAULT '0 * * * *',
        last_refresh_at TEXT
      )
    `);
    // 确保有默认记录
    this.db.run(`INSERT OR IGNORE INTO news_refresh_config (id, enabled, cron_expr) VALUES (1, 1, '0 * * * *')`);

    // 兼容旧库：news_cache 补 updated_at 列
    try {
      this.db.run("ALTER TABLE news_cache ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
    } catch { /* 列已存在 */ }

    // 兼容老库：如果 message 表缺 summarized 列则补上
    try {
      this.db.run("ALTER TABLE message ADD COLUMN summarized INTEGER NOT NULL DEFAULT 0");
    } catch { /* 列已存在 */ }
  }

  /** 将内存数据库写入磁盘 */
  private persist(): void {
    try {
      const data = this.db.export();
      writeFileSync(this.dbPath, Buffer.from(data));
    } catch (err) {
      log.error({ err }, "数据库持久化失败");
    }
  }

  // ── 查询辅助 ──

  private queryOne<T>(sql: string, params: SqlValue[] = []): T | null {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) {
      const row = stmt.getAsObject() as T;
      stmt.free();
      return row;
    }
    stmt.free();
    return null;
  }

  private queryAll<T>(sql: string, params: SqlValue[] = []): T[] {
    const results: T[] = [];
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    while (stmt.step()) {
      results.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return results;
  }

  private execute(sql: string, params: SqlValue[] = []): void {
    this.db.run(sql, params);
  }

  private getLastInsertRowId(): number {
    const row = this.queryOne<{ id: number }>("SELECT last_insert_rowid() AS id");
    return row?.id ?? 0;
  }

  private getChanges(): number {
    const row = this.queryOne<{ c: number }>("SELECT changes() AS c");
    return row?.c ?? 0;
  }

  // ── Session CRUD ──

  getSession(id: string): SessionRow | null {
    return this.queryOne<SessionRow>(
      `SELECT id, channel_type AS channelType, chat_id AS chatId, is_group AS isGroup,
              current_model AS currentModel, estimated_tokens AS estimatedTokens, summary,
              created_at AS createdAt, updated_at AS updatedAt, expires_at AS expiresAt
       FROM session WHERE id = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
      [id],
    );
  }

  upsertSession(s: SessionRow): void {
    this.execute(
      `INSERT INTO session (id, channel_type, chat_id, is_group, current_model, estimated_tokens, summary, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET current_model=excluded.current_model, estimated_tokens=excluded.estimated_tokens,
         summary=excluded.summary, updated_at=excluded.updated_at, expires_at=excluded.expires_at`,
      [s.id, s.channelType, s.chatId, s.isGroup, s.currentModel, s.estimatedTokens, s.summary, s.createdAt, s.updatedAt, s.expiresAt],
    );
  }

  // ── Message ──

  getMessages(sessionId: string): MessageRow[] {
    return this.queryAll<MessageRow>(
      `SELECT id, session_id AS sessionId, seq, role, content, tool_calls AS toolCalls,
              tool_call_id AS toolCallId, token_estimate AS tokenEstimate, turn, summarized, created_at AS createdAt
       FROM message WHERE session_id = ? ORDER BY seq`,
      [sessionId],
    );
  }

  getUnsummarizedMessages(sessionId: string): MessageRow[] {
    return this.queryAll<MessageRow>(
      `SELECT id, session_id AS sessionId, seq, role, content, tool_calls AS toolCalls,
              tool_call_id AS toolCallId, token_estimate AS tokenEstimate, turn, summarized, created_at AS createdAt
       FROM message WHERE session_id = ? AND summarized = 0 ORDER BY seq`,
      [sessionId],
    );
  }

  countUnsummarized(sessionId: string): number {
    const row = this.queryOne<{ c: number }>("SELECT count(*) AS c FROM message WHERE session_id = ? AND summarized = 0", [sessionId]);
    return row?.c ?? 0;
  }

  getMaxSeq(sessionId: string): number {
    const row = this.queryOne<{ m: number }>("SELECT COALESCE(MAX(seq), -1) AS m FROM message WHERE session_id = ?", [sessionId]);
    return row?.m ?? -1;
  }

  markSummarized(sessionId: string, maxSeq: number): void {
    this.execute("UPDATE message SET summarized = 1 WHERE session_id = ? AND seq <= ? AND summarized = 0", [sessionId, maxSeq]);
  }

  appendMessage(msg: Omit<MessageRow, "id" | "createdAt">): number {
    this.execute(
      "INSERT INTO message (session_id, seq, role, content, tool_calls, tool_call_id, token_estimate, turn) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [msg.sessionId, msg.seq, msg.role, msg.content, msg.toolCalls, msg.toolCallId, msg.tokenEstimate, msg.turn],
    );
    return this.getLastInsertRowId();
  }

  deleteMessagesBefore(sessionId: string, turn: number): void {
    this.execute("DELETE FROM message WHERE session_id = ? AND turn < ?", [sessionId, turn]);
  }

  // ── Logging ──

  logUsage(u: UsageLogRow): void {
    this.execute(
      "INSERT INTO usage_log (session_id, provider_id, model_id, prompt_tokens, completion_tokens, total_tokens, has_tools, loop_iteration, finish_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [u.sessionId, u.providerId, u.modelId, u.promptTokens, u.completionTokens, u.totalTokens, u.hasTools, u.loopIteration, u.finishReason],
    );
  }

  logToolExecution(t: ToolExecutionRow): void {
    this.execute(
      "INSERT INTO tool_execution (session_id, message_id, tool_call_id, tool_name, input_params, output_content, raw_length, is_error, error_message, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [t.sessionId, t.messageId, t.toolCallId, t.toolName, t.inputParams, t.outputContent, t.rawLength, t.isError, t.errorMessage, t.durationMs],
    );
  }

  // ── Dedup ──

  checkAndMarkDedup(messageId: string, channelType: string): boolean {
    const existing = this.queryOne("SELECT 1 FROM message_dedup WHERE message_id = ?", [messageId]);
    if (existing) return true;
    this.execute("INSERT INTO message_dedup (message_id, channel_type) VALUES (?, ?)", [messageId, channelType]);
    return false;
  }

  // ── Cleanup ──

  cleanupExpired(): { sessions: number; dedups: number } {
    // sql.js 不直接返回 changes，用前后 count 差值
    const sBefore = (this.queryOne<{ c: number }>("SELECT count(*) AS c FROM session WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%SZ','now')"))?.c ?? 0;
    this.execute("DELETE FROM session WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%SZ','now')");

    const dBefore = (this.queryOne<{ c: number }>("SELECT count(*) AS c FROM message_dedup WHERE received_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-5 minutes')"))?.c ?? 0;
    this.execute("DELETE FROM message_dedup WHERE received_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-5 minutes')");

    if (sBefore > 0 || dBefore > 0) this.persist();
    return { sessions: sBefore, dedups: dBefore };
  }

  close(): void {
    this.persist();
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.db.close();
  }

  // ── User Memory ──

  getUserMemories(userId: string): UserMemoryRow[] {
    return this.queryAll<UserMemoryRow>(
      `SELECT id, user_id AS userId, category, content, source_session AS sourceSession,
              created_at AS createdAt, updated_at AS updatedAt
       FROM user_memory WHERE user_id = ? ORDER BY category, updated_at DESC`,
      [userId],
    );
  }

  getLastExtractTime(userId: string): string | null {
    const row = this.queryOne<{ t: string }>(
      "SELECT MAX(updated_at) AS t FROM user_memory WHERE user_id = ?",
      [userId],
    );
    return row?.t ?? null;
  }

  upsertUserMemory(mem: Omit<UserMemoryRow, "id">): void {
    // 相同 user + category + content 则更新时间，否则插入
    const existing = this.queryOne<{ id: number }>(
      "SELECT id FROM user_memory WHERE user_id = ? AND category = ? AND content = ?",
      [mem.userId, mem.category, mem.content],
    );
    if (existing) {
      this.execute("UPDATE user_memory SET updated_at = ?, source_session = ? WHERE id = ?", [mem.updatedAt, mem.sourceSession, existing.id]);
    } else {
      this.execute(
        "INSERT INTO user_memory (user_id, category, content, source_session, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [mem.userId, mem.category, mem.content, mem.sourceSession, mem.createdAt, mem.updatedAt],
      );
    }
  }

  deleteUserMemory(userId: string, category: string, content: string): void {
    this.execute("DELETE FROM user_memory WHERE user_id = ? AND category = ? AND content = ?", [userId, category, content]);
  }

  /** 全量替换某用户的画像：先清空再批量插入（用于语义去重后的整体更新） */
  replaceUserMemories(userId: string, memories: Array<Omit<UserMemoryRow, "id">>): void {
    this.execute("DELETE FROM user_memory WHERE user_id = ?", [userId]);
    for (const mem of memories) {
      this.execute(
        "INSERT INTO user_memory (user_id, category, content, source_session, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [mem.userId, mem.category, mem.content, mem.sourceSession, mem.createdAt, mem.updatedAt],
      );
    }
  }

  countUserMemories(userId: string, category: string): number {
    const row = this.queryOne<{ c: number }>("SELECT count(*) AS c FROM user_memory WHERE user_id = ? AND category = ?", [userId, category]);
    return row?.c ?? 0;
  }

  // ── News Cache ──

  insertNewsItems(items: Array<Omit<NewsCacheRow, "id">>): number {
    let inserted = 0;
    for (const item of items) {
      try {
        this.execute(
          `INSERT OR IGNORE INTO news_cache
           (source, source_id, published_at, title, summary, importance, tags, url, content_hash, llm_status, llm_reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [item.source, item.sourceId, item.publishedAt, item.title, item.summary,
            item.importance, item.tags, item.url, item.contentHash,
            item.llmStatus, item.llmReason, item.createdAt, item.updatedAt],
        );
        // changes() 返回本次 SQL 影响的行数，IGNORE 时为 0
        if (this.getChanges() > 0) inserted++;
      } catch { /* UNIQUE 冲突直接跳过 */ }
    }
    return inserted;
  }

  getPendingNews(withinHours: number, limit: number): NewsCacheRow[] {
    const cutoff = new Date(Date.now() - withinHours * 3600_000).toISOString();
    return this.queryAll<NewsCacheRow>(
      `SELECT id, source, source_id AS sourceId, published_at AS publishedAt,
              title, summary, importance, tags, url, content_hash AS contentHash,
              llm_status AS llmStatus, llm_reason AS llmReason, created_at AS createdAt, updated_at AS updatedAt
       FROM news_cache
       WHERE llm_status = 'pending' AND published_at > ?
       ORDER BY importance DESC, published_at DESC
       LIMIT ?`,
      [cutoff, limit],
    );
  }

  getKeptNews(withinHours: number, limit: number): NewsCacheRow[] {
    const cutoff = new Date(Date.now() - withinHours * 3600_000).toISOString();
    return this.queryAll<NewsCacheRow>(
      `SELECT id, source, source_id AS sourceId, published_at AS publishedAt,
              title, summary, importance, tags, url, content_hash AS contentHash,
              llm_status AS llmStatus, llm_reason AS llmReason, created_at AS createdAt, updated_at AS updatedAt
       FROM news_cache
       WHERE llm_status = 'kept' AND published_at > ?
       ORDER BY published_at DESC
       LIMIT ?`,
      [cutoff, limit],
    );
  }

  updateNewsLlmStatus(updates: Array<{ id: number; status: string; reason?: string }>): void {
    const now = new Date().toISOString();
    for (const u of updates) {
      this.execute(
        "UPDATE news_cache SET llm_status = ?, llm_reason = ?, updated_at = ? WHERE id = ?",
        [u.status, u.reason ?? null, now, u.id],
      );
    }
  }

  findNewsByHash(hash: string): NewsCacheRow | null {
    return this.queryOne<NewsCacheRow>(
      `SELECT id, source, source_id AS sourceId, published_at AS publishedAt,
              title, summary, importance, tags, url, content_hash AS contentHash,
              llm_status AS llmStatus, llm_reason AS llmReason, created_at AS createdAt, updated_at AS updatedAt
       FROM news_cache WHERE content_hash = ? LIMIT 1`,
      [hash],
    );
  }

  cleanupOldNews(hours: number): number {
    const cutoff = Date.now() - hours * 3600_000;
    const before = (this.queryOne<{ c: number }>("SELECT count(*) AS c FROM news_cache WHERE created_at < ?", [cutoff]))?.c ?? 0;
    if (before > 0) {
      this.execute("DELETE FROM news_cache WHERE created_at < ?", [cutoff]);
    }
    return before;
  }

  countPendingNews(withinHours: number): number {
    const cutoff = new Date(Date.now() - withinHours * 3600_000).toISOString();
    const row = this.queryOne<{ c: number }>(
      "SELECT count(*) AS c FROM news_cache WHERE llm_status = 'pending' AND published_at > ?",
      [cutoff],
    );
    return row?.c ?? 0;
  }

  countKeptNews(withinHours: number): number {
    const cutoff = new Date(Date.now() - withinHours * 3600_000).toISOString();
    const row = this.queryOne<{ c: number }>(
      "SELECT count(*) AS c FROM news_cache WHERE llm_status = 'kept' AND published_at > ?",
      [cutoff],
    );
    return row?.c ?? 0;
  }

  getNewsRefreshConfig(): NewsRefreshConfigRow {
    return this.queryOne<NewsRefreshConfigRow>(
      `SELECT id, enabled, cron_expr AS cronExpr, last_refresh_at AS lastRefreshAt
       FROM news_refresh_config WHERE id = 1`,
    ) ?? { id: 1, enabled: 1, cronExpr: "0 * * * *", lastRefreshAt: null };
  }

  updateNewsRefreshConfig(config: Partial<Omit<NewsRefreshConfigRow, "id">>): void {
    const sets: string[] = [];
    const vals: SqlValue[] = [];
    if (config.enabled !== undefined) { sets.push("enabled = ?"); vals.push(config.enabled); }
    if (config.cronExpr !== undefined) { sets.push("cron_expr = ?"); vals.push(config.cronExpr); }
    if (config.lastRefreshAt !== undefined) { sets.push("last_refresh_at = ?"); vals.push(config.lastRefreshAt); }
    if (sets.length > 0) {
      this.execute(`UPDATE news_refresh_config SET ${sets.join(", ")} WHERE id = 1`, vals);
    }
  }
}
