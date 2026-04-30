import type { AppConfig } from "./types.js";

/** 默认配置值 — 与 config.yaml 中未填字段合并 */
export const DEFAULT_CONFIG: AppConfig = {
  server: { port: 3000, host: "0.0.0.0" },
  providers: [],
  modelRouting: { commands: {} },
  channels: { feishu: { appId: "", appSecret: "" } },
  session: { maxHistoryTokens: 32000, ttlHours: 24, memory: { compressThreshold: 8, recentKeep: 6, maxSummaryLength: 800, summaryModel: "qwen-long", extractCooldownMinutes: 120, extractSimilarityThreshold: 0.85 } },
  tools: {
    webFetch: { timeoutMs: 15000, maxBodySizeKB: 512 },
    httpApi: { timeoutMs: 30000, allowedDomains: [] },
    jsRender: { enabled: false, maxConcurrent: 1 },
  },
  rateLimit: { maxPerMinutePerUser: 10, maxConcurrentGlobal: 5 },
};
