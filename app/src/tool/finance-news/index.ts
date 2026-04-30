/**
 * finance_news 工具 — 财经资讯聚合（后台预热 + 按需查询）
 *
 * 架构：
 * - 后台：NewsRefreshService 定时拉取 → 入库去重 → 攒批 LLM 筛选
 * - 前台：用户调用时直接查 DB kept 数据 → 格式化输出
 * - 控制：用户可暂停/恢复/调整间隔/查看统计
 *
 * 渠道扩展：实现 NewsSource 接口，在 refresh-service.ts 的 sources[] 中注册
 */
import type { Tool, ToolResult } from "../types.js";
import type { ToolCallContext } from "../tool-context.js";
import type { Provider } from "../../llm/types.js";
import type { SessionStore, NewsCacheRow } from "../../session/store/interface.js";
import type { NewsImportance } from "./types.js";
import { NewsRefreshService } from "./refresh-service.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("tool-finance-news");

/* ────────────── 工厂配置 ────────────── */

export interface FinanceNewsToolOptions {
  /** 请求超时（ms） */
  timeoutMs: number;
  /** SessionStore 实例（用于读写 news_cache） */
  store: SessionStore;
  /** LLM Provider（用于二次筛选） */
  provider: Provider;
  /** 筛选用模型 ID（推荐 flash 级别） */
  filterModel: string;
}

/* ────────────── 格式化 ────────────── */

/** 重要度标记 */
const IMPORTANCE_LABEL: Record<NewsImportance, string> = {
  high: "🔴",
  medium: "🟡",
  low: "⚪",
};

/** 将 NewsCacheRow 转为格式化文本行 */
function formatCacheItem(item: NewsCacheRow, idx: number): string {
  const d = new Date(item.publishedAt);
  const today = new Date();
  const isToday =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();

  const time = d.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    ...(isToday ? {} : { month: "2-digit", day: "2-digit" }),
    hour: "2-digit",
    minute: "2-digit",
  });
  const imp = (item.importance as NewsImportance) || "low";
  const label = IMPORTANCE_LABEL[imp] ?? "⚪";
  const title = item.title || "(快讯)";
  const tags: string[] = (() => {
    try { return JSON.parse(item.tags) as string[]; } catch { return []; }
  })();
  const tagStr = tags.length > 0 ? ` [${tags.slice(0, 3).join(", ")}]` : "";
  const summary = item.summary.length > 200
    ? item.summary.slice(0, 200) + "..."
    : item.summary;

  return `${label} [${idx + 1}] ${time} ${title}${tagStr}\n   ${summary}`;
}

/** 格式化完整输出 */
function formatCacheOutput(items: NewsCacheRow[]): string {
  if (items.length === 0) {
    return "暂无最新财经资讯。";
  }
  const lines = items.map((item, i) => formatCacheItem(item, i));
  return `最新财经资讯（共 ${items.length} 条）:\n\n${lines.join("\n\n")}`;
}

/* ────────────── 重要度参数解析 ────────────── */

const IMPORTANCE_ALIAS: Record<string, NewsImportance> = {
  high: "high",
  medium: "medium",
  low: "low",
  "重要": "high",
  "加红": "high",
  "全部": "low",
};

function parseImportance(raw: unknown): NewsImportance {
  const str = String(raw ?? "").trim().toLowerCase();
  return IMPORTANCE_ALIAS[str] ?? "low";
}

/** 重要度权重 */
const IMP_WEIGHT: Record<string, number> = { high: 3, medium: 2, low: 1 };

/* ────────────── action 处理器 ────────────── */

/** 查询资讯：直接从 DB 读 kept 数据 */
function handleQuery(store: SessionStore, count: number, minWeight: number): ToolResult {
  const keptItems = store.getKeptNews(24, count + 20);

  const filtered = keptItems
    .filter((it) => (IMP_WEIGHT[it.importance] ?? 1) >= minWeight)
    .sort((a, b) => {
      const wDiff = (IMP_WEIGHT[b.importance] ?? 1) - (IMP_WEIGHT[a.importance] ?? 1);
      if (wDiff !== 0) return wDiff;
      return b.publishedAt < a.publishedAt ? 1 : b.publishedAt > a.publishedAt ? -1 : 0;
    })
    .slice(0, count);

  log.info({ kept: keptItems.length, filtered: filtered.length }, "查询输出 %d 条", filtered.length);

  // 顺便清理 48h 前的旧数据
  const cleaned = store.cleanupOldNews(48);
  if (cleaned > 0) log.info({ cleaned }, "清理 %d 条过期资讯", cleaned);

  return { content: formatCacheOutput(filtered), isError: false };
}

/** 统计资讯数量 */
function handleCount(store: SessionStore): ToolResult {
  const kept = store.countKeptNews(48);
  const pending = store.countPendingNews(48);
  const content = `📊 资讯统计（48小时内）:\n- 有效资讯（已筛选）: ${kept} 条\n- 待筛选: ${pending} 条\n- 合计: ${kept + pending} 条`;
  return { content, isError: false };
}

