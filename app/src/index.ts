import { execSync } from "node:child_process";
import { resolve } from "node:path";
import Fastify from "fastify";

// Windows 终端中文乱码修复：切换代码页到 UTF-8
if (process.platform === "win32") {
  try { execSync("chcp 65001", { stdio: "ignore" }); } catch { /* ignore */ }
}

import { loadConfig } from "./config/loader.js";
import { ProviderRegistry } from "./llm/registry.js";
import { OpenAICompatibleProvider } from "./llm/openai-compatible/client.js";
import { ModelRouter } from "./llm/model-router.js";
import { ChannelRegistry } from "./channel/registry.js";
import type { Channel } from "./channel/types.js";
import { FeishuChannel } from "./channel/feishu/index.js";
import { ToolRegistry } from "./tool/registry.js";
import { ToolExecutor } from "./tool/executor.js";
import { SessionManager } from "./session/manager.js";
import { SqliteSessionStore } from "./session/store/sqlite.js";
import { createRouter } from "./router/router.js";
import { SchedulerStore } from "./tool/scheduler/store.js";
import { SchedulerService } from "./tool/scheduler/service.js";
import { createBuiltinTools } from "./tool/create-builtin-tools.js";
import { createLogger } from "./shared/logger.js";

const log = createLogger("main");

async function main(): Promise<void> {
  log.info("FroadClaw-Agent 启动中...");

  // 1. 加载配置
  const config = loadConfig();

  // 2. 初始化 SQLite
  const dbPath = process.env["DB_PATH"] ?? resolve(process.cwd(), "data", "froadclaw.db");
  const store = await SqliteSessionStore.create(dbPath);

  // 3. 注册 LLM Providers
  const providerRegistry = new ProviderRegistry();
  let defaultContextWindow = 131072;

  for (const p of config.providers) {
    providerRegistry.register(new OpenAICompatibleProvider(p.id, p.baseUrl, p.apiKey, p.models));
    log.info({ id: p.id, models: p.models }, "LLM Provider 注册成功，可用模型: %s", p.models.join(", "));
    if (p.contextWindow) defaultContextWindow = p.contextWindow;
  }

  // 4. 模型路由
  const modelRouter = new ModelRouter(config.modelRouting);

  // 5. 定时任务调度引擎
  const schedulerStore = new SchedulerStore(store.getDatabase());
  const channelMap = new Map<string, Channel>();

  // 6. 注册工具
  const toolRegistry = new ToolRegistry();
  const toolExecutor = new ToolExecutor(toolRegistry, defaultContextWindow);

  // 7. 会话管理
  const sessionManager = new SessionManager(store, config.session, config.modelRouting.default ?? "qwen/qwen-plus");

  // 8. 注册渠道
  const channelRegistry = new ChannelRegistry();
  const feishuChannel = new FeishuChannel(config.channels.feishu);
  channelRegistry.register(feishuChannel);
  channelMap.set("feishu", feishuChannel);

  // 9. 初始化调度引擎 + 创建内置工具
  const scheduler = new SchedulerService({ store: schedulerStore, channelMap });
  const defaultProvider = providerRegistry.getOrThrow(config.providers[0]!.id);
  const builtinTools = createBuiltinTools({ config, scheduler, store, provider: defaultProvider });
  builtinTools.forEach((t) => toolRegistry.register(t));

  // 10. 创建路由
  const router = createRouter({
    providerRegistry,
    modelRouter,
    toolRegistry,
    toolExecutor,
    sessionManager,
    sessionStore: store,
    sessionConfig: config.session,
    channel: feishuChannel,
    rateLimitConfig: config.rateLimit,
  });

  // 绑定消息回调
  feishuChannel.onMessage((msg) => router.onInboundMessage(msg));

  // 注入调度引擎的 agent 模式回调：触发时构造合成消息进入 Agent Loop
  scheduler.setAgentTriggerCallback((msg) => router.onInboundMessage(msg));

  // 9. 启动 Fastify（健康检查）
  const fastify = Fastify({ logger: false });

  fastify.get("/health", async () => ({ status: "ok", uptime: process.uptime() }));

  await fastify.listen({ port: config.server.port, host: config.server.host });
  log.info({ port: config.server.port }, "HTTP 服务已启动");

  // 启动渠道
  await channelRegistry.startAll();

  // 启动调度引擎（加载 DB 中的 active 任务）
  scheduler.start();

  log.info("FroadClaw-Agent 已就绪");

  // 11. 定期清理过期数据
  setInterval(() => {
    const result = store.cleanupExpired();
    if (result.sessions > 0 || result.dedups > 0) {
      log.info(result, "清理过期数据");
    }
  }, 3600_000);

  // 12. 优雅关闭
  const shutdown = async (signal: string) => {
    log.info({ signal }, "收到关闭信号");
    await router.shutdown();
    toolRegistry.stopAll();
    scheduler.stop();
    await channelRegistry.stopAll();
    await fastify.close();
    store.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.fatal({ err }, "启动失败");
  process.exit(1);
});
