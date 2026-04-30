/**
 * 内置工具聚合层 — 统一创建所有内置工具
 *
 * 新增工具只需两步：
 * 1. 在 builtin/ 下创建工厂函数 createXxxTool(options): Tool | Tool[]
 * 2. 在本文件的 createBuiltinTools() 中调用并 push 进数组
 *
 * 无需修改 index.ts、registry.ts 或 agent/loop.ts。
 */

import type { Tool } from "./types.js";
import type { AppConfig } from "../config/types.js";
import type { SchedulerService } from "./scheduler/service.js";
import type { SessionStore } from "../session/store/interface.js";
import type { Provider } from "../llm/types.js";
import { createReminderTools } from "./builtin/schedule-reminder.js";
import { createWebSearchTool } from "./builtin/web-search.js";
import { createFinanceNewsTool } from "./finance-news/index.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("builtin-tools");

/** 创建内置工具所需的外部依赖 */
export interface BuiltinToolsDeps {
  config: AppConfig;
  scheduler: SchedulerService;
  /** SessionStore — 供资讯工具读写 news_cache */
  store: SessionStore;
  /** LLM Provider — 供资讯工具做 LLM 二次筛选 */
  provider: Provider;
}

/** 一次性创建所有内置工具，返回工具数组供 registry 批量注册 */
export function createBuiltinTools(deps: BuiltinToolsDeps): Tool[] {
  const tools: Tool[] = [];

  // ── 定时提醒（3 个工具） ──
  tools.push(...createReminderTools({
    scheduler: deps.scheduler,
  }));

  // ── 联网搜索 ──
  tools.push(createWebSearchTool({
    timeoutMs: deps.config.tools.webFetch.timeoutMs,
    maxBodySizeKB: deps.config.tools.webFetch.maxBodySizeKB,
    fetchDetail: true,
    fetchDetailMax: 2,
  }));

  // ── 财经资讯 ──
  tools.push(createFinanceNewsTool({
    timeoutMs: deps.config.tools.webFetch.timeoutMs,
    store: deps.store,
    provider: deps.provider,
    filterModel: deps.config.tools.filterModel ?? deps.config.session.memory.summaryModel,
  }));

  // ── 🔮 未来扩展点（示例） ──
  // if (deps.config.tools.weather?.enabled) {
  //   tools.push(createWeatherTool({ apiKey: deps.config.tools.weather.apiKey }));
  // }
  // if (deps.config.tools.webFetch?.enabled) {
  //   tools.push(createWebFetchTool({ ... }));
  // }

  log.info({ count: tools.length, names: tools.map((t) => t.name) }, "内置工具创建完成");
  return tools;
}