/** 暂停后台刷新 */
function handlePause(refreshService: NewsRefreshService): ToolResult {
  refreshService.stop();
  return { content: "✅ 资讯后台刷新已暂停。", isError: false };
}

/** 恢复后台刷新 */
function handleResume(refreshService: NewsRefreshService): ToolResult {
  refreshService.resume();
  const status = refreshService.getStatus();
  return { content: `✅ 资讯后台刷新已恢复，当前间隔: ${status.cronExpr}`, isError: false };
}

/** 查看刷新状态 */
function handleStatus(refreshService: NewsRefreshService, store: SessionStore): ToolResult {
  const status = refreshService.getStatus();
  const kept = store.countKeptNews(48);
  const pending = store.countPendingNews(48);
  const stateText = status.enabled ? "运行中" : "已暂停";
  const lastText = status.lastRefreshAt
    ? new Date(status.lastRefreshAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
    : "尚未刷新";
  const refreshingText = status.isRefreshing ? "（正在刷新中...）" : "";

  const content = `📡 资讯刷新状态:\n- 状态: ${stateText}${refreshingText}\n- 刷新间隔: ${status.cronExpr}\n- 上次刷新: ${lastText}\n- 有效资讯: ${kept} 条\n- 待筛选: ${pending} 条`;
  return { content, isError: false };
}

/** 设置刷新间隔 */
function handleSetInterval(refreshService: NewsRefreshService, cronExpr: string): ToolResult {
  const ok = refreshService.updateCron(cronExpr);
  if (!ok) {
    return { content: `❌ 无效的 cron 表达式: ${cronExpr}`, isError: true };
  }
  return { content: `✅ 资讯刷新间隔已更新为: ${cronExpr}`, isError: false };
}

/* ────────────── 工具创建 ────────────── */

/** 创建财经资讯工具（后台预热 + 按需查询 + 用户控制） */
export function createFinanceNewsTool(options: FinanceNewsToolOptions): Tool {
  const { store, provider, filterModel, timeoutMs } = options;

  // 创建后台刷新服务（onStart 时启动，onStop 时销毁）
  const refreshService = new NewsRefreshService({
    store, provider, filterModel, timeoutMs,
  });

  return {
    name: "finance_news",
    description: `财经资讯工具。支持以下操作:
- action="query"（默认）: 获取最新财经资讯，可指定 count（条数）和 importance（重要度）
- action="count": 查看当前资讯库存数量
- action="pause": 暂停后台自动获取新闻
- action="resume": 恢复后台自动获取新闻
- action="status": 查看后台刷新状态
- action="set_interval": 设置刷新间隔，需提供 cron_expr 参数（如 "*/30 * * * *" 表示每30分钟）
当用户询问财经新闻、股市动态、期货行情、宏观经济政策等金融相关实时资讯时使用 query。
当用户要求暂停/恢复/修改获取新闻频率时使用对应 action。`,
    systemHint: `finance_news: 财经/股市/期货/经济相关资讯优先用此工具，比 web_search 更快更精准。
支持控制操作: pause(暂停)、resume(恢复)、status(状态)、count(统计)、set_interval(改间隔)。`,
    loadingHint: "📡 正在获取最新财经资讯，请稍候...",
    timeoutMs: 30_000,
    parameterSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["query", "count", "pause", "resume", "status", "set_interval"],
          description: "操作类型，默认 query",
        },
        count: {
          type: "number",
          description: "获取条数，默认15，最大30（仅 query 时有效）",
        },
        importance: {
          type: "string",
          description: "重要度筛选: '重要'(仅重大) / 'medium'(中等以上) / '全部'(默认)（仅 query 时有效）",
        },
        cron_expr: {
          type: "string",
          description: "cron 表达式（仅 set_interval 时需要），如 '*/30 * * * *' 表示每30分钟",
        },
      },
      required: [],
    },

    /** 注册后自动启动后台刷新 */
    onStart(): void {
      refreshService.start();
    },

    /** 系统关闭时销毁后台刷新 */
    onStop(): void {
      refreshService.destroy();
    },

    async execute(params: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
      const action = String(params["action"] ?? "query").trim().toLowerCase();

      switch (action) {
        case "query": {
          const rawCount = Math.min(Math.max(Number(params["count"]) || 15, 1), 30);
          const minImportance = parseImportance(params["importance"]);
          const minWeight = IMP_WEIGHT[minImportance] ?? 1;
          log.info({ rawCount, minImportance, action }, "执行资讯查询");
          return handleQuery(store, rawCount, minWeight);
        }
        case "count":
          return handleCount(store);
        case "pause":
          return handlePause(refreshService);
        case "resume":
          return handleResume(refreshService);
        case "status":
          return handleStatus(refreshService, store);
        case "set_interval": {
          const cronExpr = String(params["cron_expr"] ?? "").trim();
          if (!cronExpr) {
            return { content: "❌ 请提供 cron_expr 参数", isError: true };
          }
          return handleSetInterval(refreshService, cronExpr);
        }
        default:
          return { content: `❌ 未知操作: ${action}`, isError: true };
      }
    },
  };
}
