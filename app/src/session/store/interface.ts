export interface SessionStore {
  getSession(id: string): SessionRow | null;
  upsertSession(session: SessionRow): void;
  getMessages(sessionId: string): MessageRow[];
  /** 只获取未摘要的消息 */
  getUnsummarizedMessages(sessionId: string): MessageRow[];
  /** 获取未摘要消息数量 */
  countUnsummarized(sessionId: string): number;
  appendMessage(msg: Omit<MessageRow, "id" | "createdAt">): number;
  /** 获取当前最大 seq（用于正确赋值新消息 seq） */
  getMaxSeq(sessionId: string): number;
  /** 标记消息为已摘要 */
  markSummarized(sessionId: string, maxSeq: number): void;
  deleteMessagesBefore(sessionId: string, turn: number): void;
  logUsage(log: UsageLogRow): void;
  logToolExecution(log: ToolExecutionRow): void;
  checkAndMarkDedup(messageId: string, channelType: string): boolean;
  cleanupExpired(): { sessions: number; dedups: number };

  // ── User Memory ──
  getUserMemories(userId: string): UserMemoryRow[];
  /** 获取该用户画像最近一次更新时间（ISO字符串），无画像返回 null */
  getLastExtractTime(userId: string): string | null;
  upsertUserMemory(mem: Omit<UserMemoryRow, "id">): void;
  replaceUserMemories(userId: string, memories: Array<Omit<UserMemoryRow, "id">>): void;
  deleteUserMemory(userId: string, category: string, content: string): void;
  countUserMemories(userId: string, category: string): number;

  // ── News Cache ──
  /** 批量入库资讯（INSERT OR IGNORE，同源同ID跳过） */
  insertNewsItems(items: Array<Omit<NewsCacheRow, "id">>): number;
  /** 查询待 LLM 筛选的资讯（status=pending，最近 withinHours 小时内） */
  getPendingNews(withinHours: number, limit: number): NewsCacheRow[];
  /** 查询已保留的资讯（status=kept，最近 withinHours 小时内） */
  getKeptNews(withinHours: number, limit: number): NewsCacheRow[];
  /** 批量更新 LLM 筛选结果 */
  updateNewsLlmStatus(updates: Array<{ id: number; status: string; reason?: string }>): void;
  /** 按 content_hash 查询是否已存在（跨源去重） */
  findNewsByHash(hash: string): NewsCacheRow | null;
  /** 清理超过 hours 小时的旧资讯 */
  cleanupOldNews(hours: number): number;
  /** 查询 pending 状态的资讯条数 */
  countPendingNews(withinHours: number): number;
  /** 查询 kept 状态的资讯条数 */
  countKeptNews(withinHours: number): number;

  // ── News Refresh Config ──
  /** 获取资讯刷新配置（单行记录） */
  getNewsRefreshConfig(): NewsRefreshConfigRow;
  /** 更新资讯刷新配置 */
  updateNewsRefreshConfig(config: Partial<Omit<NewsRefreshConfigRow, "id">>): void;
}

export interface SessionRow {
  id: string;
  channelType: string;
  chatId: string;
  isGroup: number;
  currentModel: string;
  estimatedTokens: number;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface MessageRow {
  id: number;
  sessionId: string;
  seq: number;
  role: string;
  content: string | null;
  toolCalls: string | null;
  toolCallId: string | null;
  tokenEstimate: number;
  turn: number;
  summarized: number;
  createdAt: string;
}

export interface UsageLogRow {
  sessionId: string;
  providerId: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  hasTools: number;
  loopIteration: number;
  finishReason: string;
}

export interface ToolExecutionRow {
  sessionId: string;
  messageId: number | null;
  toolCallId: string;
  toolName: string;
  inputParams: string | null;
  outputContent: string | null;
  rawLength: number | null;
  isError: number;
  errorMessage: string | null;
  durationMs: number | null;
}

export interface UserMemoryRow {
  id?: number;
  userId: string;
  category: string;
  content: string;
  sourceSession: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 资讯缓存行 */
export interface NewsCacheRow {
  id: number;
  /** 来源渠道: cls / sina / ths */
  source: string;
  /** 渠道内原始文章 ID */
  sourceId: string;
  /** 发布时间（ISO 8601 格式） */
  publishedAt: string;
  /** 标题 */
  title: string;
  /** 纯文本摘要 */
  summary: string;
  /** 渠道重要度: high / medium / low */
  importance: string;
  /** 话题标签 JSON 数组 */
  tags: string;
  /** 原文链接 */
  url: string | null;
  /** 摘要内容哈希（跨源去重） */
  contentHash: string;
  /** LLM 筛选状态: pending / kept / dropped / duplicate */
  llmStatus: string;
  /** LLM 丢弃理由 */
  llmReason: string | null;
  /** 入库时间（毫秒时间戳） */
  createdAt: number;
  /** 最近更新时间（ISO 8601） */
  updatedAt: string;
}

/** 资讯刷新配置行 */
export interface NewsRefreshConfigRow {
  id: number;
  /** 是否启用后台刷新: 1=启用, 0=暂停 */
  enabled: number;
  /** cron 表达式 */
  cronExpr: string;
  /** 上次刷新时间 ISO8601 */
  lastRefreshAt: string | null;
}
