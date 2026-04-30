/**
 * 配置类型定义 — 与 configs/config.yaml 一一对应
 */

export interface AppConfig {
  server: ServerConfig;
  providers: ProviderConfig[];
  modelRouting: ModelRoutingConfig;
  channels: ChannelsConfig;
  session: SessionConfig;
  tools: ToolsConfig;
  rateLimit: RateLimitConfig;
}

export interface ServerConfig {
  port: number;
  host: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  /** 模型ID列表（逗号分隔解析），第一个为默认，后续为降级备选 */
  models: string[];
  maxTokens: number;
  contextWindow: number;
}

export interface ModelRoutingConfig {
  /** 自动派生：第一个 provider 的第一个 model */
  default?: string;
  commands: Record<string, string>;
  /** 按场景选模型 */
  sceneModels?: {
    /** 工作场景（财经）用高级模型 */
    work: string;
    /** 生活场景用经济模型 */
    life: string;
  };
}

export interface ChannelsConfig {
  feishu: FeishuChannelConfig;
}

export interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
}

export interface SessionConfig {
  maxHistoryTokens: number;
  ttlHours: number;
  memory: MemoryConfig;
}

export interface MemoryConfig {
  /** 未摘要消息达到多少条时触发压缩 */
  compressThreshold: number;
  /** 保留最近 N 条不压缩（短期记忆） */
  recentKeep: number;
  /** 摘要最大字符数，超限触发二次压缩 */
  maxSummaryLength: number;
  /** 摘要使用的模型（用便宜的） */
  summaryModel: string;
  /** 用户画像抽取冷却时间（分钟），0 表示不限制 */
  extractCooldownMinutes: number;
  /** 摘要变化率阈值（0~1），Jaccard 相似度超过此值则跳过抽取，0 表示不检测 */
  extractSimilarityThreshold: number;
}

export interface ToolsConfig {
  webFetch: { timeoutMs: number; maxBodySizeKB: number };
  httpApi: { timeoutMs: number; allowedDomains: string[] };
  jsRender: { enabled: boolean; maxConcurrent: number };
  /** 资讯筛选模型（建议用快速模型），未配置时降级到 summaryModel */
  filterModel?: string;
}

export interface RateLimitConfig {
  maxPerMinutePerUser: number;
  maxConcurrentGlobal: number;
}
