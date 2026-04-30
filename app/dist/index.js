// src/index.ts
import { execSync } from "child_process";
import { resolve as resolve3 } from "path";
import Fastify from "fastify";

// src/config/loader.ts
import { readFileSync } from "fs";
import { resolve as resolve2 } from "path";
import { parse as parseYaml } from "yaml";
import { config as loadDotenv } from "dotenv";

// src/config/defaults.ts
var DEFAULT_CONFIG = {
  server: { port: 3e3, host: "0.0.0.0" },
  providers: [],
  modelRouting: { commands: {} },
  channels: { feishu: { appId: "", appSecret: "" } },
  session: { maxHistoryTokens: 32e3, ttlHours: 24, memory: { compressThreshold: 8, recentKeep: 6, maxSummaryLength: 800, summaryModel: "qwen-long", extractCooldownMinutes: 120, extractSimilarityThreshold: 0.85 } },
  tools: {
    webFetch: { timeoutMs: 15e3, maxBodySizeKB: 512 },
    httpApi: { timeoutMs: 3e4, allowedDomains: [] },
    jsRender: { enabled: false, maxConcurrent: 1 }
  },
  rateLimit: { maxPerMinutePerUser: 10, maxConcurrentGlobal: 5 }
};

// src/shared/logger.ts
import { createWriteStream, mkdirSync } from "fs";
import { resolve } from "path";
import { Transform } from "stream";
import pino from "pino";
var isDev = process.env["NODE_ENV"] !== "production";
var LOG_LEVEL = process.env["LOG_LEVEL"] ?? "info";
var LOG_DIR = process.env["LOG_DIR"] ?? resolve(process.cwd(), "logs");
var LEVEL_LABELS = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO",
  40: "WARN",
  50: "ERROR",
  60: "FATAL"
};
function formatTime(epoch) {
  const d = new Date(epoch);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function today() {
  return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
}
var RollingFileStream = class {
  stream = null;
  currentDate = "";
  dir;
  prefix;
  constructor(dir, prefix) {
    this.dir = dir;
    this.prefix = prefix;
  }
  getStream() {
    const d = today();
    if (d !== this.currentDate || !this.stream) {
      this.currentDate = d;
      const filePath = resolve(this.dir, `${this.prefix}-${d}.log`);
      const oldStream = this.stream;
      if (oldStream) setTimeout(() => oldStream.end(), 1e3);
      this.stream = createWriteStream(filePath, { flags: "a" });
    }
    return this.stream;
  }
};
function createRollingDestination(rolling) {
  return new Proxy({}, {
    get(_target, prop) {
      const stream = rolling.getStream();
      const val = stream[prop];
      if (typeof val === "function") return val.bind(stream);
      return val;
    }
  });
}
var OMIT_KEYS = /* @__PURE__ */ new Set(["level", "time", "pid", "hostname", "msg", "module"]);
function createCompactTransform() {
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const obj = JSON.parse(chunk.toString().trim());
        const time = formatTime(obj.time);
        const level = LEVEL_LABELS[obj.level] ?? "INFO";
        const mod = obj.module ? String(obj.module) : "app";
        const msg = obj.msg ? String(obj.msg) : "";
        const extras = [];
        for (const [k, v] of Object.entries(obj)) {
          if (OMIT_KEYS.has(k)) continue;
          if (v === void 0 || v === null) continue;
          const val = typeof v === "object" ? JSON.stringify(v) : String(v);
          extras.push(`${k}=${val}`);
        }
        let line = `${time} [${level}] ${mod} - ${msg}`;
        if (extras.length > 0) line += ` | ${extras.join(" ")}`;
        callback(null, line + "\n");
      } catch {
        callback(null, chunk);
      }
    }
  });
}
function buildLogger() {
  mkdirSync(LOG_DIR, { recursive: true });
  const appRolling = new RollingFileStream(LOG_DIR, "app");
  const errorRolling = new RollingFileStream(LOG_DIR, "error");
  const appTransform = createCompactTransform();
  appTransform.pipe(createRollingDestination(appRolling));
  const errorTransform = createCompactTransform();
  errorTransform.pipe(createRollingDestination(errorRolling));
  const streams = [
    { level: LOG_LEVEL, stream: appTransform },
    { level: "error", stream: errorTransform }
  ];
  if (isDev) {
    const pretty = pino.transport({
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss",
        ignore: "pid,hostname"
      }
    });
    streams.push({ level: LOG_LEVEL, stream: pretty });
  }
  return pino({ level: LOG_LEVEL }, pino.multistream(streams));
}
var logger = buildLogger();
function createLogger(module) {
  return logger.child({ module });
}

// src/config/loader.ts
var log = createLogger("config");
function loadConfig(configPath) {
  loadDotenv();
  const filePath = configPath ?? resolve2(process.cwd(), "configs", "config.yaml");
  log.info({ path: filePath }, "\u52A0\u8F7D\u914D\u7F6E\u6587\u4EF6");
  let raw;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    log.warn("\u914D\u7F6E\u6587\u4EF6\u4E0D\u5B58\u5728\uFF0C\u4F7F\u7528\u9ED8\u8BA4\u914D\u7F6E");
    return DEFAULT_CONFIG;
  }
  const expanded = raw.replace(/\$\{(\w+)}/g, (_, key) => {
    const val = process.env[key];
    if (!val) log.warn({ key }, "\u73AF\u5883\u53D8\u91CF\u672A\u8BBE\u7F6E");
    return val ?? "";
  });
  const parsed = parseYaml(expanded);
  const merged = deepMerge(DEFAULT_CONFIG, parsed);
  for (const p of merged.providers) {
    if (typeof p.models === "string") {
      p.models = p.models.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  if (!merged.modelRouting.default && merged.providers.length > 0) {
    const first = merged.providers[0];
    const firstModel = first.models[0];
    if (firstModel) merged.modelRouting.default = `${first.id}/${firstModel}`;
  }
  return merged;
}
function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const baseVal = base[key];
    const overVal = override[key];
    if (overVal !== null && typeof overVal === "object" && !Array.isArray(overVal) && typeof baseVal === "object" && baseVal !== null && !Array.isArray(baseVal)) {
      result[key] = deepMerge(baseVal, overVal);
    } else if (overVal !== void 0) {
      result[key] = overVal;
    }
  }
  return result;
}

// src/llm/registry.ts
var log2 = createLogger("llm-registry");
var ProviderRegistry = class {
  providers = /* @__PURE__ */ new Map();
  register(provider) {
    log2.info({ id: provider.id }, "\u6CE8\u518C LLM Provider");
    this.providers.set(provider.id, provider);
  }
  get(id) {
    return this.providers.get(id);
  }
  getOrThrow(id) {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Provider \u672A\u6CE8\u518C: ${id}`);
    return provider;
  }
  listIds() {
    return [...this.providers.keys()];
  }
};

// src/llm/openai-compatible/client.ts
import OpenAI from "openai";

// src/shared/errors.ts
var AppError = class extends Error {
  constructor(message, code, statusCode = 500) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.name = "AppError";
  }
  /** 生成用户可见的异常概要 */
  toUserMessage() {
    return `\u274C ${this.message}`;
  }
};
var LlmError = class extends AppError {
  constructor(message, provider) {
    super(message, "LLM_ERROR");
    this.provider = provider;
    this.name = "LlmError";
  }
  toUserMessage() {
    return `\u274C AI \u54CD\u5E94\u5F02\u5E38: ${this.message}`;
  }
};
var RateLimitError = class extends AppError {
  constructor(retryAfterSec) {
    super(`\u8BF7\u6C42\u592A\u9891\u7E41\uFF0C\u8BF7\u7B49\u5F85 ${retryAfterSec} \u79D2`, "RATE_LIMIT", 429);
    this.retryAfterSec = retryAfterSec;
    this.name = "RateLimitError";
  }
  toUserMessage() {
    return `\u23F3 \u8BF7\u6C42\u592A\u9891\u7E41\uFF0C\u8BF7\u7B49\u5F85 ${this.retryAfterSec} \u79D2\u540E\u91CD\u8BD5`;
  }
};
function toUserErrorMessage(err) {
  if (err instanceof AppError) return err.toUserMessage();
  if (err instanceof Error) return `\u274C \u5904\u7406\u5F02\u5E38: ${err.message}`;
  return "\u274C \u672A\u77E5\u5F02\u5E38\uFF0C\u8BF7\u91CD\u8BD5";
}

// src/llm/openai-compatible/client.ts
var log3 = createLogger("openai-compatible");
var RETRYABLE_STATUS = /* @__PURE__ */ new Set([429, 402, 403, 500, 503]);
var RETRYABLE_PATTERN = /rate.?limit|quota|billing|insufficient|balance|overloaded|capacity|throttl/i;
var OpenAICompatibleProvider = class {
  constructor(id, baseUrl, apiKey, models = []) {
    this.id = id;
    this.models = models;
    this.client = new OpenAI({ baseURL: baseUrl, apiKey });
  }
  client;
  async chatCompletion(req) {
    const tryList = [req.model, ...this.models.filter((m) => m !== req.model)];
    const seen = /* @__PURE__ */ new Set();
    const uniqueList = tryList.filter((m) => {
      if (seen.has(m)) return false;
      seen.add(m);
      return true;
    });
    let lastError;
    for (let i = 0; i < uniqueList.length; i++) {
      const model = uniqueList[i];
      try {
        return await this.doCall({ ...req, model });
      } catch (err) {
        lastError = err;
        if (i < uniqueList.length - 1 && this.isRetryable(err)) {
          const nextModel = uniqueList[i + 1];
          log3.warn(
            { model, nextModel, err: err instanceof Error ? err.message : String(err) },
            "\u6A21\u578B %s \u8C03\u7528\u5931\u8D25\uFF0C\u81EA\u52A8\u5207\u6362\u5230 %s",
            model,
            nextModel
          );
          continue;
        }
        if (err instanceof LlmError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        log3.error({ err, provider: this.id, model }, "LLM \u8C03\u7528\u5931\u8D25 (\u65E0\u53EF\u7528\u5907\u9009)");
        throw new LlmError(message, this.id);
      }
    }
    throw lastError instanceof LlmError ? lastError : new LlmError("\u6240\u6709\u6A21\u578B\u5747\u8C03\u7528\u5931\u8D25", this.id);
  }
  /** 判断错误是否可重试（欠费/限流/服务端异常） */
  isRetryable(err) {
    if (err instanceof OpenAI.APIError) {
      return RETRYABLE_STATUS.has(err.status);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return RETRYABLE_PATTERN.test(msg);
  }
  /** 实际 LLM 调用 */
  async doCall(req) {
    log3.debug(
      { provider: this.id, model: req.model, messageCount: req.messages.length, hasTools: !!req.tools },
      "LLM \u8BF7\u6C42: model=%s, %d \u6761\u6D88\u606F, tools=%s",
      req.model,
      req.messages.length,
      req.tools ? req.tools.map((t) => t.function.name).join(",") : "\u65E0"
    );
    const startMs = Date.now();
    const response = await this.client.chat.completions.create({
      model: req.model,
      messages: req.messages.map((m) => this.toOpenAIMessage(m)),
      tools: req.tools?.map((t) => ({
        type: "function",
        function: t.function
      })),
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      // qwen3.5 系列：控制深度思考开关（DashScope Node.js SDK 需作为顶层参数传入）
      ...req.enableThinking !== void 0 ? { enable_thinking: req.enableThinking } : {}
    });
    const choice = response.choices[0];
    if (!choice) throw new LlmError("LLM \u8FD4\u56DE\u7A7A\u54CD\u5E94", this.id);
    const toolCalls = (choice.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments
    }));
    const durationMs = Date.now() - startMs;
    log3.info(
      {
        provider: this.id,
        model: req.model,
        durationMs,
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        finishReason: choice.finish_reason,
        toolCallCount: toolCalls.length
      },
      "LLM \u54CD\u5E94: %dms, finish=%s",
      durationMs,
      choice.finish_reason
    );
    return {
      content: choice.message.content ?? "",
      toolCalls,
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0
      },
      finishReason: choice.finish_reason ?? "stop"
    };
  }
  toOpenAIMessage(msg) {
    if (msg.role === "tool") {
      return { role: "tool", tool_call_id: msg.toolCallId ?? "", content: msg.content ?? "" };
    }
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      return {
        role: "assistant",
        content: msg.content ?? null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments }
        }))
      };
    }
    return { role: msg.role, content: msg.content ?? "" };
  }
};

// src/llm/model-router.ts
var ModelRouter = class {
  constructor(config) {
    this.config = config;
  }
  resolve(content, scene) {
    for (const [cmd, modelPath] of Object.entries(this.config.commands)) {
      if (content.startsWith(cmd)) {
        const { providerId: providerId2, modelId: modelId2 } = this.parseModelPath(modelPath);
        return { providerId: providerId2, modelId: modelId2, cleanContent: content.slice(cmd.length).trim() };
      }
    }
    if (scene && this.config.sceneModels) {
      const modelPath = scene === "work" ? this.config.sceneModels.work : this.config.sceneModels.life;
      if (modelPath) {
        const { providerId: providerId2, modelId: modelId2 } = this.parseModelPath(modelPath);
        return { providerId: providerId2, modelId: modelId2, cleanContent: content };
      }
    }
    const defaultPath = this.config.default ?? "";
    if (!defaultPath) throw new Error("\u672A\u914D\u7F6E\u9ED8\u8BA4\u6A21\u578B\u8DEF\u7531");
    const { providerId, modelId } = this.parseModelPath(defaultPath);
    return { providerId, modelId, cleanContent: content };
  }
  /** 解析 "qwen/qwen-plus" → { providerId: "qwen", modelId: "qwen-plus" } */
  parseModelPath(path) {
    const sep = path.indexOf("/");
    if (sep === -1) return { providerId: path, modelId: path };
    return { providerId: path.slice(0, sep), modelId: path.slice(sep + 1) };
  }
};

// src/channel/registry.ts
var log4 = createLogger("channel-registry");
var ChannelRegistry = class {
  channels = /* @__PURE__ */ new Map();
  register(channel) {
    log4.info({ id: channel.id }, "\u6CE8\u518C\u6E20\u9053");
    this.channels.set(channel.id, channel);
  }
  get(id) {
    return this.channels.get(id);
  }
  /** 启动所有渠道 */
  async startAll() {
    for (const [id, ch] of this.channels) {
      log4.info({ id }, "\u542F\u52A8\u6E20\u9053");
      await ch.start();
    }
  }
  /** 停止所有渠道 */
  async stopAll() {
    for (const [id, ch] of this.channels) {
      log4.info({ id }, "\u505C\u6B62\u6E20\u9053");
      await ch.stop();
    }
  }
  list() {
    return [...this.channels.values()];
  }
};

// src/channel/feishu/index.ts
import * as lark from "@larksuiteoapi/node-sdk";

// src/channel/feishu/parser.ts
function parseFeishuEvent(event, botOpenId) {
  const { sender, message } = event;
  if (!sender || !message) return null;
  if (message.message_type !== "text") return null;
  let text;
  try {
    const parsed = JSON.parse(message.content);
    text = parsed.text ?? "";
  } catch {
    return null;
  }
  text = text.replace(/@_user_\d+/g, "").trim();
  if (!text) return null;
  const isGroup = message.chat_type === "group";
  const mentionBot = message.mentions?.some((m) => m.id.open_id === botOpenId) ?? false;
  if (isGroup && !mentionBot) return null;
  return {
    messageId: message.message_id,
    channelType: "feishu",
    chatId: message.chat_id,
    senderId: sender.sender_id.open_id,
    senderName: "",
    content: text,
    mentionBot,
    isGroup,
    receivedAt: /* @__PURE__ */ new Date()
  };
}

// src/channel/feishu/index.ts
var log5 = createLogger("feishu");
var FeishuChannel = class {
  // 消息去重
  constructor(config) {
    this.config = config;
    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret
    });
  }
  id = "feishu";
  client;
  wsClient;
  messageHandler;
  processedIds = /* @__PURE__ */ new Map();
  onMessage(handler) {
    this.messageHandler = handler;
  }
  async start() {
    log5.info("\u542F\u52A8\u98DE\u4E66 WebSocket \u957F\u8FDE\u63A5");
    let botOpenId = "";
    try {
      const resp = await this.client.request({
        method: "GET",
        url: "/open-apis/bot/v3/info/"
      });
      const data = resp;
      botOpenId = data.bot?.open_id ?? "";
      if (botOpenId) log5.info({ botOpenId }, "\u83B7\u53D6 bot \u4FE1\u606F\u6210\u529F");
    } catch {
      log5.warn("\u83B7\u53D6 bot \u4FE1\u606F\u5931\u8D25\uFF0C\u7FA4\u804A @bot \u5224\u65AD\u53EF\u80FD\u5F02\u5E38");
    }
    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.warn
    });
    await this.wsClient.start({
      eventDispatcher: new lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data) => {
          const event = data;
          const msg = parseFeishuEvent(event, botOpenId);
          if (!msg) return;
          if (this.isDuplicate(msg.messageId)) return;
          this.messageHandler?.(msg);
        }
      })
    });
    setInterval(() => this.cleanupDedup(), 5 * 60 * 1e3);
    log5.info("\u98DE\u4E66 WebSocket \u5DF2\u8FDE\u63A5");
  }
  async stop() {
    log5.info("\u65AD\u5F00\u98DE\u4E66 WebSocket");
  }
  async send(msg) {
    try {
      await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: msg.chatId,
          msg_type: "text",
          content: JSON.stringify({ text: msg.content })
        }
      });
    } catch (err) {
      log5.error({ err, chatId: msg.chatId }, "\u98DE\u4E66\u6D88\u606F\u53D1\u9001\u5931\u8D25");
      throw err;
    }
  }
  /** 去重：5 分钟内的重复消息丢弃 */
  isDuplicate(messageId) {
    if (this.processedIds.has(messageId)) return true;
    this.processedIds.set(messageId, Date.now());
    return false;
  }
  cleanupDedup() {
    const expireMs = 5 * 60 * 1e3;
    const now = Date.now();
    for (const [id, ts] of this.processedIds) {
      if (now - ts > expireMs) this.processedIds.delete(id);
    }
  }
};

// src/tool/registry.ts
var log6 = createLogger("tool-registry");
var ToolRegistry = class {
  tools = /* @__PURE__ */ new Map();
  register(tool) {
    log6.info({ name: tool.name }, "\u6CE8\u518C\u5DE5\u5177");
    this.tools.set(tool.name, tool);
    if (tool.onStart) {
      try {
        tool.onStart();
        log6.info({ name: tool.name }, "\u5DE5\u5177\u542F\u52A8\u94A9\u5B50\u5DF2\u6267\u884C");
      } catch (err) {
        log6.error({ name: tool.name, err }, "\u5DE5\u5177\u542F\u52A8\u94A9\u5B50\u6267\u884C\u5931\u8D25");
      }
    }
  }
  get(name) {
    return this.tools.get(name);
  }
  /** 生成 LLM 所需的工具定义列表 */
  getDefinitions() {
    return [...this.tools.values()].map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameterSchema
      }
    }));
  }
  listNames() {
    return [...this.tools.keys()];
  }
  /** 系统关闭时调用所有工具的停止钩子 */
  stopAll() {
    for (const tool of this.tools.values()) {
      if (tool.onStop) {
        try {
          tool.onStop();
          log6.info({ name: tool.name }, "\u5DE5\u5177\u505C\u6B62\u94A9\u5B50\u5DF2\u6267\u884C");
        } catch (err) {
          log6.error({ name: tool.name, err }, "\u5DE5\u5177\u505C\u6B62\u94A9\u5B50\u6267\u884C\u5931\u8D25");
        }
      }
    }
  }
  /**
   * 聚合所有已注册工具的 systemHint，拼接为 prompt 段落
   * agent loop 调用此方法动态注入 system prompt，
   * 新增工具只需设置 systemHint 字段，无需修改 prompt.ts。
   */
  getSystemHints() {
    const hints = [];
    for (const tool of this.tools.values()) {
      if (tool.systemHint) {
        hints.push(tool.systemHint);
      }
    }
    return hints.length > 0 ? `## \u5DE5\u5177\u4F7F\u7528\u7B56\u7565
${hints.join("\n")}` : "";
  }
};

// src/tool/result-truncation.ts
var TRUNCATION_SUFFIX = "\n\n\u26A0\uFE0F [\u5185\u5BB9\u5DF2\u622A\u65AD\uFF0C\u4EC5\u4FDD\u7559\u5173\u952E\u90E8\u5206]";
var MIDDLE_OMISSION = "\n\n... [\u4E2D\u95F4\u5185\u5BB9\u7701\u7565] ...\n\n";
var IMPORTANT_TAIL_PATTERN = /error|exception|failed|fatal|traceback|panic|stack\s*trace|errno|exit\s*code|\}\s*$|total|summary|result/i;
function truncateToolResult(text, maxChars) {
  if (text.length <= maxChars) return text;
  const budget = maxChars - TRUNCATION_SUFFIX.length - MIDDLE_OMISSION.length;
  const MIN_KEEP = 200;
  const tail500 = text.slice(-500);
  if (IMPORTANT_TAIL_PATTERN.test(tail500) && budget > MIN_KEEP * 2) {
    const tailSize = Math.floor(budget * 0.3);
    const headSize = budget - tailSize;
    return text.slice(0, headSize) + MIDDLE_OMISSION + text.slice(-tailSize) + TRUNCATION_SUFFIX;
  }
  return text.slice(0, budget) + TRUNCATION_SUFFIX;
}

// src/tool/executor.ts
var log7 = createLogger("tool-executor");
var MAX_RESULT_CONTEXT_SHARE = 0.3;
var HARD_MAX_CHARS = 4e5;
var ToolExecutor = class {
  constructor(registry, contextWindow, timeoutMs = 3e4) {
    this.registry = registry;
    this.contextWindow = contextWindow;
    this.timeoutMs = timeoutMs;
  }
  async execute(name, argsJson, ctx) {
    const tool = this.registry.get(name);
    if (!tool) {
      return { content: `\u672A\u77E5\u5DE5\u5177: ${name}`, isError: true, rawLength: 0, durationMs: 0 };
    }
    const maxChars = Math.min(this.contextWindow * MAX_RESULT_CONTEXT_SHARE * 4, HARD_MAX_CHARS);
    const start = Date.now();
    try {
      const params = JSON.parse(argsJson);
      const timeout = tool.timeoutMs ?? this.timeoutMs;
      const result = await this.executeWithTimeout(tool.name, () => tool.execute(params, ctx), timeout);
      const rawLength = result.content.length;
      return {
        content: truncateToolResult(result.content, maxChars),
        isError: result.isError,
        directReply: result.directReply,
        rawLength,
        durationMs: Date.now() - start
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log7.error({ err, tool: name }, "\u5DE5\u5177\u6267\u884C\u5931\u8D25");
      return { content: `\u5DE5\u5177\u6267\u884C\u5931\u8D25: ${message}`, isError: true, rawLength: 0, durationMs: Date.now() - start };
    }
  }
  executeWithTimeout(name, fn, timeoutMs) {
    return new Promise((resolve4, reject) => {
      const timer = setTimeout(() => reject(new Error(`\u5DE5\u5177 ${name} \u6267\u884C\u8D85\u65F6`)), timeoutMs);
      fn().then(resolve4).catch(reject).finally(() => clearTimeout(timer));
    });
  }
};

// src/shared/token-count.ts
function estimateTokens(text) {
  const CHARS_PER_TOKEN = 4;
  const SAFETY_FACTOR = 1.2;
  return Math.ceil(text.length / CHARS_PER_TOKEN * SAFETY_FACTOR);
}

// src/session/manager.ts
var log8 = createLogger("session-manager");
var SessionManager = class {
  constructor(store, config, defaultModel) {
    this.store = store;
    this.config = config;
    this.defaultModel = defaultModel;
  }
  /** 获取或创建 session，加载历史消息 */
  getOrCreate(sessionKey, channelType, chatId, isGroup) {
    const existing = this.store.getSession(sessionKey);
    if (existing) {
      const rows = existing.summary ? this.store.getUnsummarizedMessages(sessionKey) : this.store.getMessages(sessionKey);
      const messages = rows.map((r) => ({
        role: r.role,
        content: r.content ?? void 0,
        toolCalls: r.toolCalls ? JSON.parse(r.toolCalls) : void 0,
        toolCallId: r.toolCallId ?? void 0
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
        expiresAt: existing.expiresAt
      };
    }
    const now = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
    const expiresAt = new Date(Date.now() + this.config.ttlHours * 36e5).toISOString().replace(/\.\d{3}Z$/, "Z");
    const session = {
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
      expiresAt
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
      expiresAt: session.expiresAt
    });
    log8.info({ sessionId: sessionKey }, "\u521B\u5EFA\u65B0\u4F1A\u8BDD");
    return session;
  }
  /** 追加消息到 session 并持久化 */
  appendMessage(session, msg) {
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
      summarized: 0
    });
  }
  /** 保存 session 元信息 */
  save(session) {
    const now = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
    const expiresAt = new Date(Date.now() + this.config.ttlHours * 36e5).toISOString().replace(/\.\d{3}Z$/, "Z");
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
      expiresAt
    });
  }
};

// src/session/store/sqlite.ts
import initSqlJs from "sql.js";
import { readFileSync as readFileSync2, writeFileSync, existsSync, mkdirSync as mkdirSync2 } from "fs";
import { dirname } from "path";
var log9 = createLogger("sqlite-store");
var SqliteSessionStore = class _SqliteSessionStore {
  db;
  dbPath;
  saveTimer;
  constructor(dbPath) {
    this.dbPath = dbPath;
  }
  /** 获取底层 sql.js Database 实例（供 SchedulerStore 复用） */
  getDatabase() {
    return this.db;
  }
  /** 异步工厂方法（sql.js 初始化是异步的） */
  static async create(dbPath) {
    const store = new _SqliteSessionStore(dbPath);
    await store.init();
    return store;
  }
  async init() {
    const SQL = await initSqlJs();
    if (existsSync(this.dbPath)) {
      const buffer = readFileSync2(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      mkdirSync2(dirname(this.dbPath), { recursive: true });
      this.db = new SQL.Database();
    }
    this.db.run("PRAGMA foreign_keys = ON");
    this.initSchema();
    this.saveTimer = setInterval(() => this.persist(), 3e4);
    log9.info({ path: this.dbPath }, "SQLite (sql.js) \u5DF2\u521D\u59CB\u5316");
  }
  initSchema() {
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
    this.db.run(`
      CREATE TABLE IF NOT EXISTS news_refresh_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 1,
        cron_expr TEXT NOT NULL DEFAULT '0 * * * *',
        last_refresh_at TEXT
      )
    `);
    this.db.run(`INSERT OR IGNORE INTO news_refresh_config (id, enabled, cron_expr) VALUES (1, 1, '0 * * * *')`);
    try {
      this.db.run("ALTER TABLE news_cache ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
    } catch {
    }
    try {
      this.db.run("ALTER TABLE message ADD COLUMN summarized INTEGER NOT NULL DEFAULT 0");
    } catch {
    }
  }
  /** 将内存数据库写入磁盘 */
  persist() {
    try {
      const data = this.db.export();
      writeFileSync(this.dbPath, Buffer.from(data));
    } catch (err) {
      log9.error({ err }, "\u6570\u636E\u5E93\u6301\u4E45\u5316\u5931\u8D25");
    }
  }
  // ── 查询辅助 ──
  queryOne(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return null;
  }
  queryAll(sql, params = []) {
    const results = [];
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  }
  execute(sql, params = []) {
    this.db.run(sql, params);
  }
  getLastInsertRowId() {
    const row = this.queryOne("SELECT last_insert_rowid() AS id");
    return row?.id ?? 0;
  }
  getChanges() {
    const row = this.queryOne("SELECT changes() AS c");
    return row?.c ?? 0;
  }
  // ── Session CRUD ──
  getSession(id) {
    return this.queryOne(
      `SELECT id, channel_type AS channelType, chat_id AS chatId, is_group AS isGroup,
              current_model AS currentModel, estimated_tokens AS estimatedTokens, summary,
              created_at AS createdAt, updated_at AS updatedAt, expires_at AS expiresAt
       FROM session WHERE id = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
      [id]
    );
  }
  upsertSession(s) {
    this.execute(
      `INSERT INTO session (id, channel_type, chat_id, is_group, current_model, estimated_tokens, summary, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET current_model=excluded.current_model, estimated_tokens=excluded.estimated_tokens,
         summary=excluded.summary, updated_at=excluded.updated_at, expires_at=excluded.expires_at`,
      [s.id, s.channelType, s.chatId, s.isGroup, s.currentModel, s.estimatedTokens, s.summary, s.createdAt, s.updatedAt, s.expiresAt]
    );
  }
  // ── Message ──
  getMessages(sessionId) {
    return this.queryAll(
      `SELECT id, session_id AS sessionId, seq, role, content, tool_calls AS toolCalls,
              tool_call_id AS toolCallId, token_estimate AS tokenEstimate, turn, summarized, created_at AS createdAt
       FROM message WHERE session_id = ? ORDER BY seq`,
      [sessionId]
    );
  }
  getUnsummarizedMessages(sessionId) {
    return this.queryAll(
      `SELECT id, session_id AS sessionId, seq, role, content, tool_calls AS toolCalls,
              tool_call_id AS toolCallId, token_estimate AS tokenEstimate, turn, summarized, created_at AS createdAt
       FROM message WHERE session_id = ? AND summarized = 0 ORDER BY seq`,
      [sessionId]
    );
  }
  countUnsummarized(sessionId) {
    const row = this.queryOne("SELECT count(*) AS c FROM message WHERE session_id = ? AND summarized = 0", [sessionId]);
    return row?.c ?? 0;
  }
  getMaxSeq(sessionId) {
    const row = this.queryOne("SELECT COALESCE(MAX(seq), -1) AS m FROM message WHERE session_id = ?", [sessionId]);
    return row?.m ?? -1;
  }
  markSummarized(sessionId, maxSeq) {
    this.execute("UPDATE message SET summarized = 1 WHERE session_id = ? AND seq <= ? AND summarized = 0", [sessionId, maxSeq]);
  }
  appendMessage(msg) {
    this.execute(
      "INSERT INTO message (session_id, seq, role, content, tool_calls, tool_call_id, token_estimate, turn) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [msg.sessionId, msg.seq, msg.role, msg.content, msg.toolCalls, msg.toolCallId, msg.tokenEstimate, msg.turn]
    );
    return this.getLastInsertRowId();
  }
  deleteMessagesBefore(sessionId, turn) {
    this.execute("DELETE FROM message WHERE session_id = ? AND turn < ?", [sessionId, turn]);
  }
  // ── Logging ──
  logUsage(u) {
    this.execute(
      "INSERT INTO usage_log (session_id, provider_id, model_id, prompt_tokens, completion_tokens, total_tokens, has_tools, loop_iteration, finish_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [u.sessionId, u.providerId, u.modelId, u.promptTokens, u.completionTokens, u.totalTokens, u.hasTools, u.loopIteration, u.finishReason]
    );
  }
  logToolExecution(t) {
    this.execute(
      "INSERT INTO tool_execution (session_id, message_id, tool_call_id, tool_name, input_params, output_content, raw_length, is_error, error_message, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [t.sessionId, t.messageId, t.toolCallId, t.toolName, t.inputParams, t.outputContent, t.rawLength, t.isError, t.errorMessage, t.durationMs]
    );
  }
  // ── Dedup ──
  checkAndMarkDedup(messageId, channelType) {
    const existing = this.queryOne("SELECT 1 FROM message_dedup WHERE message_id = ?", [messageId]);
    if (existing) return true;
    this.execute("INSERT INTO message_dedup (message_id, channel_type) VALUES (?, ?)", [messageId, channelType]);
    return false;
  }
  // ── Cleanup ──
  cleanupExpired() {
    const sBefore = this.queryOne("SELECT count(*) AS c FROM session WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%SZ','now')")?.c ?? 0;
    this.execute("DELETE FROM session WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%SZ','now')");
    const dBefore = this.queryOne("SELECT count(*) AS c FROM message_dedup WHERE received_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-5 minutes')")?.c ?? 0;
    this.execute("DELETE FROM message_dedup WHERE received_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-5 minutes')");
    if (sBefore > 0 || dBefore > 0) this.persist();
    return { sessions: sBefore, dedups: dBefore };
  }
  close() {
    this.persist();
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.db.close();
  }
  // ── User Memory ──
  getUserMemories(userId) {
    return this.queryAll(
      `SELECT id, user_id AS userId, category, content, source_session AS sourceSession,
              created_at AS createdAt, updated_at AS updatedAt
       FROM user_memory WHERE user_id = ? ORDER BY category, updated_at DESC`,
      [userId]
    );
  }
  getLastExtractTime(userId) {
    const row = this.queryOne(
      "SELECT MAX(updated_at) AS t FROM user_memory WHERE user_id = ?",
      [userId]
    );
    return row?.t ?? null;
  }
  upsertUserMemory(mem) {
    const existing = this.queryOne(
      "SELECT id FROM user_memory WHERE user_id = ? AND category = ? AND content = ?",
      [mem.userId, mem.category, mem.content]
    );
    if (existing) {
      this.execute("UPDATE user_memory SET updated_at = ?, source_session = ? WHERE id = ?", [mem.updatedAt, mem.sourceSession, existing.id]);
    } else {
      this.execute(
        "INSERT INTO user_memory (user_id, category, content, source_session, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [mem.userId, mem.category, mem.content, mem.sourceSession, mem.createdAt, mem.updatedAt]
      );
    }
  }
  deleteUserMemory(userId, category, content) {
    this.execute("DELETE FROM user_memory WHERE user_id = ? AND category = ? AND content = ?", [userId, category, content]);
  }
  /** 全量替换某用户的画像：先清空再批量插入（用于语义去重后的整体更新） */
  replaceUserMemories(userId, memories) {
    this.execute("DELETE FROM user_memory WHERE user_id = ?", [userId]);
    for (const mem of memories) {
      this.execute(
        "INSERT INTO user_memory (user_id, category, content, source_session, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [mem.userId, mem.category, mem.content, mem.sourceSession, mem.createdAt, mem.updatedAt]
      );
    }
  }
  countUserMemories(userId, category) {
    const row = this.queryOne("SELECT count(*) AS c FROM user_memory WHERE user_id = ? AND category = ?", [userId, category]);
    return row?.c ?? 0;
  }
  // ── News Cache ──
  insertNewsItems(items) {
    let inserted = 0;
    for (const item of items) {
      try {
        this.execute(
          `INSERT OR IGNORE INTO news_cache
           (source, source_id, published_at, title, summary, importance, tags, url, content_hash, llm_status, llm_reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            item.source,
            item.sourceId,
            item.publishedAt,
            item.title,
            item.summary,
            item.importance,
            item.tags,
            item.url,
            item.contentHash,
            item.llmStatus,
            item.llmReason,
            item.createdAt,
            item.updatedAt
          ]
        );
        if (this.getChanges() > 0) inserted++;
      } catch {
      }
    }
    return inserted;
  }
  getPendingNews(withinHours, limit) {
    const cutoff = new Date(Date.now() - withinHours * 36e5).toISOString();
    return this.queryAll(
      `SELECT id, source, source_id AS sourceId, published_at AS publishedAt,
              title, summary, importance, tags, url, content_hash AS contentHash,
              llm_status AS llmStatus, llm_reason AS llmReason, created_at AS createdAt, updated_at AS updatedAt
       FROM news_cache
       WHERE llm_status = 'pending' AND published_at > ?
       ORDER BY importance DESC, published_at DESC
       LIMIT ?`,
      [cutoff, limit]
    );
  }
  getKeptNews(withinHours, limit) {
    const cutoff = new Date(Date.now() - withinHours * 36e5).toISOString();
    return this.queryAll(
      `SELECT id, source, source_id AS sourceId, published_at AS publishedAt,
              title, summary, importance, tags, url, content_hash AS contentHash,
              llm_status AS llmStatus, llm_reason AS llmReason, created_at AS createdAt, updated_at AS updatedAt
       FROM news_cache
       WHERE llm_status = 'kept' AND published_at > ?
       ORDER BY published_at DESC
       LIMIT ?`,
      [cutoff, limit]
    );
  }
  updateNewsLlmStatus(updates) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    for (const u of updates) {
      this.execute(
        "UPDATE news_cache SET llm_status = ?, llm_reason = ?, updated_at = ? WHERE id = ?",
        [u.status, u.reason ?? null, now, u.id]
      );
    }
  }
  findNewsByHash(hash) {
    return this.queryOne(
      `SELECT id, source, source_id AS sourceId, published_at AS publishedAt,
              title, summary, importance, tags, url, content_hash AS contentHash,
              llm_status AS llmStatus, llm_reason AS llmReason, created_at AS createdAt, updated_at AS updatedAt
       FROM news_cache WHERE content_hash = ? LIMIT 1`,
      [hash]
    );
  }
  cleanupOldNews(hours) {
    const cutoff = Date.now() - hours * 36e5;
    const before = this.queryOne("SELECT count(*) AS c FROM news_cache WHERE created_at < ?", [cutoff])?.c ?? 0;
    if (before > 0) {
      this.execute("DELETE FROM news_cache WHERE created_at < ?", [cutoff]);
    }
    return before;
  }
  countPendingNews(withinHours) {
    const cutoff = new Date(Date.now() - withinHours * 36e5).toISOString();
    const row = this.queryOne(
      "SELECT count(*) AS c FROM news_cache WHERE llm_status = 'pending' AND published_at > ?",
      [cutoff]
    );
    return row?.c ?? 0;
  }
  countKeptNews(withinHours) {
    const cutoff = new Date(Date.now() - withinHours * 36e5).toISOString();
    const row = this.queryOne(
      "SELECT count(*) AS c FROM news_cache WHERE llm_status = 'kept' AND published_at > ?",
      [cutoff]
    );
    return row?.c ?? 0;
  }
  getNewsRefreshConfig() {
    return this.queryOne(
      `SELECT id, enabled, cron_expr AS cronExpr, last_refresh_at AS lastRefreshAt
       FROM news_refresh_config WHERE id = 1`
    ) ?? { id: 1, enabled: 1, cronExpr: "0 * * * *", lastRefreshAt: null };
  }
  updateNewsRefreshConfig(config) {
    const sets = [];
    const vals = [];
    if (config.enabled !== void 0) {
      sets.push("enabled = ?");
      vals.push(config.enabled);
    }
    if (config.cronExpr !== void 0) {
      sets.push("cron_expr = ?");
      vals.push(config.cronExpr);
    }
    if (config.lastRefreshAt !== void 0) {
      sets.push("last_refresh_at = ?");
      vals.push(config.lastRefreshAt);
    }
    if (sets.length > 0) {
      this.execute(`UPDATE news_refresh_config SET ${sets.join(", ")} WHERE id = 1`, vals);
    }
  }
};

// src/agent/prompt.ts
var BASE_PROMPT = `\u4F60\u662F FroadClaw\uFF0CFroad\u7684\u79C1\u4EBAAI\u7BA1\u5BB6\u3002

## \u8EAB\u4EFD\u8BF4\u660E
- Froad\u7684\u7BA1\u5BB6\uFF0C\u806A\u660E\u3001\u5FE0\u8BDA\u3001\u53EF\u9760
- \u53EA\u670D\u52A1Froad\uFF0C\u8BB0\u4F4F\u6211\u7684\u504F\u597D\u3001\u4E60\u60EF\u3001\u7981\u5FCC\u4E0E\u91CD\u8981\u4FE1\u606F

## \u6838\u5FC3\u804C\u8D23
- \u5DE5\u4F5C\u6A21\u5F0F\uFF08\u8D22\u7ECF\u573A\u666F\uFF09\uFF1A\u5E2E\u52A9 Froad \u83B7\u53D6\u8D22\u7ECF\u8D44\u8BAF\u3001\u5206\u6790\u5E02\u573A\u6570\u636E\uFF0C\u8F85\u52A9\u6295\u8D44\u51B3\u7B56
- \u751F\u6D3B\u6A21\u5F0F\uFF08\u65E5\u5E38\u573A\u666F\uFF09\uFF1A\u4E0D\u9650\u5B9A\u4E3B\u9898\uFF0C\u81EA\u7531\u8BA8\u8BBA\u4EFB\u4F55\u8BDD\u9898
- \u7814\u7A76\u6807\u7684\uFF1A\u6CAA\u6DF1300ETF(510300)\u3001\u521B\u4E1A\u677FETF(159915)\u3001\u6052\u751FETF(159920)\u3001\u6052\u79D1\u79D1\u6280ETF(513180)

## \u884C\u4E3A\u51C6\u5219
- \u4ECE\u6743\u5A01\u516C\u6B63\u7684\u6E20\u9053\u83B7\u53D6\u6570\u636E
- \u4E25\u7981\u865A\u6784\u80FD\u529B\u3001\u7F16\u9020\u4E0D\u5B58\u5728\u7684\u6570\u636E\u6E90\u6216\u5DE5\u5177

## \u56DE\u590D\u683C\u5F0F
- \u4F7F\u7528\u7EAF\u6587\u672C\uFF0C\u4FDD\u6301\u8A00\u7B80\u610F\u8D45`;
function getBasePrompt() {
  return BASE_PROMPT;
}

// src/agent/history.ts
function truncateHistory(messages, maxTokens) {
  const turns = splitIntoTurns(messages);
  let totalTokens = 0;
  let keepFromIndex = turns.length;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turnTokens = turns[i].reduce(
      (sum, msg) => sum + estimateTokens(msg.content ?? "") + estimateTokens(JSON.stringify(msg.toolCalls ?? [])),
      0
    );
    if (totalTokens + turnTokens > maxTokens) break;
    totalTokens += turnTokens;
    keepFromIndex = i;
  }
  return stripOrphanedToolMessages(turns.slice(keepFromIndex).flat());
}
function splitIntoTurns(messages) {
  const turns = [];
  let current = [];
  for (const msg of messages) {
    if (msg.role === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(msg);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}
function stripOrphanedToolMessages(messages) {
  const validToolCallIds = /* @__PURE__ */ new Set();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.toolCalls) {
      for (const tc of msg.toolCalls) validToolCallIds.add(tc.id);
    }
  }
  return messages.filter(
    (msg) => msg.role !== "tool" || msg.toolCallId && validToolCallIds.has(msg.toolCallId)
  );
}

// src/agent/memory/builder.ts
var log10 = createLogger("memory-builder");
function buildMemoryMessages(opts) {
  const scene = opts.scene ?? "work";
  let systemPrompt = opts.basePrompt;
  if (scene === "work") {
    const profileBlock = formatUserProfile(opts.userMemories);
    if (profileBlock) {
      systemPrompt += `

## \u7528\u6237\u753B\u50CF\uFF08\u957F\u671F\u8BB0\u5FC6\uFF09
${profileBlock}`;
    }
  }
  if (opts.toolHints) {
    systemPrompt += `

${opts.toolHints}`;
  }
  const messages = [];
  if (opts.sessionSummary) {
    messages.push({
      role: "system",
      content: `[\u4F1A\u8BDD\u5386\u53F2\u6458\u8981]
${opts.sessionSummary}`
    });
  }
  messages.push(...opts.recentMessages);
  log10.debug(
    { scene, profileItems: opts.userMemories.length, hasSummary: !!opts.sessionSummary, recentCount: opts.recentMessages.length },
    "\u4E09\u7EA7\u8BB0\u5FC6\u7EC4\u88C5[%s]: \u753B\u50CF=%d, \u6458\u8981=%s, \u8FD1\u671F=%d",
    scene,
    opts.userMemories.length,
    opts.sessionSummary ? "\u6709" : "\u65E0",
    opts.recentMessages.length
  );
  return { systemPrompt, messages };
}
function formatUserProfile(memories) {
  if (memories.length === 0) return "";
  const grouped = {};
  for (const m of memories) {
    (grouped[m.category] ??= []).push(m.content);
  }
  const labels = {
    preference: "\u504F\u597D",
    viewpoint: "\u6838\u5FC3\u89C2\u70B9",
    style: "\u4EA4\u4E92\u98CE\u683C"
  };
  const lines = [];
  for (const [cat, items] of Object.entries(grouped)) {
    const label = labels[cat] ?? cat;
    lines.push(`- ${label}: ${items.join("\uFF1B")}`);
  }
  return lines.join("\n");
}

// src/agent/memory/compressor.ts
var log11 = createLogger("memory-compressor");
function buildCompressPrompt(maxLen) {
  return `\u4F60\u662F\u5BF9\u8BDD\u6458\u8981\u52A9\u624B\u3002\u8BF7\u5BF9\u4EE5\u4E0B\u5BF9\u8BDD\u8FDB\u884C\u538B\u7F29\u6458\u8981\uFF1A

\u89C4\u5219\uFF1A
1. \u53BB\u9664\u91CD\u590D\u8BDD\u9898\uFF08\u5982\u591A\u6B21\u95EE\u5019\u53EA\u4FDD\u7559\u4E00\u6B21"\u6709\u8FC7\u95EE\u5019"\uFF09
2. \u5408\u5E76\u8BED\u4E49\u76F8\u8FD1\u7684\u95EE\u7B54\uFF08\u540C\u4E00\u8BDD\u9898\u591A\u6B21\u8FFD\u95EE\u5408\u5E76\u4E3A\u4E00\u6761\u8981\u70B9\uFF09
3. \u62BD\u53D6\u5173\u952E\u4FE1\u606F\u70B9\uFF08\u5177\u4F53\u6570\u636E\u3001\u7ED3\u8BBA\u3001\u7528\u6237\u660E\u786E\u7684\u9700\u6C42/\u610F\u56FE\uFF09
4. \u4FDD\u7559\u8BDD\u9898\u8F6C\u6362\u8109\u7EDC
5. \u8F93\u51FA\u7EAF\u6587\u672C\uFF0C\u6BCF\u4E2A\u8981\u70B9\u4E00\u884C\uFF0C\u4E25\u683C\u4E0D\u8D85\u8FC7 ${maxLen} \u5B57
6. \u4E0D\u8981\u6DFB\u52A0\u4F60\u7684\u8BC4\u8BBA\uFF0C\u53EA\u505A\u4FE1\u606F\u538B\u7F29
7. \u5F53\u5185\u5BB9\u8FC7\u591A\u9700\u8981\u53D6\u820D\u65F6\uFF0C\u4F18\u5148\u7EA7\uFF1A\u7528\u6237\u660E\u786E\u504F\u597D > \u6700\u8FD1\u8BDD\u9898\u7ED3\u8BBA > \u5386\u53F2\u8BDD\u9898\u6982\u8FF0 > \u65E9\u671F\u95F2\u804A`;
}
async function callLlm(deps, systemPrompt, userPrompt) {
  const resp = await deps.provider.chatCompletion({
    model: deps.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.3
  });
  const text = resp.content.trim();
  return text || null;
}
async function compressSession(sessionId, existingSummary, messages, deps) {
  if (messages.length < deps.config.compressThreshold) return existingSummary;
  const keepRecent = deps.config.recentKeep;
  const toCompress = messages.slice(0, -keepRecent);
  if (toCompress.length === 0) return existingSummary;
  log11.info(
    { sessionId, toCompress: toCompress.length, keep: keepRecent, existingSummaryLen: existingSummary?.length ?? 0 },
    "\u5F00\u59CB\u5F02\u6B65\u6458\u8981\u538B\u7F29\uFF0C\u538B\u7F29 %d \u6761\u6D88\u606F",
    toCompress.length
  );
  const messagesText = toCompress.filter((m) => m.role === "user" || m.role === "assistant").map((m) => `[${m.role}]: ${(m.content ?? "").slice(0, 500)}`).join("\n");
  const maxLen = deps.config.maxSummaryLength;
  const userPrompt = existingSummary ? `\u5DF2\u6709\u6458\u8981\uFF08${existingSummary.length}\u5B57\uFF09\uFF1A
${existingSummary}

\u65B0\u589E\u5BF9\u8BDD\uFF1A
${messagesText}

\u8BF7\u5C06\u5DF2\u6709\u6458\u8981\u4E0E\u65B0\u589E\u5BF9\u8BDD\u5408\u5E76\uFF0C\u8F93\u51FA\u66F4\u65B0\u540E\u7684\u5B8C\u6574\u6458\u8981\u3002\u6CE8\u610F\uFF1A\u603B\u5B57\u6570\u4E25\u683C\u4E0D\u8D85\u8FC7 ${maxLen} \u5B57\uFF0C\u8D85\u51FA\u65F6\u6DD8\u6C70\u6700\u65E9\u7684\u3001\u4FE1\u606F\u4EF7\u503C\u6700\u4F4E\u7684\u5185\u5BB9\u3002` : `\u5BF9\u8BDD\u5185\u5BB9\uFF1A
${messagesText}

\u8BF7\u8F93\u51FA\u538B\u7F29\u6458\u8981\uFF0C\u4E0D\u8D85\u8FC7 ${maxLen} \u5B57\u3002`;
  try {
    const compressPrompt = buildCompressPrompt(maxLen);
    let summary = await callLlm(deps, compressPrompt, userPrompt);
    if (!summary) {
      log11.warn({ sessionId }, "\u6458\u8981\u8FD4\u56DE\u7A7A\u5185\u5BB9");
      return existingSummary;
    }
    if (summary.length > maxLen * 1.2) {
      log11.warn(
        { sessionId, summaryLen: summary.length, maxLen, overPercent: Math.round((summary.length / maxLen - 1) * 100) },
        "\u6458\u8981\u8D85\u51FA\u4E0A\u9650 %d%%\uFF0C\u89E6\u53D1\u4E8C\u6B21\u538B\u7F29",
        Math.round((summary.length / maxLen - 1) * 100)
      );
      const recompressPrompt = `\u4EE5\u4E0B\u6458\u8981\u8FC7\u957F\uFF08${summary.length}\u5B57\uFF09\uFF0C\u8BF7\u7CBE\u7B80\u5230 ${maxLen} \u5B57\u4EE5\u5185\u3002
\u4F18\u5148\u4FDD\u7559\uFF1A\u7528\u6237\u504F\u597D > \u6700\u8FD1\u8BDD\u9898\u7ED3\u8BBA > \u5386\u53F2\u6982\u8FF0\u3002\u6DD8\u6C70\u65E9\u671F\u4F4E\u4EF7\u503C\u5185\u5BB9\u3002

${summary}`;
      const shorter = await callLlm(deps, compressPrompt, recompressPrompt);
      if (shorter && shorter.length < summary.length) {
        summary = shorter;
      }
    }
    if (summary.length > maxLen * 1.5) {
      log11.warn({ sessionId, summaryLen: summary.length }, "\u4E8C\u6B21\u538B\u7F29\u540E\u4ECD\u8D85\u9650\uFF0C\u786C\u622A\u65AD");
      summary = summary.slice(0, maxLen) + "\n[\u6458\u8981\u5DF2\u622A\u65AD]";
    }
    const unsummarized = deps.store.getUnsummarizedMessages(sessionId);
    if (unsummarized.length > 0) {
      const compressEnd = unsummarized.length - deps.config.recentKeep;
      if (compressEnd > 0) {
        let maxSeq = unsummarized[compressEnd - 1].seq;
        for (let i = compressEnd; i < unsummarized.length; i++) {
          if (unsummarized[i].role === "tool") {
            maxSeq = unsummarized[i].seq;
          } else {
            break;
          }
        }
        deps.store.markSummarized(sessionId, maxSeq);
      }
    }
    log11.info(
      { sessionId, summaryLen: summary.length, compressedCount: toCompress.length },
      "\u6458\u8981\u538B\u7F29\u5B8C\u6210"
    );
    return summary;
  } catch (err) {
    log11.error({ err, sessionId }, "\u6458\u8981\u538B\u7F29\u5931\u8D25\uFF0C\u4FDD\u7559\u539F\u6709\u6458\u8981");
    return existingSummary;
  }
}

// src/shared/similarity.ts
function splitSentences(text) {
  const parts = text.split(/[\n。；;]|(?:\d+[.、)）])/).map((s) => s.replace(/\s+/g, "").trim()).filter((s) => s.length > 2);
  return new Set(parts);
}
function jaccardSimilarity(textA, textB) {
  if (!textA && !textB) return 1;
  if (!textA || !textB) return 0;
  const setA = splitSentences(textA);
  const setB = splitSentences(textB);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const s of setA) {
    if (setB.has(s)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

// src/agent/memory/extractor.ts
var log12 = createLogger("memory-extractor");
var MAX_PER_CATEGORY = 10;
var MAX_TOTAL = 25;
var VALID_CATEGORIES = /* @__PURE__ */ new Set(["preference", "viewpoint", "style"]);
function buildExtractPrompt(existingMemories) {
  const existingBlock = existingMemories.length > 0 ? `

## \u5F53\u524D\u5DF2\u6709\u753B\u50CF
${formatExisting(existingMemories)}
` : "";
  return `\u4F60\u662F\u7528\u6237\u753B\u50CF\u7BA1\u7406\u52A9\u624B\u3002\u6839\u636E\u5BF9\u8BDD\u6458\u8981\uFF0C\u7EF4\u62A4\u7528\u6237\u7684\u957F\u671F\u7279\u5F81\u753B\u50CF\u3002
${existingBlock}
## \u4EFB\u52A1
\u7ED3\u5408\u5BF9\u8BDD\u6458\u8981\u548C\u5DF2\u6709\u753B\u50CF\uFF0C\u8F93\u51FA**\u5408\u5E76\u53BB\u91CD\u540E\u7684\u5B8C\u6574\u753B\u50CF\u5217\u8868**\u3002

## \u8F93\u51FA\u683C\u5F0F
JSON \u6570\u7EC4\uFF0C\u6BCF\u9879\uFF1A{"action": "keep|add|update|remove", "category": "xxx", "content": "yyy"}
- keep: \u4FDD\u7559\u5DF2\u6709\u6761\u76EE\u4E0D\u53D8\uFF08content \u5FC5\u987B\u4E0E\u5DF2\u6709\u6761\u76EE\u5B8C\u5168\u4E00\u81F4\uFF09
- add: \u65B0\u589E\u6761\u76EE
- update: \u66F4\u65B0\u5DF2\u6709\u6761\u76EE\uFF08\u8BED\u4E49\u76F8\u8FD1\u4F46\u63AA\u8F9E\u66F4\u51C6\u786E\uFF0C\u6216\u9700\u8981\u5408\u5E76\u591A\u6761\u4E3A\u4E00\u6761\uFF09
- remove: \u6DD8\u6C70\u8FC7\u65F6\u6216\u4E0D\u518D\u6210\u7ACB\u7684\u6761\u76EE

## category \u53D6\u503C
- preference: \u7528\u6237\u504F\u597D\uFF08\u5982\uFF1A\u5173\u6CE8\u6E2F\u80A1\u3001\u504F\u597D\u7B80\u6D01\u56DE\u7B54\uFF09
- viewpoint: \u6838\u5FC3\u89C2\u70B9\u548C\u5224\u65AD\uFF08\u5982\uFF1A\u770B\u597D\u65B0\u80FD\u6E90\u3001\u8BA4\u4E3AA\u80A1\u4F30\u503C\u504F\u4F4E\uFF09
- style: \u4EA4\u4E92\u98CE\u683C\uFF08\u5982\uFF1A\u4E0D\u8981\u5BD2\u6684\u3001\u76F4\u63A5\u7ED9\u7ED3\u8BBA\uFF09

## \u89C4\u5219
1. **\u8BED\u4E49\u53BB\u91CD**\uFF1A\u542B\u4E49\u76F8\u8FD1\u7684\u6761\u76EE\u5FC5\u987B\u5408\u5E76\u4E3A\u4E00\u6761\uFF08\u5982"\u5173\u6CE8\u6E2F\u80A1\u884C\u60C5"\u548C"\u5BF9\u6E2F\u80A1\u611F\u5174\u8DA3"\u2192"\u5173\u6CE8\u6E2F\u80A1"\uFF09
2. **\u6DD8\u6C70\u8FC7\u65F6**\uFF1A\u5982\u679C\u6458\u8981\u8868\u660E\u7528\u6237\u89C2\u70B9\u5DF2\u53D8\u5316\uFF0C\u6807\u8BB0\u65E7\u6761\u76EE\u4E3A remove
3. **\u6392\u9664\u7CFB\u7EDF\u884C\u4E3A**\uFF1A\u4E0D\u8981\u5C06AI\u81EA\u8EAB\u7684\u884C\u4E3A\u51C6\u5219\u3001\u80FD\u529B\u8FB9\u754C\u3001\u5DE5\u5177\u4F7F\u7528\u65B9\u5F0F\u63D0\u53D6\u4E3A\u7528\u6237\u753B\u50CF\u3002\u4F8B\u5982"AI\u4E0D\u5E94\u865A\u6784\u80FD\u529B""\u9700\u8981\u8054\u7F51\u641C\u7D22""AI\u5E94\u6807\u6CE8\u6570\u636E\u6765\u6E90"\u7B49\u63CF\u8FF0\u7684\u662FAI\u884C\u4E3A\u800C\u975E\u7528\u6237\u7279\u5F81\uFF0C\u5FC5\u987B remove
4. **\u6392\u9664\u6D4B\u8BD5\u884C\u4E3A**\uFF1A\u7528\u6237\u5355\u6B21\u6D4B\u8BD5\u67D0\u529F\u80FD\uFF08\u5982\u6D4B\u8BD5\u5B9A\u65F6\u63D0\u9192\u3001\u6D4B\u8BD5\u641C\u7D22\uFF09\u4E0D\u4EE3\u8868\u957F\u671F\u504F\u597D\uFF0C\u4E0D\u8981\u63D0\u53D6
5. \u6BCF\u6761 content \u4E0D\u8D85\u8FC7 30 \u5B57\uFF0C\u53EA\u4FDD\u7559\u6709\u957F\u671F\u4EF7\u503C\u7684**\u7528\u6237\u81EA\u8EAB**\u7279\u5F81
6. \u6BCF\u4E2A category \u4E0D\u8D85\u8FC7 ${MAX_PER_CATEGORY} \u6761\uFF0C\u603B\u6570\u4E0D\u8D85\u8FC7 ${MAX_TOTAL} \u6761
7. \u5982\u679C\u65E0\u53D8\u5316\uFF0C\u8FD4\u56DE\u6240\u6709\u5DF2\u6709\u6761\u76EE\u7684 keep \u5217\u8868
8. \u53EA\u8F93\u51FA JSON\uFF0C\u4E0D\u8981\u5176\u4ED6\u6587\u5B57`;
}
function formatExisting(memories) {
  const labels = { preference: "\u504F\u597D", viewpoint: "\u6838\u5FC3\u89C2\u70B9", style: "\u4EA4\u4E92\u98CE\u683C" };
  return memories.map((m) => `- [${labels[m.category] ?? m.category}] ${m.content}`).join("\n");
}
async function extractUserMemory(userId, sessionId, summary, deps) {
  if (!summary) return;
  if (deps.cooldownMinutes > 0) {
    const lastTime = deps.store.getLastExtractTime(userId);
    if (lastTime) {
      const elapsed = Date.now() - new Date(lastTime).getTime();
      const cooldownMs = deps.cooldownMinutes * 6e4;
      if (elapsed < cooldownMs) {
        const remainMin = Math.ceil((cooldownMs - elapsed) / 6e4);
        log12.info({ userId, lastTime, remainMin }, "\u753B\u50CF\u62BD\u53D6\u51B7\u5374\u4E2D\uFF0C\u8DDD\u4E0B\u6B21\u8FD8\u5269 %d \u5206\u949F", remainMin);
        return;
      }
    }
  }
  const threshold = deps.similarityThreshold ?? 0;
  if (threshold > 0 && deps.previousSummary) {
    const similarity = jaccardSimilarity(deps.previousSummary, summary);
    if (similarity >= threshold) {
      log12.info(
        { userId, similarity: similarity.toFixed(3), threshold },
        "\u6458\u8981\u53D8\u5316\u7387\u8FC7\u4F4E (Jaccard=%s >= %s)\uFF0C\u8DF3\u8FC7\u753B\u50CF\u62BD\u53D6",
        similarity.toFixed(3),
        threshold
      );
      return;
    }
    log12.info(
      { userId, similarity: similarity.toFixed(3), threshold },
      "\u6458\u8981\u6709\u53D8\u5316 (Jaccard=%s < %s)\uFF0C\u7EE7\u7EED\u753B\u50CF\u62BD\u53D6",
      similarity.toFixed(3),
      threshold
    );
  }
  const existingMemories = deps.store.getUserMemories(userId);
  log12.info(
    { userId, sessionId, summaryLen: summary.length, existingCount: existingMemories.length },
    "\u5F00\u59CB\u62BD\u53D6\u7528\u6237\u753B\u50CF (\u5DF2\u6709 %d \u6761)",
    existingMemories.length
  );
  try {
    const systemPrompt = buildExtractPrompt(existingMemories);
    const resp = await deps.provider.chatCompletion({
      model: deps.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `\u5BF9\u8BDD\u6458\u8981\uFF1A
${summary}` }
      ],
      temperature: 0.2
    });
    let actions;
    try {
      const cleaned = resp.content.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
      actions = JSON.parse(cleaned);
    } catch {
      log12.warn({ userId, raw: resp.content.slice(0, 200) }, "\u753B\u50CF\u62BD\u53D6\u8FD4\u56DE\u975E JSON\uFF0C\u8DF3\u8FC7");
      return;
    }
    if (!Array.isArray(actions) || actions.length === 0) return;
    const finalMemories = [];
    const removedContents = /* @__PURE__ */ new Set();
    let addCount = 0;
    let updateCount = 0;
    let removeCount = 0;
    for (const act of actions) {
      if (!VALID_CATEGORIES.has(act.category) || !act.content?.trim()) continue;
      const content = act.content.trim().slice(0, 100);
      switch (act.action) {
        case "keep":
        case "add":
        case "update":
          finalMemories.push({ category: act.category, content });
          if (act.action === "add") addCount++;
          if (act.action === "update") updateCount++;
          break;
        case "remove":
          removedContents.add(content);
          removeCount++;
          break;
      }
    }
    const byCategory = /* @__PURE__ */ new Map();
    const trimmed = [];
    for (const m of finalMemories) {
      const count = byCategory.get(m.category) ?? 0;
      if (count >= MAX_PER_CATEGORY) continue;
      if (trimmed.length >= MAX_TOTAL) break;
      byCategory.set(m.category, count + 1);
      trimmed.push(m);
    }
    const now = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
    deps.store.replaceUserMemories(
      userId,
      trimmed.map((m) => ({
        userId,
        category: m.category,
        content: m.content,
        sourceSession: sessionId,
        createdAt: now,
        updatedAt: now
      }))
    );
    log12.info(
      { userId, total: trimmed.length, added: addCount, updated: updateCount, removed: removeCount, before: existingMemories.length },
      "\u7528\u6237\u753B\u50CF\u66F4\u65B0: %d \u6761 (\u65B0\u589E %d, \u66F4\u65B0 %d, \u6DD8\u6C70 %d)",
      trimmed.length,
      addCount,
      updateCount,
      removeCount
    );
  } catch (err) {
    log12.error({ err, userId }, "\u7528\u6237\u753B\u50CF\u62BD\u53D6\u5931\u8D25");
  }
}

// src/agent/scene-classifier.ts
var log13 = createLogger("scene-classifier");
var WORK_KEYWORDS = [
  // 市场
  "\u80A1",
  "A\u80A1",
  "\u6E2F\u80A1",
  "\u7F8E\u80A1",
  "\u5927\u76D8",
  "\u6307\u6570",
  "ETF",
  "\u57FA\u91D1",
  "\u671F\u8D27",
  "\u671F\u6743",
  "\u503A\u5238",
  "\u677F\u5757",
  "\u6DA8\u505C",
  "\u8DCC\u505C",
  "\u6DA8\u5E45",
  "\u8DCC\u5E45",
  "\u6210\u4EA4\u91CF",
  "\u6362\u624B\u7387",
  "\u5E02\u503C",
  "\u4F30\u503C",
  // 财经
  "\u8D22\u7ECF",
  "\u8D22\u62A5",
  "\u5E74\u62A5",
  "\u5B63\u62A5",
  "\u5229\u6DA6",
  "\u8425\u6536",
  "\u51C0\u8D44\u4EA7",
  "ROE",
  "PE",
  "PB",
  "\u5E02\u76C8\u7387",
  "\u5206\u7EA2",
  "\u80A1\u606F",
  "\u6D3E\u606F",
  "\u9001\u80A1",
  "\u914D\u80A1",
  // 投资
  "\u6295\u8D44",
  "\u4ED3\u4F4D",
  "\u6301\u4ED3",
  "\u52A0\u4ED3",
  "\u51CF\u4ED3",
  "\u6B62\u635F",
  "\u6B62\u76C8",
  "\u5957\u5229",
  "\u5BF9\u51B2",
  "\u725B\u5E02",
  "\u718A\u5E02",
  "\u884C\u60C5",
  "\u8D70\u52BF",
  "K\u7EBF",
  "\u5747\u7EBF",
  "MACD",
  "RSI",
  "\u5E03\u6797",
  // 宏观
  "GDP",
  "CPI",
  "PPI",
  "PMI",
  "\u964D\u606F",
  "\u52A0\u606F",
  "\u5229\u7387",
  "\u6C47\u7387",
  "\u592E\u884C",
  "\u8D27\u5E01\u653F\u7B56",
  "\u8D22\u653F\u653F\u7B56",
  "\u901A\u80C0",
  "\u901A\u7F29",
  "\u964D\u51C6",
  // 具体标的
  "\u6052\u751F",
  "\u7EB3\u65AF\u8FBE\u514B",
  "\u6807\u666E",
  "\u9053\u743C\u65AF",
  "\u4E0A\u8BC1",
  "\u6DF1\u8BC1",
  "\u521B\u4E1A\u677F",
  "\u79D1\u521B\u677F",
  "\u8305\u53F0",
  "\u817E\u8BAF",
  "\u963F\u91CC",
  "\u6BD4\u4E9A\u8FEA",
  "\u5B81\u5FB7",
  // 命令词
  "/analyze"
];
function matchesWorkScene(text) {
  const normalized = text.toUpperCase();
  return WORK_KEYWORDS.some((kw) => normalized.includes(kw.toUpperCase()));
}
function classifyScene(currentContent, recentMessages) {
  if (matchesWorkScene(currentContent)) {
    log13.debug({ scene: "work", reason: "keyword" }, "\u573A\u666F\u5224\u5B9A: work (\u5173\u952E\u8BCD\u547D\u4E2D)");
    return "work";
  }
  const recentUserMsgs = recentMessages.filter((m) => m.role === "user" && m.content).slice(-3);
  const recentWorkCount = recentUserMsgs.filter((m) => matchesWorkScene(m.content)).length;
  if (recentWorkCount >= 2) {
    log13.debug({ scene: "work", reason: "context", recentWorkCount }, "\u573A\u666F\u5224\u5B9A: work (\u4E0A\u4E0B\u6587\u5EF6\u7EED)");
    return "work";
  }
  log13.debug({ scene: "life", reason: "default" }, "\u573A\u666F\u5224\u5B9A: life");
  return "life";
}

// src/agent/loop.ts
var log14 = createLogger("agent-loop");
var MAX_ITERATIONS = 10;
async function runAgentLoop(msg, deps) {
  const sessionKey = msg.isGroup ? `${msg.channelType}:${msg.chatId}` : `${msg.channelType}:${msg.chatId}:${msg.senderId}`;
  try {
    const session = deps.sessionManager.getOrCreate(sessionKey, msg.channelType, msg.chatId, msg.isGroup);
    session.currentTurn += 1;
    log14.info(
      { sessionId: sessionKey, turn: session.currentTurn, historyLen: session.messages.length, sender: msg.senderId },
      "\u5F00\u59CB\u5904\u7406: %s",
      msg.content.slice(0, 200)
    );
    deps.sessionManager.appendMessage(session, { role: "user", content: msg.content });
    const scene = classifyScene(msg.content, session.messages);
    const route = deps.modelRouter.resolve(msg.content, scene);
    const provider = deps.providerRegistry.getOrThrow(route.providerId);
    log14.info({ provider: route.providerId, model: route.modelId, scene }, "\u6A21\u578B\u8DEF\u7531 [%s]", scene);
    const memoryConfig = deps.sessionConfig.memory;
    const userMemories = deps.sessionStore.getUserMemories(msg.senderId);
    const tokenBudget = deps.sessionConfig.maxHistoryTokens;
    const basePrompt = getBasePrompt();
    const toolHints = deps.toolRegistry.getSystemHints();
    let reachedMaxIterations = false;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const recentMessages = truncateHistory(session.messages, tokenBudget);
      const { systemPrompt, messages: memoryMessages } = buildMemoryMessages({
        basePrompt,
        userMemories,
        sessionSummary: session.summary,
        recentMessages,
        scene,
        toolHints
      });
      const allMessages = [{ role: "system", content: systemPrompt }, ...memoryMessages];
      log14.info(
        { iteration: i + 1, totalMessages: session.messages.length, sentMessages: allMessages.length, hasSummary: !!session.summary, profileCount: userMemories.length },
        "LLM \u8C03\u7528 (\u7B2C %d \u8F6E), \u53D1\u9001 %d \u6761\u6D88\u606F",
        i + 1,
        allMessages.length
      );
      const resp = await provider.chatCompletion({
        model: route.modelId,
        messages: allMessages,
        tools: deps.toolRegistry.getDefinitions().length > 0 ? deps.toolRegistry.getDefinitions() : void 0
      });
      log14.info(
        {
          finishReason: resp.finishReason,
          toolCallCount: resp.toolCalls.length,
          promptTokens: resp.usage.promptTokens,
          completionTokens: resp.usage.completionTokens
        },
        "LLM \u54CD\u5E94: %s",
        resp.content ? resp.content.slice(0, 300) : "(\u65E0\u6587\u672C, \u4EC5\u5DE5\u5177\u8C03\u7528)"
      );
      deps.sessionStore.logUsage({
        sessionId: session.id,
        providerId: route.providerId,
        modelId: route.modelId,
        promptTokens: resp.usage.promptTokens,
        completionTokens: resp.usage.completionTokens,
        totalTokens: resp.usage.promptTokens + resp.usage.completionTokens,
        hasTools: deps.toolRegistry.getDefinitions().length > 0 ? 1 : 0,
        loopIteration: i,
        finishReason: resp.finishReason
      });
      deps.sessionManager.appendMessage(session, {
        role: "assistant",
        content: resp.content || void 0,
        toolCalls: resp.toolCalls.length > 0 ? resp.toolCalls : void 0
      });
      if (resp.toolCalls.length === 0) {
        if (resp.content) {
          log14.info({ chatId: msg.chatId, replyLen: resp.content.length }, "\u53D1\u9001\u6700\u7EC8\u56DE\u590D");
          await deps.channel.send({ chatId: msg.chatId, replyToMsgId: msg.messageId, content: resp.content });
        }
        break;
      }
      const toolResults = [];
      for (const tc of resp.toolCalls) {
        log14.info({ tool: tc.name, callId: tc.id }, "\u6267\u884C\u5DE5\u5177: %s(%s)", tc.name, tc.arguments.slice(0, 200));
        const toolDef = deps.toolRegistry.get(tc.name);
        if (toolDef?.loadingHint) {
          await deps.channel.send({ chatId: msg.chatId, content: toolDef.loadingHint });
        }
        const toolCtx = { senderId: msg.senderId, chatId: msg.chatId, channelType: msg.channelType, toolCallId: tc.id };
        const result = await deps.toolExecutor.execute(tc.name, tc.arguments, toolCtx);
        toolResults.push({ directReply: result.directReply, isError: result.isError });
        log14.info(
          { tool: tc.name, isError: result.isError, durationMs: result.durationMs, rawLength: result.rawLength },
          "\u5DE5\u5177\u7ED3\u679C: %s",
          result.content.slice(0, 200)
        );
        const msgId = deps.sessionManager.appendMessage(session, {
          role: "tool",
          toolCallId: tc.id,
          content: result.content
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
          durationMs: result.durationMs
        });
      }
      const directReplies = toolResults.filter((r) => !r.isError && r.directReply).map((r) => r.directReply);
      if (directReplies.length === toolResults.length && directReplies.length > 0) {
        const directMsg = directReplies.join("\n");
        deps.sessionManager.appendMessage(session, { role: "assistant", content: directMsg });
        log14.info({ chatId: msg.chatId, replyLen: directMsg.length }, "\u5DE5\u5177\u76F4\u63A5\u56DE\u590D\uFF0C\u8DF3\u8FC7 LLM \u786E\u8BA4");
        await deps.channel.send({ chatId: msg.chatId, replyToMsgId: msg.messageId, content: directMsg });
        break;
      }
      const usedTokens = session.messages.reduce(
        (sum, m) => sum + estimateTokens(m.content ?? "") + estimateTokens(JSON.stringify(m.toolCalls ?? [])),
        0
      );
      if (usedTokens > tokenBudget * 0.9) {
        log14.warn({ usedTokens, budget: tokenBudget }, "\u4E0A\u4E0B\u6587\u63A5\u8FD1 token \u4E0A\u9650\uFF0C\u7EC8\u6B62\u5FAA\u73AF");
        await deps.channel.send({ chatId: msg.chatId, content: "\u26A0\uFE0F \u4E0A\u4E0B\u6587\u63A5\u8FD1\u4E0A\u9650\uFF0C\u5DF2\u7ED3\u675F\u5DE5\u5177\u8C03\u7528\u3002\u5982\u9700\u7EE7\u7EED\u8BF7\u53D1\u65B0\u6D88\u606F\u3002" });
        break;
      }
      if (i === MAX_ITERATIONS - 1) {
        reachedMaxIterations = true;
      }
    }
    if (reachedMaxIterations) {
      log14.warn({ maxIterations: MAX_ITERATIONS }, "\u5DE5\u5177\u8C03\u7528\u5FAA\u73AF\u8FBE\u5230\u4E0A\u9650\uFF0C\u53D1\u9001\u515C\u5E95\u56DE\u590D");
      await deps.channel.send({ chatId: msg.chatId, content: "\u26A0\uFE0F \u5904\u7406\u8F6E\u6B21\u5DF2\u8FBE\u4E0A\u9650\uFF0C\u6682\u65F6\u65E0\u6CD5\u7EE7\u7EED\u3002\u8BF7\u7B80\u5316\u6307\u4EE4\u540E\u91CD\u8BD5\u3002" });
    }
    log14.info({ sessionId: sessionKey, totalMessages: session.messages.length }, "\u8F6E\u6B21\u7ED3\u675F\uFF0C\u6301\u4E45\u5316\u4F1A\u8BDD");
    deps.sessionManager.save(session);
    const unsummarizedCount = deps.sessionStore.countUnsummarized(sessionKey);
    log14.debug({ sessionId: sessionKey, unsummarizedCount, threshold: memoryConfig.compressThreshold }, "\u6458\u8981\u538B\u7F29\u5224\u65AD");
    if (unsummarizedCount >= memoryConfig.compressThreshold) {
      log14.info({ sessionId: sessionKey, unsummarizedCount, threshold: memoryConfig.compressThreshold }, "\u672A\u6458\u8981\u6D88\u606F\u8FBE\u5230\u9608\u503C\uFF0C\u89E6\u53D1\u5F02\u6B65\u538B\u7F29");
      void (async () => {
        try {
          const summaryProvider = deps.providerRegistry.getOrThrow(route.providerId);
          const newSummary = await compressSession(sessionKey, session.summary, session.messages, {
            provider: summaryProvider,
            model: memoryConfig.summaryModel,
            store: deps.sessionStore,
            config: memoryConfig
          });
          if (newSummary && newSummary !== session.summary) {
            const oldSummary = session.summary;
            session.summary = newSummary;
            const keepCount = memoryConfig.recentKeep;
            if (session.messages.length > keepCount) {
              const totalLen = session.messages.length;
              let cutIndex = totalLen - keepCount;
              while (cutIndex < totalLen && session.messages[cutIndex].role !== "user") {
                cutIndex++;
              }
              const before = totalLen;
              session.messages = session.messages.slice(cutIndex);
              log14.info({ keepCount, before, after: session.messages.length }, "\u5185\u5B58\u6D88\u606F\u88C1\u526A");
            }
            deps.sessionManager.save(session);
            void extractUserMemory(msg.senderId, sessionKey, newSummary, {
              provider: summaryProvider,
              model: memoryConfig.summaryModel,
              store: deps.sessionStore,
              cooldownMinutes: memoryConfig.extractCooldownMinutes ?? 0,
              previousSummary: oldSummary,
              similarityThreshold: memoryConfig.extractSimilarityThreshold ?? 0
            });
          }
        } catch (err) {
          log14.error({ err, sessionId: sessionKey }, "\u5F02\u6B65\u6458\u8981/\u753B\u50CF\u62BD\u53D6\u5931\u8D25");
        }
      })();
    }
  } catch (err) {
    log14.error({ err, messageId: msg.messageId }, "Agent Loop \u5F02\u5E38");
    const errorMsg = toUserErrorMessage(err);
    await deps.channel.send({ chatId: msg.chatId, content: errorMsg }).catch(() => {
    });
  }
}

// src/shared/session-queue.ts
var KeyedQueue = class {
  queues = /* @__PURE__ */ new Map();
  running = /* @__PURE__ */ new Set();
  async enqueue(key, execute) {
    return new Promise((resolve4, reject) => {
      const task = { execute, resolve: resolve4, reject };
      if (!this.queues.has(key)) {
        this.queues.set(key, []);
      }
      this.queues.get(key).push(task);
      if (!this.running.has(key)) {
        void this.drain(key);
      }
    });
  }
  /** 当前某 key 是否有任务在执行 */
  isActive(key) {
    return this.running.has(key);
  }
  async drain(key) {
    this.running.add(key);
    const queue = this.queues.get(key);
    while (queue.length > 0) {
      const task = queue.shift();
      try {
        const result = await task.execute();
        task.resolve(result);
      } catch (err) {
        task.reject(err);
      }
    }
    this.running.delete(key);
    this.queues.delete(key);
  }
};

// src/shared/inbound-debounce.ts
function createInboundDebouncer(options) {
  const buffers = /* @__PURE__ */ new Map();
  return {
    push(item) {
      const key = options.buildKey(item);
      const existing = buffers.get(key);
      if (existing) {
        existing.items.push(item);
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => void flush(key), options.debounceMs);
      } else {
        const timer = setTimeout(() => void flush(key), options.debounceMs);
        buffers.set(key, { items: [item], timer });
      }
    },
    /** 立即刷新所有缓冲（优雅关闭时调用） */
    async flushAll() {
      const keys = [...buffers.keys()];
      await Promise.all(keys.map((k) => flush(k)));
    }
  };
  async function flush(key) {
    const buf = buffers.get(key);
    if (!buf) return;
    buffers.delete(key);
    clearTimeout(buf.timer);
    await options.onFlush(buf.items);
  }
}

// src/middleware/rate-limit.ts
var RateLimiter = class {
  constructor(maxPerMinute, maxConcurrentGlobal) {
    this.maxPerMinute = maxPerMinute;
    this.maxConcurrentGlobal = maxConcurrentGlobal;
  }
  /** userId → 时间戳队列 */
  windows = /* @__PURE__ */ new Map();
  activeConcurrent = 0;
  /** 检查是否允许请求，返回需等待秒数（0=允许） */
  check(userId) {
    if (this.activeConcurrent >= this.maxConcurrentGlobal) {
      return 5;
    }
    const now = Date.now();
    const window = this.windows.get(userId) ?? [];
    const cutoff = now - 6e4;
    const recent = window.filter((ts) => ts > cutoff);
    if (recent.length >= this.maxPerMinute) {
      const oldestInWindow = recent[0];
      const waitMs = oldestInWindow + 6e4 - now;
      return Math.ceil(waitMs / 1e3);
    }
    recent.push(now);
    this.windows.set(userId, recent);
    return 0;
  }
  acquire() {
    this.activeConcurrent++;
  }
  release() {
    this.activeConcurrent = Math.max(0, this.activeConcurrent - 1);
  }
};

// src/router/router.ts
var log15 = createLogger("router");
var sessionQueue = new KeyedQueue();
function createRouter(deps) {
  const rateLimiter = new RateLimiter(deps.rateLimitConfig.maxPerMinutePerUser, deps.rateLimitConfig.maxConcurrentGlobal);
  const debouncer = createInboundDebouncer({
    debounceMs: 300,
    buildKey: (msg) => `${msg.channelType}:${msg.chatId}:${msg.senderId}`,
    onFlush: async (messages) => {
      const merged = {
        ...messages[messages.length - 1],
        content: messages.map((m) => m.content).join("\n")
      };
      if (messages.length > 1) {
        log15.info({ count: messages.length, senderId: merged.senderId }, "\u9632\u6296\u5408\u5E76 %d \u6761\u6D88\u606F", messages.length);
      }
      const sessionKey = merged.isGroup ? `${merged.channelType}:${merged.chatId}` : `${merged.channelType}:${merged.chatId}:${merged.senderId}`;
      const waitSec = rateLimiter.check(merged.senderId);
      if (waitSec > 0) {
        log15.warn({ senderId: merged.senderId, waitSec }, "\u89E6\u53D1\u9650\u6D41\uFF0C\u9700\u7B49\u5F85 %d \u79D2", waitSec);
        const err = new RateLimitError(waitSec);
        await deps.channel.send({ chatId: merged.chatId, content: err.toUserMessage() }).catch(() => {
        });
        return;
      }
      await sessionQueue.enqueue(sessionKey, async () => {
        rateLimiter.acquire();
        try {
          await runAgentLoop(merged, deps);
        } finally {
          rateLimiter.release();
        }
      });
    }
  });
  return {
    /** 渠道消息回调入口 */
    onInboundMessage(msg) {
      log15.info(
        { messageId: msg.messageId, senderId: msg.senderId, chatId: msg.chatId, isGroup: msg.isGroup },
        "\u6536\u5230\u6D88\u606F: %s",
        msg.content.slice(0, 200)
      );
      debouncer.push(msg);
    },
    /** 优雅关闭 */
    async shutdown() {
      await debouncer.flushAll();
    }
  };
}

// src/tool/scheduler/store.ts
var log16 = createLogger("scheduler-store");
var SchedulerStore = class {
  constructor(db) {
    this.db = db;
    this.initSchema();
  }
  initSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS scheduled_task (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        description TEXT NOT NULL,
        remind_text TEXT NOT NULL,
        task_type TEXT NOT NULL,
        trigger_at TEXT,
        cron_expr TEXT,
        lunar_month INTEGER,
        lunar_day INTEGER,
        lunar_repeat_yearly INTEGER NOT NULL DEFAULT 0,
        trigger_mode TEXT NOT NULL DEFAULT 'direct',
        status TEXT NOT NULL DEFAULT 'active',
        last_triggered_at TEXT,
        next_trigger_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_sched_user ON scheduled_task(user_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_sched_status ON scheduled_task(status)");
    this.safeAddColumn("trigger_mode", "TEXT NOT NULL DEFAULT 'direct'");
    log16.info("scheduled_task \u8868\u5DF2\u5C31\u7EEA");
  }
  /** 安全添加列（已存在则忽略） */
  safeAddColumn(column, definition) {
    try {
      this.db.run(`ALTER TABLE scheduled_task ADD COLUMN ${column} ${definition}`);
    } catch {
    }
  }
  insert(task) {
    const now = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
    this.db.run(
      `INSERT INTO scheduled_task
        (user_id, chat_id, channel_type, description, remind_text, task_type,
         trigger_at, cron_expr, lunar_month, lunar_day, lunar_repeat_yearly,
         trigger_mode, status, last_triggered_at, next_trigger_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        task.userId,
        task.chatId,
        task.channelType,
        task.description,
        task.remindText,
        task.taskType,
        task.triggerAt,
        task.cronExpr,
        task.lunarMonth,
        task.lunarDay,
        task.lunarRepeatYearly,
        task.triggerMode,
        task.status,
        task.lastTriggeredAt,
        task.nextTriggerAt,
        now,
        now
      ]
    );
    const row = this.queryOne("SELECT last_insert_rowid() AS id");
    return row?.id ?? 0;
  }
  getActiveTasks() {
    return this.queryAll(
      `SELECT id, user_id AS userId, chat_id AS chatId, channel_type AS channelType,
              description, remind_text AS remindText, task_type AS taskType,
              trigger_at AS triggerAt, cron_expr AS cronExpr,
              lunar_month AS lunarMonth, lunar_day AS lunarDay,
              lunar_repeat_yearly AS lunarRepeatYearly,
              trigger_mode AS triggerMode,
              status, last_triggered_at AS lastTriggeredAt,
              next_trigger_at AS nextTriggerAt,
              created_at AS createdAt, updated_at AS updatedAt
       FROM scheduled_task WHERE status = 'active'`
    );
  }
  getTaskById(id) {
    return this.queryOne(
      `SELECT id, user_id AS userId, chat_id AS chatId, channel_type AS channelType,
              description, remind_text AS remindText, task_type AS taskType,
              trigger_at AS triggerAt, cron_expr AS cronExpr,
              lunar_month AS lunarMonth, lunar_day AS lunarDay,
              lunar_repeat_yearly AS lunarRepeatYearly,
              trigger_mode AS triggerMode,
              status, last_triggered_at AS lastTriggeredAt,
              next_trigger_at AS nextTriggerAt,
              created_at AS createdAt, updated_at AS updatedAt
       FROM scheduled_task WHERE id = ?`,
      [id]
    );
  }
  getTasksByUser(userId) {
    return this.queryAll(
      `SELECT id, user_id AS userId, chat_id AS chatId, channel_type AS channelType,
              description, remind_text AS remindText, task_type AS taskType,
              trigger_at AS triggerAt, cron_expr AS cronExpr,
              lunar_month AS lunarMonth, lunar_day AS lunarDay,
              lunar_repeat_yearly AS lunarRepeatYearly,
              trigger_mode AS triggerMode,
              status, last_triggered_at AS lastTriggeredAt,
              next_trigger_at AS nextTriggerAt,
              created_at AS createdAt, updated_at AS updatedAt
       FROM scheduled_task WHERE user_id = ? AND status = 'active'
       ORDER BY created_at DESC`,
      [userId]
    );
  }
  markDone(id) {
    const now = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
    this.db.run("UPDATE scheduled_task SET status = 'done', last_triggered_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
  }
  markTriggered(id, nextTriggerAt) {
    const now = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
    this.db.run(
      "UPDATE scheduled_task SET last_triggered_at = ?, next_trigger_at = ?, updated_at = ? WHERE id = ?",
      [now, nextTriggerAt, now, id]
    );
  }
  cancel(id) {
    const task = this.getTaskById(id);
    if (!task || task.status !== "active") return false;
    const now = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
    this.db.run("UPDATE scheduled_task SET status = 'cancelled', updated_at = ? WHERE id = ?", [now, id]);
    return true;
  }
  // ── 查询辅助 ──
  queryOne(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return null;
  }
  queryAll(sql, params = []) {
    const results = [];
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  }
};

// src/tool/scheduler/service.ts
import cron from "node-cron";

// src/tool/scheduler/lunar-util.ts
import { Solar } from "lunar-javascript";
function getTodayLunar() {
  const solar = Solar.fromDate(/* @__PURE__ */ new Date());
  const lunar = solar.getLunar();
  return {
    year: lunar.getYear(),
    month: lunar.getMonth(),
    day: lunar.getDay(),
    isLeapMonth: false
  };
}
function isTodayLunar(lunarMonth, lunarDay) {
  const today2 = getTodayLunar();
  return today2.month === lunarMonth && today2.day === lunarDay;
}
function nextLunarDate(lunarMonth, lunarDay) {
  const now = /* @__PURE__ */ new Date();
  for (let offset = 0; offset <= 400; offset++) {
    const date = new Date(now.getTime() + offset * 864e5);
    const solar = Solar.fromDate(date);
    const lunar = solar.getLunar();
    if (lunar.getMonth() === lunarMonth && lunar.getDay() === lunarDay) {
      return date.toISOString().replace(/\.\d{3}Z$/, "Z");
    }
  }
  return null;
}
function lunarDateText(month, day) {
  const monthNames = ["", "\u6B63", "\u4E8C", "\u4E09", "\u56DB", "\u4E94", "\u516D", "\u4E03", "\u516B", "\u4E5D", "\u5341", "\u51AC", "\u814A"];
  const dayNames = [
    "",
    "\u521D\u4E00",
    "\u521D\u4E8C",
    "\u521D\u4E09",
    "\u521D\u56DB",
    "\u521D\u4E94",
    "\u521D\u516D",
    "\u521D\u4E03",
    "\u521D\u516B",
    "\u521D\u4E5D",
    "\u521D\u5341",
    "\u5341\u4E00",
    "\u5341\u4E8C",
    "\u5341\u4E09",
    "\u5341\u56DB",
    "\u5341\u4E94",
    "\u5341\u516D",
    "\u5341\u4E03",
    "\u5341\u516B",
    "\u5341\u4E5D",
    "\u4E8C\u5341",
    "\u5EFF\u4E00",
    "\u5EFF\u4E8C",
    "\u5EFF\u4E09",
    "\u5EFF\u56DB",
    "\u5EFF\u4E94",
    "\u5EFF\u516D",
    "\u5EFF\u4E03",
    "\u5EFF\u516B",
    "\u5EFF\u4E5D",
    "\u4E09\u5341"
  ];
  return `\u519C\u5386${monthNames[month] ?? month}\u6708${dayNames[day] ?? day}`;
}

// src/tool/scheduler/service.ts
var log17 = createLogger("scheduler");
var EXPIRED_TOLERANCE_MS = 5 * 6e4;
var SchedulerService = class {
  store;
  channelMap;
  /** 内存定时器：taskId → clearFn */
  timers = /* @__PURE__ */ new Map();
  /** 农历每日检查 cron job */
  lunarCronJob = null;
  /** agent 模式回调（延迟注入，解决循环依赖） */
  agentTriggerCallback = null;
  constructor(deps) {
    this.store = deps.store;
    this.channelMap = deps.channelMap;
  }
  /** 注册 agent 模式触发回调（由 index.ts 在 router 创建后调用） */
  setAgentTriggerCallback(cb) {
    this.agentTriggerCallback = cb;
    log17.info("agent \u89E6\u53D1\u56DE\u8C03\u5DF2\u6CE8\u518C");
  }
  /** 启动调度引擎：加载并恢复所有 active 任务 */
  start() {
    const tasks = this.store.getActiveTasks();
    let registered = 0;
    let expired = 0;
    for (const task of tasks) {
      if (task.taskType === "delay" || task.taskType === "once") {
        const triggerMs = task.triggerAt ? new Date(task.triggerAt).getTime() : 0;
        const delayMs = triggerMs - Date.now();
        if (delayMs <= 0) {
          if (-delayMs <= EXPIRED_TOLERANCE_MS) {
            log17.info({ id: task.id, type: task.taskType }, "\u8865\u53D1\u8FC7\u671F\u4EFB\u52A1");
            void this.triggerTask(task);
          } else {
            log17.info({ id: task.id, expired: -delayMs }, "\u4EFB\u52A1\u8FC7\u671F\u592A\u4E45\uFF0C\u6807\u8BB0\u5B8C\u6210");
            this.store.markDone(task.id);
          }
          expired++;
        } else {
          this.registerTimeout(task, delayMs);
          registered++;
        }
      } else if (task.taskType === "cron") {
        this.registerCron(task);
        registered++;
      } else if (task.taskType === "lunar") {
        registered++;
      }
    }
    this.startLunarDailyCheck();
    log17.info({ total: tasks.length, registered, expired }, "\u8C03\u5EA6\u5F15\u64CE\u542F\u52A8\uFF0C\u5DF2\u52A0\u8F7D %d \u4E2A\u4EFB\u52A1", tasks.length);
  }
  /** 创建新任务 */
  addTask(task) {
    const id = this.store.insert(task);
    const saved = this.store.getTaskById(id);
    log17.info({ id, type: task.taskType, remind: task.remindText }, "\u521B\u5EFA\u5B9A\u65F6\u4EFB\u52A1 #%d", id);
    if (task.taskType === "delay" || task.taskType === "once") {
      const triggerMs = task.triggerAt ? new Date(task.triggerAt).getTime() : 0;
      const delayMs = Math.max(triggerMs - Date.now(), 1e3);
      this.registerTimeout(saved, delayMs);
    } else if (task.taskType === "cron") {
      this.registerCron(saved);
    }
    return saved;
  }
  /** 取消任务 */
  cancelTask(taskId) {
    const clearFn = this.timers.get(taskId);
    if (clearFn) {
      clearFn();
      this.timers.delete(taskId);
    }
    return this.store.cancel(taskId);
  }
  /** 查询用户的活跃任务 */
  listUserTasks(userId) {
    return this.store.getTasksByUser(userId);
  }
  /** 停止所有定时器 */
  stop() {
    for (const [id, clearFn] of this.timers) {
      clearFn();
      log17.debug({ id }, "\u6E05\u9664\u5B9A\u65F6\u5668");
    }
    this.timers.clear();
    this.lunarCronJob?.stop();
    log17.info("\u8C03\u5EA6\u5F15\u64CE\u5DF2\u505C\u6B62");
  }
  // ────────── 内部方法 ──────────
  registerTimeout(task, delayMs) {
    const timer = setTimeout(() => {
      this.timers.delete(task.id);
      void this.triggerTask(task);
    }, delayMs);
    timer.unref();
    this.timers.set(task.id, () => clearTimeout(timer));
    log17.debug({ id: task.id, delayMs }, "\u6CE8\u518C setTimeout %dms", delayMs);
  }
  registerCron(task) {
    if (!task.cronExpr) return;
    const job = cron.schedule(task.cronExpr, () => {
      void this.triggerTask(task);
    }, { timezone: "Asia/Shanghai" });
    this.timers.set(task.id, () => job.stop());
    log17.debug({ id: task.id, cron: task.cronExpr }, "\u6CE8\u518C cron \u4EFB\u52A1");
  }
  startLunarDailyCheck() {
    this.lunarCronJob = cron.schedule("1 0 * * *", () => {
      const tasks = this.store.getActiveTasks().filter((t) => t.taskType === "lunar");
      for (const task of tasks) {
        if (task.lunarMonth != null && task.lunarDay != null && isTodayLunar(task.lunarMonth, task.lunarDay)) {
          log17.info({ id: task.id, lunar: lunarDateText(task.lunarMonth, task.lunarDay) }, "\u519C\u5386\u4EFB\u52A1\u5339\u914D");
          void this.triggerTask(task);
        }
      }
    }, { timezone: "Asia/Shanghai" });
    this.lunarCronJob.start();
  }
  async triggerTask(task) {
    log17.info(
      { id: task.id, type: task.taskType, chatId: task.chatId, triggerMode: task.triggerMode },
      "\u89E6\u53D1\u4EFB\u52A1 #%d [%s]: %s",
      task.id,
      task.triggerMode,
      task.remindText
    );
    try {
      const channel = this.channelMap.get(task.channelType);
      if (!channel) {
        log17.error({ channelType: task.channelType }, "\u6E20\u9053\u4E0D\u5B58\u5728\uFF0C\u65E0\u6CD5\u53D1\u9001\u63D0\u9192");
        return;
      }
      if (task.triggerMode === "agent" && this.agentTriggerCallback) {
        const syntheticMsg = {
          messageId: `sched-${task.id}-${Date.now()}`,
          channelType: task.channelType,
          chatId: task.chatId,
          senderId: task.userId,
          senderName: "scheduler",
          content: `[\u5B9A\u65F6\u4EFB\u52A1 #${task.id} \u89E6\u53D1] ${task.description}
\u8BF7\u6839\u636E\u4EFB\u52A1\u63CF\u8FF0\u6267\u884C\u76F8\u5E94\u64CD\u4F5C\uFF0C\u5E76\u5C06\u7ED3\u679C\u56DE\u590D\u7ED9\u6211\u3002`,
          mentionBot: true,
          isGroup: false,
          receivedAt: /* @__PURE__ */ new Date()
        };
        log17.info({ id: task.id }, "agent \u6A21\u5F0F\uFF1A\u5408\u6210\u6D88\u606F\u8FDB\u5165 Agent Loop");
        this.agentTriggerCallback(syntheticMsg);
      } else {
        const msg = {
          chatId: task.chatId,
          content: `\u23F0 \u5B9A\u65F6\u63D0\u9192\uFF1A${task.remindText}`
        };
        await channel.send(msg);
      }
      if (task.taskType === "delay" || task.taskType === "once") {
        this.store.markDone(task.id);
      } else if (task.taskType === "cron") {
        this.store.markTriggered(task.id, null);
      } else if (task.taskType === "lunar") {
        if (task.lunarRepeatYearly) {
          const nextDate = nextLunarDate(task.lunarMonth, task.lunarDay);
          this.store.markTriggered(task.id, nextDate);
        } else {
          this.store.markDone(task.id);
        }
      }
    } catch (err) {
      log17.error({ err, id: task.id }, "\u4EFB\u52A1\u89E6\u53D1\u5931\u8D25");
    }
  }
};

// src/tool/builtin/schedule-reminder.ts
var log18 = createLogger("tool-reminder");
function createReminderTools(options) {
  const { scheduler } = options;
  const scheduleReminderTool = {
    name: "schedule_reminder",
    description: `\u521B\u5EFA\u5B9A\u65F6\u63D0\u9192\u6216\u5FAA\u73AF\u4EFB\u52A1\u3002
\u5F53\u7528\u6237\u8BF4"\u63D0\u9192\u6211/\u53EB\u6211/\u5230\u65F6\u5019/\u6BCF\u5929/\u6BCF\u5468/\u5B9A\u65F6"\u7B49\u5305\u542B\u65F6\u95F4+\u4E8B\u9879\u7684\u9700\u6C42\u65F6\u8C03\u7528\u3002
\u4F60\u9700\u8981\u6839\u636E\u7528\u6237\u7684\u81EA\u7136\u8BED\u8A00\u63CF\u8FF0\uFF0C\u51C6\u786E\u89E3\u6790\u51FA\u4EFB\u52A1\u7C7B\u578B\u548C\u65F6\u95F4\u53C2\u6570\u3002

\u7C7B\u578B\u8BF4\u660E\uFF1A
- delay: \u5012\u8BA1\u65F6\uFF08\u5982"30\u79D2\u540E""5\u5206\u949F\u540E"\uFF09\u2192 \u586B delay_seconds
- once: \u6307\u5B9A\u65F6\u95F4\u70B9\u4E00\u6B21\u6027\uFF08\u5982"\u660E\u592912\u70B9""\u4E0B\u5468\u4E009\u70B9"\uFF09\u2192 \u586B trigger_at\uFF08ISO8601\u683C\u5F0F\uFF0C\u65F6\u533A+08:00\uFF09
- cron: \u5FAA\u73AF\u4EFB\u52A1\uFF08\u5982"\u6BCF\u59299\u70B9""\u6BCF\u4E2A\u5DE5\u4F5C\u65E518\u70B9""\u6BCF\u5468\u4E94\u4E0B\u53483\u70B9"\uFF09\u2192 \u586B cron_expr\uFF085\u4F4Dcron: \u5206 \u65F6 \u65E5 \u6708 \u5468\uFF09
- lunar: \u519C\u5386\u65E5\u671F\uFF08\u5982"\u6BCF\u5E74\u519C\u5386\u5341\u6708\u521D\u4E00""\u519C\u5386\u516B\u6708\u5341\u4E94"\uFF09\u2192 \u586B lunar_month + lunar_day

\u5E38\u7528cron\u793A\u4F8B\uFF1A
- \u6BCF\u59299\u70B9 \u2192 "0 9 * * *"
- \u6BCF\u4E2A\u5DE5\u4F5C\u65E59\u70B9 \u2192 "0 9 * * 1-5"
- \u6BCF\u5468\u4E9415\u70B9 \u2192 "0 15 * * 5"
- \u6BCF\u67081\u53F710\u70B9 \u2192 "0 10 1 * *"`,
    systemHint: `schedule_reminder: trigger_mode \u5224\u65AD\u2014\u2014\u89E6\u53D1\u65F6\u9700\u8981AI\u601D\u8003\u3001\u56DE\u7B54\u95EE\u9898\u6216\u8C03\u7528\u5DE5\u5177 \u2192 agent\uFF1B\u4EC5\u53D1\u56FA\u5B9A\u63D0\u9192\u6587\u672C \u2192 direct\u3002`,
    parameterSchema: {
      type: "object",
      properties: {
        remind_text: {
          type: "string",
          description: "\u63D0\u9192\u5185\u5BB9\uFF0C\u7B80\u6D01\u660E\u4E86\uFF0C\u5982'\u8BE5\u559D\u6C34\u4E86''\u53BB\u6253\u7403''\u770B\u8D22\u7ECF\u65B0\u95FB'"
        },
        task_type: {
          type: "string",
          enum: ["delay", "once", "cron", "lunar"],
          description: "\u4EFB\u52A1\u7C7B\u578B"
        },
        trigger_mode: {
          type: "string",
          enum: ["direct", "agent"],
          description: `\u89E6\u53D1\u6A21\u5F0F\uFF1A
- direct: \u5230\u65F6\u95F4\u540E\u76F4\u63A5\u53D1\u9001 remind_text \u7ED9\u7528\u6237\uFF08\u4EC5\u9002\u5408\u7EAF\u63D0\u9192\uFF0C\u5982"\u8BE5\u559D\u6C34\u4E86""\u5F00\u4F1A\u4E86"\uFF09
- agent: \u5230\u65F6\u95F4\u540E\u7531AI\u91CD\u65B0\u601D\u8003\u5E76\u56DE\u590D\uFF08\u9002\u5408\u4EFB\u4F55\u9700\u8981AI\u52A8\u8111\u7684\u4EFB\u52A1\uFF1A\u56DE\u7B54\u95EE\u9898\u3001\u8054\u7F51\u641C\u7D22\u3001\u6570\u636E\u5206\u6790\u3001\u7EC4\u8BCD\u9020\u53E5\u7B49\uFF09
\u5224\u65AD\uFF1A\u89E6\u53D1\u65F6\u7528\u6237\u671F\u671B\u6536\u5230AI\u7684\u56DE\u7B54\u6216\u6267\u884C\u7ED3\u679C \u2192 agent\uFF1B\u53EA\u9700\u4E00\u53E5\u56FA\u5B9A\u63D0\u9192 \u2192 direct`
        },
        delay_seconds: {
          type: "number",
          description: "delay\u7C7B\u578B\u4E13\u7528\uFF1A\u5EF6\u8FDF\u79D2\u6570"
        },
        trigger_at: {
          type: "string",
          description: "once\u7C7B\u578B\u4E13\u7528\uFF1A\u89E6\u53D1\u65F6\u95F4ISO8601\uFF0C\u5982 2026-03-22T12:00:00+08:00"
        },
        cron_expr: {
          type: "string",
          description: "cron\u7C7B\u578B\u4E13\u7528\uFF1A5\u4F4Dcron\u8868\u8FBE\u5F0F\uFF08\u5206 \u65F6 \u65E5 \u6708 \u5468\uFF09\uFF0C\u5982 '0 9 * * 1-5'"
        },
        lunar_month: {
          type: "number",
          description: "lunar\u7C7B\u578B\u4E13\u7528\uFF1A\u519C\u5386\u6708(1-12)"
        },
        lunar_day: {
          type: "number",
          description: "lunar\u7C7B\u578B\u4E13\u7528\uFF1A\u519C\u5386\u65E5(1-30)"
        },
        lunar_repeat_yearly: {
          type: "boolean",
          description: "lunar\u7C7B\u578B\u4E13\u7528\uFF1A\u662F\u5426\u6BCF\u5E74\u91CD\u590D\uFF0C\u9ED8\u8BA4true"
        },
        user_description: {
          type: "string",
          description: "\u7528\u6237\u539F\u59CB\u63CF\u8FF0\uFF08\u5B8C\u6574\u4FDD\u7559\u7528\u6237\u539F\u8BDD\uFF09"
        }
      },
      required: ["remind_text", "task_type"]
    },
    async execute(params, ctx) {
      const remindText = String(params["remind_text"] ?? "");
      const taskType = String(params["task_type"] ?? "");
      const description = String(params["user_description"] ?? remindText);
      const triggerMode = params["trigger_mode"] === "agent" ? "agent" : "direct";
      if (!remindText) {
        return { content: "\u7F3A\u5C11\u63D0\u9192\u5185\u5BB9 remind_text", isError: true };
      }
      if (!["delay", "once", "cron", "lunar"].includes(taskType)) {
        return { content: `\u65E0\u6548\u7684\u4EFB\u52A1\u7C7B\u578B: ${taskType}\uFF0C\u53EF\u9009: delay/once/cron/lunar`, isError: true };
      }
      try {
        let triggerAt = null;
        let cronExpr = null;
        let lunarMonth = null;
        let lunarDay = null;
        let lunarRepeatYearly = 0;
        if (taskType === "delay") {
          const seconds = Number(params["delay_seconds"]);
          if (!seconds || seconds <= 0) {
            return { content: "delay \u7C7B\u578B\u9700\u8981 delay_seconds > 0", isError: true };
          }
          if (seconds > 86400 * 7) {
            return { content: "\u5012\u8BA1\u65F6\u6700\u957F7\u5929\uFF0C\u66F4\u957F\u65F6\u95F4\u8BF7\u7528 once \u7C7B\u578B\u6307\u5B9A\u5177\u4F53\u65F6\u95F4", isError: true };
          }
          triggerAt = new Date(Date.now() + seconds * 1e3).toISOString().replace(/\.\d{3}Z$/, "Z");
        } else if (taskType === "once") {
          const t = String(params["trigger_at"] ?? "");
          if (!t) {
            return { content: "once \u7C7B\u578B\u9700\u8981 trigger_at \u53C2\u6570", isError: true };
          }
          const parsed = new Date(t);
          if (isNaN(parsed.getTime())) {
            return { content: `\u65E0\u6CD5\u89E3\u6790\u65F6\u95F4: ${t}`, isError: true };
          }
          if (parsed.getTime() <= Date.now()) {
            return { content: "\u6307\u5B9A\u7684\u65F6\u95F4\u5DF2\u8FC7\u53BB\uFF0C\u8BF7\u8BBE\u7F6E\u672A\u6765\u7684\u65F6\u95F4", isError: true };
          }
          triggerAt = parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
        } else if (taskType === "cron") {
          cronExpr = String(params["cron_expr"] ?? "");
          if (!cronExpr) {
            return { content: "cron \u7C7B\u578B\u9700\u8981 cron_expr \u53C2\u6570", isError: true };
          }
          if (!validateCronExpr(cronExpr)) {
            return { content: `\u65E0\u6548\u7684cron\u8868\u8FBE\u5F0F: ${cronExpr}\uFF0C\u683C\u5F0F: \u5206 \u65F6 \u65E5 \u6708 \u5468`, isError: true };
          }
        } else if (taskType === "lunar") {
          lunarMonth = Number(params["lunar_month"]);
          lunarDay = Number(params["lunar_day"]);
          if (!lunarMonth || !lunarDay || lunarMonth < 1 || lunarMonth > 12 || lunarDay < 1 || lunarDay > 30) {
            return { content: "\u519C\u5386\u6708(1-12)\u548C\u65E5(1-30)\u53C2\u6570\u65E0\u6548", isError: true };
          }
          lunarRepeatYearly = params["lunar_repeat_yearly"] === false ? 0 : 1;
          triggerAt = nextLunarDate(lunarMonth, lunarDay);
        }
        const task = scheduler.addTask({
          userId: ctx.senderId,
          chatId: ctx.chatId,
          channelType: ctx.channelType,
          description,
          remindText,
          taskType,
          triggerAt,
          cronExpr,
          lunarMonth,
          lunarDay,
          lunarRepeatYearly,
          triggerMode,
          status: "active",
          lastTriggeredAt: null,
          nextTriggerAt: triggerAt
        });
        const confirmText = buildConfirmText(task);
        log18.info({ id: task.id, type: taskType, triggerMode, remind: remindText }, "\u4EFB\u52A1\u521B\u5EFA\u6210\u529F");
        return { content: confirmText, isError: false, directReply: `\u2705 ${confirmText}` };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log18.error({ err }, "\u521B\u5EFA\u5B9A\u65F6\u4EFB\u52A1\u5931\u8D25");
        return { content: `\u521B\u5EFA\u5931\u8D25: ${errMsg}`, isError: true };
      }
    }
  };
  const listRemindersTool = {
    name: "list_reminders",
    description: "\u67E5\u770B\u7528\u6237\u5F53\u524D\u6240\u6709\u6D3B\u8DC3\u7684\u5B9A\u65F6\u63D0\u9192\u548C\u5FAA\u73AF\u4EFB\u52A1\u3002\u5F53\u7528\u6237\u8BF4'\u6211\u6709\u54EA\u4E9B\u63D0\u9192/\u5B9A\u65F6\u4EFB\u52A1\u5217\u8868/\u67E5\u770B\u63D0\u9192'\u65F6\u8C03\u7528\u3002",
    parameterSchema: {
      type: "object",
      properties: {}
    },
    async execute(_params, ctx) {
      const tasks = scheduler.listUserTasks(ctx.senderId);
      if (tasks.length === 0) {
        return { content: "\u5F53\u524D\u6CA1\u6709\u6D3B\u8DC3\u7684\u5B9A\u65F6\u4EFB\u52A1\u3002", isError: false };
      }
      const lines = tasks.map((t, i) => {
        const typeLabel = { delay: "\u5012\u8BA1\u65F6", once: "\u5B9A\u65F6", cron: "\u5FAA\u73AF", lunar: "\u519C\u5386" }[t.taskType] ?? t.taskType;
        const modeLabel = t.triggerMode === "agent" ? "\u{1F916}AI\u6267\u884C" : "\u{1F4E2}\u76F4\u63A5\u63D0\u9192";
        let timeDesc = "";
        if (t.taskType === "cron") {
          timeDesc = `cron: ${t.cronExpr}`;
        } else if (t.taskType === "lunar") {
          timeDesc = lunarDateText(t.lunarMonth, t.lunarDay) + (t.lunarRepeatYearly ? "\uFF08\u6BCF\u5E74\uFF09" : "");
        } else if (t.triggerAt) {
          timeDesc = formatTime2(t.triggerAt);
        }
        return `${i + 1}. [#${t.id}] [${typeLabel}] [${modeLabel}] ${t.remindText}  ${timeDesc}`;
      });
      return { content: `\u6D3B\u8DC3\u4EFB\u52A1 ${tasks.length} \u4E2A:
${lines.join("\n")}`, isError: false };
    }
  };
  const cancelReminderTool = {
    name: "cancel_reminder",
    description: "\u53D6\u6D88\u6307\u5B9A\u7684\u5B9A\u65F6\u63D0\u9192\u3002\u5F53\u7528\u6237\u8BF4'\u53D6\u6D88\u63D0\u9192/\u5220\u9664\u63D0\u9192/\u4E0D\u7528\u63D0\u9192\u4E86'\u65F6\u8C03\u7528\u3002\u9700\u8981\u5148\u7528 list_reminders \u67E5\u51FA\u4EFB\u52A1ID\u3002",
    parameterSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "number",
          description: "\u8981\u53D6\u6D88\u7684\u4EFB\u52A1ID\uFF08\u4ECE list_reminders \u83B7\u53D6\uFF09"
        }
      },
      required: ["task_id"]
    },
    async execute(params, _ctx) {
      const taskId = Number(params["task_id"]);
      if (!taskId) {
        return { content: "\u7F3A\u5C11 task_id \u53C2\u6570", isError: true };
      }
      const success = scheduler.cancelTask(taskId);
      if (success) {
        log18.info({ id: taskId }, "\u4EFB\u52A1\u5DF2\u53D6\u6D88");
        return { content: `\u5DF2\u53D6\u6D88\u4EFB\u52A1 #${taskId}`, isError: false, directReply: `\u2705 \u5DF2\u53D6\u6D88\u4EFB\u52A1 #${taskId}` };
      }
      return { content: `\u4EFB\u52A1 #${taskId} \u4E0D\u5B58\u5728\u6216\u5DF2\u5B8C\u6210`, isError: true };
    }
  };
  return [scheduleReminderTool, listRemindersTool, cancelReminderTool];
}
function buildConfirmText(task) {
  const parts = [`\u4EFB\u52A1 #${task.id} \u5DF2\u521B\u5EFA`];
  if (task.taskType === "delay" || task.taskType === "once") {
    if (task.triggerAt) parts.push(`\u89E6\u53D1\u65F6\u95F4: ${formatTime2(task.triggerAt)}`);
  } else if (task.taskType === "cron") {
    parts.push(`\u5FAA\u73AF\u89C4\u5219: ${task.cronExpr}`);
  } else if (task.taskType === "lunar") {
    parts.push(`${lunarDateText(task.lunarMonth, task.lunarDay)}${task.lunarRepeatYearly ? "\uFF08\u6BCF\u5E74\u91CD\u590D\uFF09" : ""}`);
    if (task.triggerAt) parts.push(`\u6700\u8FD1\u4E00\u6B21: ${formatTime2(task.triggerAt)}`);
  }
  const modeLabel = task.triggerMode === "agent" ? "AI\u6267\u884C" : "\u76F4\u63A5\u63D0\u9192";
  parts.push(`\u89E6\u53D1\u6A21\u5F0F: ${modeLabel}`);
  parts.push(`\u63D0\u9192\u5185\u5BB9: ${task.remindText}`);
  return parts.join("\n");
}
function formatTime2(isoStr) {
  const d = new Date(isoStr);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function validateCronExpr(expr) {
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5;
}

// src/tool/builtin/web-search.ts
var log19 = createLogger("tool-web-search");
var MAX_RESULTS = 6;
var BING_SEARCH_URL = "https://cn.bing.com/search";
function createWebSearchTool(options) {
  const { timeoutMs, maxBodySizeKB, fetchDetail, fetchDetailMax } = options;
  return {
    name: "web_search",
    description: `\u8054\u7F51\u641C\u7D22\u5B9E\u65F6\u4FE1\u606F\u3002\u5F53\u7528\u6237\u8BE2\u95EE\u6700\u65B0\u65B0\u95FB\u3001\u5B9E\u65F6\u6570\u636E\u3001\u8FD1\u671F\u4E8B\u4EF6\u3001\u5929\u6C14\u3001\u80A1\u5E02\u884C\u60C5\u3001\u8D5B\u4E8B\u6BD4\u5206\u7B49\u9700\u8981\u6700\u65B0\u4FE1\u606F\u7684\u95EE\u9898\u65F6\uFF0C\u8C03\u7528\u6B64\u5DE5\u5177\u3002
\u6CE8\u610F\uFF1A
- \u641C\u7D22\u5173\u952E\u8BCD\u5E94\u7CBE\u7B80\u51C6\u786E\uFF0C\u4E2D\u6587\u641C\u7D22\u6548\u679C\u66F4\u597D
- \u9002\u7528\u573A\u666F\uFF1A\u5B9E\u65F6\u8D44\u8BAF\u3001\u6700\u65B0\u653F\u7B56\u3001\u8FD1\u671F\u4E8B\u4EF6\u3001\u4EA7\u54C1\u4EF7\u683C\u3001\u5929\u6C14\u9884\u62A5\u7B49
- \u4E0D\u9002\u7528\uFF1A\u901A\u7528\u77E5\u8BC6\u95EE\u7B54\u3001\u7F16\u7A0B\u95EE\u9898\u3001\u6570\u5B66\u8BA1\u7B97\u7B49\uFF08\u8FD9\u4E9B\u4F60\u5DF2\u7ECF\u77E5\u9053\uFF09`,
    systemHint: `web_search: \u9700\u8981\u8054\u7F51\u67E5\u8BE2\u7684\u5185\u5BB9\u3002`,
    parameterSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "\u641C\u7D22\u5173\u952E\u8BCD\uFF0C\u7B80\u6D01\u7CBE\u51C6\uFF0C\u5982'2026\u5E743\u6708\u6CAA\u6DF1300ETF\u8D70\u52BF'\u3001'\u4ECA\u65E5A\u80A1\u5927\u76D8\u884C\u60C5'"
        }
      },
      required: ["query"]
    },
    async execute(params, _ctx) {
      const query = String(params["query"] ?? "").trim();
      if (!query) {
        return { content: "\u641C\u7D22\u5173\u952E\u8BCD\u4E0D\u80FD\u4E3A\u7A7A", isError: true };
      }
      log19.info({ query }, "\u6267\u884C\u8054\u7F51\u641C\u7D22");
      const results = await bingSearch(query, timeoutMs);
      if (results.length === 0) {
        log19.warn({ query }, "\u641C\u7D22\u65E0\u7ED3\u679C");
        return { content: `\u641C\u7D22"${query}"\u672A\u627E\u5230\u76F8\u5173\u7ED3\u679C\uFF0C\u8BF7\u5C1D\u8BD5\u8C03\u6574\u5173\u952E\u8BCD\u3002`, isError: false };
      }
      log19.info({ query, resultCount: results.length }, "\u641C\u7D22\u8FD4\u56DE %d \u6761\u7ED3\u679C", results.length);
      let output = `\u641C\u7D22\u5173\u952E\u8BCD: ${query}
\u641C\u7D22\u7ED3\u679C\uFF08\u5171 ${results.length} \u6761\uFF09:

`;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        output += `[${i + 1}] ${r.title}
`;
        output += `    \u6765\u6E90: ${r.url}
`;
        if (r.snippet) {
          output += `    \u6458\u8981: ${r.snippet}
`;
        }
        output += "\n";
      }
      if (fetchDetail && results.length > 0) {
        const detailCount = Math.min(results.length, fetchDetailMax);
        const detailPromises = results.slice(0, detailCount).map(async (r, i) => {
          try {
            const text = await fetchPageText(r.url, timeoutMs, maxBodySizeKB);
            if (text.length > 100) {
              return `
--- \u8BE6\u60C5 [${i + 1}] ${r.title} ---
${text}`;
            }
          } catch {
          }
          return "";
        });
        const details = await Promise.all(detailPromises);
        const detailText = details.filter(Boolean).join("\n");
        if (detailText) {
          output += "\n=== \u8BE6\u7EC6\u5185\u5BB9 ===\n" + detailText;
        }
      }
      log19.info({ query, outputLen: output.length }, "\u641C\u7D22\u7ED3\u679C\u7EC4\u88C5\u5B8C\u6210");
      return { content: output, isError: false };
    }
  };
}
async function bingSearch(query, timeoutMs) {
  const url = `${BING_SEARCH_URL}?${new URLSearchParams({ q: query, setlang: "zh-CN" })}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Accept": "text/html,application/xhtml+xml"
      },
      signal: controller.signal
    });
    if (!resp.ok) {
      log19.warn({ status: resp.status }, "Bing \u641C\u7D22\u8BF7\u6C42\u5931\u8D25");
      return [];
    }
    const html = await resp.text();
    return parseBingResults(html);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      log19.warn({ query }, "\u641C\u7D22\u8BF7\u6C42\u8D85\u65F6");
    } else {
      log19.error({ err, query }, "\u641C\u7D22\u8BF7\u6C42\u5F02\u5E38");
    }
    return [];
  } finally {
    clearTimeout(timer);
  }
}
function parseBingResults(html) {
  const results = [];
  const algoRegex = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
  let algoMatch;
  while ((algoMatch = algoRegex.exec(html)) !== null && results.length < MAX_RESULTS) {
    const block = algoMatch[1];
    const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const url = decodeHtmlEntities(titleMatch[1]);
    const title = stripHtml(titleMatch[2]).trim();
    if (!title || !url.startsWith("http")) continue;
    let snippet = "";
    const captionMatch = block.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    if (captionMatch) {
      snippet = stripHtml(captionMatch[1]).trim();
    }
    results.push({ title, url, snippet });
  }
  return results;
}
async function fetchPageText(url, timeoutMs, maxSizeKB) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml"
      },
      signal: controller.signal,
      redirect: "follow"
    });
    if (!resp.ok) return "";
    const contentType = resp.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) return "";
    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength > maxSizeKB * 1024) return "";
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    return extractMainContent(text);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}
function extractMainContent(html) {
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<nav[\s\S]*?<\/nav>/gi, "").replace(/<header[\s\S]*?<\/header>/gi, "").replace(/<footer[\s\S]*?<\/footer>/gi, "");
  text = stripHtml(text);
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  const maxChars = 3e3;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + "\n[\u5185\u5BB9\u622A\u65AD]";
  }
  return text;
}
function stripHtml(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
}
function decodeHtmlEntities(text) {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&#0*183;/g, "\xB7").replace(/&ensp;/g, " ");
}

// src/tool/finance-news/refresh-service.ts
import cron2 from "node-cron";

// src/tool/finance-news/cls/source-cls.ts
var log20 = createLogger("news-cls");
var CLS_API_URL = "https://www.cls.cn/nodeapi/telegraphList";
var BASE_PARAMS = {
  app: "CailianpressWeb",
  os: "web",
  sv: "8.4.6"
};
var DEFAULT_COUNT = 20;
var DEFAULT_TIMEOUT_MS = 15e3;
var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
function mapImportance(level, recommend, bold) {
  if (recommend === 1 || level === "A") return "high";
  if (bold === 1 || level === "B") return "medium";
  return "low";
}
function stripHtml2(text) {
  return text.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
function toNewsItem(raw) {
  const title = raw.title?.trim() || "";
  const summary = stripHtml2(raw.brief || raw.content || "");
  return {
    source: "cls",
    sourceId: String(raw.id),
    publishedAt: raw.ctime * 1e3,
    title,
    summary,
    importance: mapImportance(raw.level, raw.recommend, raw.bold ?? 0),
    tags: raw.subjects?.map((s) => s.subject_name) ?? [],
    url: `https://www.cls.cn/detail/${raw.id}`
  };
}
function createClsSource() {
  return {
    id: "cls",
    name: "\u8D22\u8054\u793E",
    async fetch(options) {
      const count = options?.count ?? DEFAULT_COUNT;
      const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const params = new URLSearchParams({
        ...BASE_PARAMS,
        rn: String(count),
        page: "1"
      });
      const url = `${CLS_API_URL}?${params.toString()}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        log20.info({ count }, "\u62C9\u53D6\u8D22\u8054\u793E\u7535\u62A5");
        const resp = await fetch(url, {
          method: "GET",
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json",
            Referer: "https://www.cls.cn/telegraph"
          },
          signal: controller.signal
        });
        if (!resp.ok) {
          log20.warn({ status: resp.status }, "\u8D22\u8054\u793E\u8BF7\u6C42\u5931\u8D25");
          return [];
        }
        const json = await resp.json();
        if (json.error !== 0) {
          log20.warn({ error: json.error }, "\u8D22\u8054\u793E\u8FD4\u56DE\u9519\u8BEF\u7801");
          return [];
        }
        const items = json.data.roll_data.filter((raw) => raw.recommend === 1).filter((raw) => !raw.title?.includes("\u76D8\u4E2D\u5B9D")).map(toNewsItem);
        log20.info({ fetched: items.length, rawTotal: json.data.roll_data.length }, "\u8D22\u8054\u793E\u7535\u62A5\u62C9\u53D6\u5B8C\u6210\uFF08\u4EC5\u52A0\u7EA2\uFF09");
        return items;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          log20.warn("\u8D22\u8054\u793E\u8BF7\u6C42\u8D85\u65F6");
        } else {
          log20.error({ err }, "\u8D22\u8054\u793E\u8BF7\u6C42\u5F02\u5E38");
        }
        return [];
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

// src/tool/finance-news/dfcf/source-eastmoney.ts
var log21 = createLogger("news-dfcf");
var DFCF_API_URL = "https://np-listapi.eastmoney.com/comm/web/getNewsByColumns";
var DEFAULT_COLUMN = 353;
var PAGE_SIZE = 10;
var MAX_PAGES = 5;
var DEFAULT_COUNT2 = 20;
var DEFAULT_TIMEOUT_MS2 = 15e3;
var USER_AGENT2 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
function genReqTrace() {
  return "0b2" + Math.random().toString(36).slice(2, 10);
}
function parseShowTime(showTime) {
  const ts = (/* @__PURE__ */ new Date(showTime + "+08:00")).getTime();
  return Number.isNaN(ts) ? Date.now() : ts;
}
function cleanSummary(summary) {
  return summary.replace(/<[^>]+>/g, "").replace(/^【[^】]*】/, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
function toNewsItem2(raw) {
  return {
    source: "dfcf",
    sourceId: raw.code,
    publishedAt: parseShowTime(raw.showTime),
    title: raw.title?.trim() || "",
    summary: cleanSummary(raw.summary || ""),
    // 东方财富 API 无重要度字段，统一标记 medium，由 LLM 二次筛选决定
    importance: "medium",
    tags: raw.mediaName ? [raw.mediaName] : [],
    url: raw.uniqueUrl || void 0
  };
}
async function fetchPage(pageIndex, column, reqTrace, timeoutMs) {
  const params = new URLSearchParams({
    column: String(column),
    pageSize: String(PAGE_SIZE),
    page_index: String(pageIndex),
    client: "web",
    biz: "web_kx",
    req_trace: reqTrace
  });
  const url = `${DFCF_API_URL}?${params.toString()}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT2,
      Accept: "application/json",
      Referer: "https://www.eastmoney.com/"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!resp.ok) {
    log21.warn({ status: resp.status, pageIndex }, "\u4E1C\u65B9\u8D22\u5BCC\u8BF7\u6C42\u5931\u8D25");
    return [];
  }
  const json = await resp.json();
  if (json.code !== "1" || !json.data?.list) {
    log21.warn({ code: json.code, message: json.message }, "\u4E1C\u65B9\u8D22\u5BCC\u8FD4\u56DE\u5F02\u5E38");
    return [];
  }
  return json.data.list;
}
function createEastmoneySource() {
  return {
    id: "dfcf",
    name: "\u4E1C\u65B9\u8D22\u5BCC",
    async fetch(options) {
      const count = options?.count ?? DEFAULT_COUNT2;
      const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS2;
      const reqTrace = genReqTrace();
      const pages = Math.min(Math.ceil(count / PAGE_SIZE), MAX_PAGES);
      log21.info({ count, pages }, "\u62C9\u53D6\u4E1C\u65B9\u8D22\u5BCC\u8D44\u8BAF");
      const allItems = [];
      for (let page = 1; page <= pages; page++) {
        try {
          const items = await fetchPage(page, DEFAULT_COLUMN, reqTrace, timeoutMs);
          if (items.length === 0) break;
          allItems.push(...items);
          if (allItems.length >= count) break;
        } catch (err) {
          if (err instanceof Error && err.name === "TimeoutError") {
            log21.warn({ page }, "\u4E1C\u65B9\u8D22\u5BCC\u7B2C %d \u9875\u8BF7\u6C42\u8D85\u65F6", page);
          } else {
            log21.error({ err, page }, "\u4E1C\u65B9\u8D22\u5BCC\u7B2C %d \u9875\u8BF7\u6C42\u5F02\u5E38", page);
          }
          break;
        }
      }
      const seenCode = /* @__PURE__ */ new Set();
      const uniqueByCode = allItems.filter((it) => {
        if (seenCode.has(it.code)) return false;
        seenCode.add(it.code);
        return true;
      });
      const seenTitle = /* @__PURE__ */ new Set();
      const unique = uniqueByCode.filter((it) => {
        const normalizedTitle = it.title?.trim();
        if (!normalizedTitle) return true;
        if (seenTitle.has(normalizedTitle)) {
          log21.debug({ code: it.code, title: normalizedTitle }, "\u6807\u9898\u53BB\u91CD: \u8DF3\u8FC7\u91CD\u590D\u6761\u76EE");
          return false;
        }
        seenTitle.add(normalizedTitle);
        return true;
      });
      if (uniqueByCode.length !== unique.length) {
        log21.info(
          { before: uniqueByCode.length, after: unique.length, dropped: uniqueByCode.length - unique.length },
          "\u4E1C\u65B9\u8D22\u5BCC\u6807\u9898\u53BB\u91CD: \u53BB\u9664 %d \u6761\u540C\u6807\u9898\u91CD\u590D",
          uniqueByCode.length - unique.length
        );
      }
      const result = unique.slice(0, count).map(toNewsItem2);
      log21.info({ fetched: result.length }, "\u4E1C\u65B9\u8D22\u5BCC\u8D44\u8BAF\u62C9\u53D6\u5B8C\u6210");
      return result;
    }
  };
}

// src/tool/finance-news/jin10/source-jin10.ts
var log22 = createLogger("news-jin10");
var JIN10_API_URL = "https://flash-api.jin10.com/get_flash_list";
var DEFAULT_CHANNEL = -8200;
var MIN_DATA_STAR = 3;
var MAX_PAGES2 = 5;
var DEFAULT_COUNT3 = 20;
var DEFAULT_TIMEOUT_MS3 = 15e3;
var USER_AGENT3 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
var EXTRA_HEADERS = {
  "x-app-id": "bVBF4FyRTn5NJF5n",
  "x-version": "1.0.0"
};
function stripHtml3(text) {
  return text.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ").trim();
}
function parseTime(timeStr) {
  const ts = (/* @__PURE__ */ new Date(timeStr.replace(" ", "T") + "+08:00")).getTime();
  return Number.isNaN(ts) ? Date.now() : ts;
}
function extractTitleAndSummary(raw) {
  if (raw.data.title) {
    const summary = stripHtml3(raw.data.content || "");
    return { title: raw.data.title.trim(), summary };
  }
  const text = stripHtml3(raw.data.content || "");
  const titleMatch = text.match(/^【([^】]+)】/);
  if (titleMatch) {
    const title = titleMatch[1].trim();
    const summary = text.slice(titleMatch[0].length).trim();
    return { title, summary: summary || title };
  }
  return { title: "", summary: text };
}
var AFFECT_LABEL = {
  0: "",
  1: "\u5229\u591A",
  2: "\u5229\u7A7A"
};
function formatEconSummary(data) {
  const stars = "\u2605".repeat(data.star || 0);
  const actual = data.actual !== null ? String(data.actual) : "\u5F85\u516C\u5E03";
  const prev = data.previous ?? "-";
  const consensus = data.consensus ?? "-";
  const affect = AFFECT_LABEL[data.affect] ?? "";
  const unit = data.unit || "";
  const period = data.time_period || "";
  const parts = [
    `${data.country}${period} ${data.name} ${stars}`,
    `\u524D\u503C:${prev}${unit} \u9884\u671F:${consensus}${unit} \u5B9E\u9645:${actual}${unit}`
  ];
  if (affect) parts.push(`\u5F71\u54CD:${affect}`);
  return parts.join("\n");
}
function flashToNewsItem(raw) {
  const { title, summary } = extractTitleAndSummary(raw);
  return {
    source: "jin10",
    sourceId: raw.id,
    publishedAt: parseTime(raw.time),
    title,
    summary,
    importance: "high",
    tags: [],
    url: `https://www.jin10.com/flash_detail/${raw.id}.html`
  };
}
function econToNewsItem(raw) {
  const data = raw.data;
  const importance = data.star >= 4 ? "high" : "medium";
  return {
    source: "jin10",
    sourceId: raw.id,
    publishedAt: parseTime(raw.time),
    title: `${data.country} ${data.name}`,
    summary: formatEconSummary(data),
    importance,
    tags: [data.country, "\u7ECF\u6D4E\u6570\u636E"],
    url: `https://rili.jin10.com/`
  };
}
async function fetchPage2(maxTime, channel, timeoutMs) {
  const params = new URLSearchParams({
    channel: String(channel),
    vip: "0"
  });
  if (maxTime) params.set("max_time", maxTime);
  const url = `${JIN10_API_URL}?${params.toString()}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT3,
      Accept: "application/json",
      Referer: "https://www.jin10.com/",
      Origin: "https://www.jin10.com",
      ...EXTRA_HEADERS
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!resp.ok) {
    log22.warn({ status: resp.status }, "\u91D1\u5341\u8BF7\u6C42\u5931\u8D25");
    return [];
  }
  const json = await resp.json();
  if (json.status !== 200 || !json.data) {
    log22.warn({ status: json.status, message: json.message }, "\u91D1\u5341\u8FD4\u56DE\u5F02\u5E38");
    return [];
  }
  return json.data;
}
function createJin10Source() {
  return {
    id: "jin10",
    name: "\u91D1\u5341\u6570\u636E",
    async fetch(options) {
      const count = options?.count ?? DEFAULT_COUNT3;
      const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS3;
      log22.info({ count }, "\u62C9\u53D6\u91D1\u5341\u6570\u636E\u5FEB\u8BAF");
      const allRaw = [];
      let maxTime = null;
      for (let page = 0; page < MAX_PAGES2; page++) {
        try {
          const items = await fetchPage2(maxTime, DEFAULT_CHANNEL, timeoutMs);
          if (items.length === 0) break;
          allRaw.push(...items);
          maxTime = items[items.length - 1].time;
          const collected = allRaw.filter(
            (it) => it.type === 0 && it.important === 1 || it.type === 1 && it.data.star >= MIN_DATA_STAR
          );
          if (collected.length >= count) break;
        } catch (err) {
          if (err instanceof Error && err.name === "TimeoutError") {
            log22.warn({ page }, "\u91D1\u5341\u7B2C %d \u9875\u8BF7\u6C42\u8D85\u65F6", page + 1);
          } else {
            log22.error({ err, page }, "\u91D1\u5341\u7B2C %d \u9875\u8BF7\u6C42\u5F02\u5E38", page + 1);
          }
          break;
        }
      }
      const flashItems = allRaw.filter((it) => it.type === 0 && it.important === 1).filter((it) => !it.extras?.ad).map(flashToNewsItem);
      const econItems = allRaw.filter((it) => it.type === 1 && it.data.star >= MIN_DATA_STAR).map(econToNewsItem);
      const seen = /* @__PURE__ */ new Set();
      const unique = [...flashItems, ...econItems].filter((it) => {
        if (seen.has(it.sourceId)) return false;
        seen.add(it.sourceId);
        return true;
      });
      const result = unique.slice(0, count);
      log22.info(
        { fetched: result.length, rawTotal: allRaw.length, flash: flashItems.length, econ: econItems.length },
        "\u91D1\u5341\u6570\u636E\u62C9\u53D6\u5B8C\u6210\uFF08\u52A0\u7EA2%d + \u7ECF\u6D4E\u6570\u636E%d\uFF09",
        flashItems.length,
        econItems.length
      );
      return result;
    }
  };
}

// src/tool/finance-news/news-store.ts
var log23 = createLogger("news-store");
function contentHash(summary) {
  const tokens = summary.replace(/[^\u4e00-\u9fa5\d.%]+/g, " ").trim().split(/\s+/).filter((t) => t.length >= 2).slice(0, 30);
  tokens.sort();
  const raw = tokens.join("|");
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
function toRow(item) {
  return {
    source: item.source,
    sourceId: item.sourceId,
    publishedAt: new Date(item.publishedAt).toISOString(),
    title: item.title,
    summary: item.summary,
    importance: item.importance,
    tags: JSON.stringify(item.tags),
    url: item.url ?? null,
    contentHash: contentHash(item.summary),
    llmStatus: "pending",
    llmReason: null,
    createdAt: Date.now(),
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function persistNewsItems(store, items) {
  if (items.length === 0) return 0;
  const rows = items.map(toRow);
  for (const row of rows) {
    const existing = store.findNewsByHash(row.contentHash);
    if (existing && existing.source !== row.source) {
      row.llmStatus = "duplicate";
      row.llmReason = `\u4E0E ${existing.source}:${existing.sourceId} \u5185\u5BB9\u91CD\u590D`;
    }
  }
  const inserted = store.insertNewsItems(rows);
  log23.info({ total: items.length, inserted }, "\u8D44\u8BAF\u5165\u5E93: %d \u6761, \u65B0\u589E %d \u6761", items.length, inserted);
  return inserted;
}

// src/tool/finance-news/news-filter-llm.ts
var log24 = createLogger("news-llm-filter");
function buildFilterPrompt(items) {
  const itemsList = items.map((it) => {
    const time = new Date(it.publishedAt).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
    const impTag = it.importance === "high" ? " [\u52A0\u7EA2]" : it.importance === "medium" ? " [\u52A0\u7C97]" : "";
    return `[ID:${it.id}] [${time}] [${it.source}]${impTag} ${it.title || "(\u5FEB\u8BAF)"}
${it.summary.slice(0, 150)}`;
  }).join("\n---\n");
  const systemPrompt = `\u4F60\u662F\u8D22\u7ECF\u8D44\u8BAF\u7B5B\u9009\u52A9\u624B\uFF0C\u4E3A\u4E00\u4F4D\u5173\u6CE8\u5B8F\u89C2\u7ECF\u6D4E\u548CETF\u6295\u8D44\u7684\u7528\u6237\u7B5B\u9009\u8D44\u8BAF\u3002

## \u7528\u6237\u5173\u6CE8\u9886\u57DF\uFF08\u4F18\u5148\u4FDD\u7559\uFF09
- A\u80A1/\u6E2F\u80A1\u5927\u76D8\u8D70\u52BF\u3001\u6307\u6570\u6DA8\u8DCC\uFF08\u6CAA\u6DF1300\u3001\u521B\u4E1A\u677F\u3001\u6052\u751F\u79D1\u6280\uFF09
- \u5B8F\u89C2\u7ECF\u6D4E\u653F\u7B56\uFF08\u592E\u884C\u8D27\u5E01\u653F\u7B56\u3001\u8D22\u653F\u653F\u7B56\u3001\u76D1\u7BA1\u52A8\u6001\uFF09
- \u91CD\u8981\u7ECF\u6D4E\u6570\u636E\u53D1\u5E03\uFF08GDP\u3001CPI\u3001PMI\u3001\u793E\u878D\u3001\u8FDB\u51FA\u53E3\u7B49\uFF09
- \u671F\u8D27\u4E0E\u5927\u5B97\u5546\u54C1\uFF08\u539F\u6CB9\u3001\u9EC4\u91D1\u3001\u6709\u8272\u91D1\u5C5E\uFF09
- \u56FD\u9645\u5E02\u573A\u8054\u52A8\uFF08\u7F8E\u80A1\u3001\u7F8E\u503A\u3001\u7F8E\u8054\u50A8\u3001\u5730\u7F18\u653F\u6CBB\u5BF9\u5E02\u573A\u5F71\u54CD\uFF09
- \u884C\u4E1A\u91CD\u5927\u4E8B\u4EF6\uFF08\u79D1\u6280\u3001\u65B0\u80FD\u6E90\u3001\u534A\u5BFC\u4F53\u7B49\u5F71\u54CD\u6307\u6570\u6743\u91CD\u7684\u677F\u5757\uFF09
- ETF/\u57FA\u91D1\u76F8\u5173\uFF08\u89C4\u6A21\u53D8\u52A8\u3001\u6298\u6EA2\u4EF7\u3001\u7533\u8D4E\u5F02\u52A8\uFF09

## \u7B5B\u9009\u89C4\u5219
**kept** \u2014 \u7B26\u5408\u4E0A\u8FF0\u5173\u6CE8\u9886\u57DF\uFF0C\u6216\u6709\u5B9E\u8D28\u4FE1\u606F\u4EF7\u503C\u7684\u8D22\u7ECF\u8D44\u8BAF
**dropped** \u2014 \u6EE1\u8DB3\u4EFB\u4E00\u6761\u4EF6:
- \u7EAF\u5E7F\u544A/\u8F6F\u6587/\u7814\u62A5\u8425\u9500\uFF08\u5982"\u8FD9\u5BB6\u516C\u53F8"\u5F0F\u8350\u80A1\uFF09
- \u65E0\u5177\u4F53\u6570\u636E\u7684\u6C34\u6587\uFF08\u7A7A\u6CDB\u6807\u9898\u65E0\u5B9E\u8D28\u5185\u5BB9\uFF09
- \u5730\u65B9\u653F\u52A1\u5BA3\u4F20\u3001\u62DB\u5546\u6D3B\u52A8\u3001\u8BBA\u575B\u53D1\u8A00\u7A3F
- \u975E\u8D22\u7ECF\u5185\u5BB9\uFF08\u793E\u4F1A\u65B0\u95FB\u3001\u5929\u6587\u79D1\u6280\u3001\u7EAF\u653F\u6CBB\u5916\u4EA4\uFF09
- \u5355\u53EA\u4E2A\u80A1\u7684\u7410\u788E\u516C\u544A\uFF08\u505C\u590D\u724C\u3001\u5C0F\u989D\u56DE\u8D2D\u7B49\uFF0C\u9664\u975E\u6D89\u53CA\u6743\u91CD\u80A1\u6216\u5F02\u5E38\u6CE2\u52A8\uFF09
**duplicate** \u2014 \u540C\u4E00\u4E8B\u4EF6\u4FDD\u7559\u6700\u8BE6\u7EC6\u7684\u4E00\u6761\uFF0C\u5176\u4F59\u6807 duplicate

## \u7279\u6B8A\u6807\u8BB0
- [\u52A0\u7EA2] \u6761\u76EE\u4E3A\u6E20\u9053\u7F16\u8F91\u63A8\u8350\uFF0C\u4F18\u5148\u4FDD\u7559\uFF08\u9664\u975E\u662F\u5E7F\u544A\uFF09
- \u6D89\u53CA\u6CAA\u6DF1300/\u521B\u4E1A\u677F/\u6052\u751F\u79D1\u6280\u6210\u5206\u80A1\u7684\u91CD\u5927\u65B0\u95FB\u4F18\u5148\u4FDD\u7559

## \u8F93\u51FA\u683C\u5F0F\uFF08\u4E25\u683CJSON\u6570\u7EC4\uFF0C\u4E0D\u8981markdown\u5305\u88F9\uFF09
[{"id":123,"status":"kept"},{"id":456,"status":"dropped","reason":"\u8F6F\u6587"},{"id":789,"status":"duplicate","reason":"\u540CID:123"}]

## \u6CE8\u610F
- \u6BCF\u6761\u90FD\u5FC5\u987B\u5224\u65AD\uFF0C\u4E0D\u53EF\u9057\u6F0F
- \u5B81\u7559\u52FF\u5220\uFF0C\u4E0D\u786E\u5B9A\u5C31\u4FDD\u7559
- reason \u5C3D\u91CF\u7B80\u77ED\uFF08\u226410\u5B57\uFF09\uFF0Ckept \u4E0D\u5199 reason`;
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: `\u7B5B\u9009\u4EE5\u4E0B ${items.length} \u6761:

${itemsList}` }
  ];
}
function parseFilterResult(content, itemIds) {
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    log24.warn("LLM \u8FD4\u56DE\u5185\u5BB9\u4E2D\u672A\u627E\u5230 JSON \u6570\u7EC4");
    return [];
  }
  try {
    const raw = JSON.parse(jsonMatch[0]);
    const decisions = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const obj = item;
      const id = Number(obj["id"]);
      const status = String(obj["status"] ?? "");
      const reason = obj["reason"] ? String(obj["reason"]) : void 0;
      if (!itemIds.has(id)) continue;
      if (!["kept", "dropped", "duplicate"].includes(status)) continue;
      decisions.push({ id, status, reason });
    }
    return decisions;
  } catch (err) {
    log24.warn({ err }, "\u89E3\u6790 LLM \u7B5B\u9009\u7ED3\u679C JSON \u5931\u8D25");
    return [];
  }
}
async function filterNewsByLlm(options, withinHours = 48) {
  const { provider, model, store, batchSize = 40 } = options;
  const pending = store.getPendingNews(withinHours, batchSize);
  if (pending.length === 0) {
    log24.debug("\u65E0\u5F85\u7B5B\u9009\u8D44\u8BAF");
    return 0;
  }
  log24.info({ count: pending.length, model }, "\u5F00\u59CB LLM \u8D44\u8BAF\u7B5B\u9009: %d \u6761", pending.length);
  const messages = buildFilterPrompt(pending);
  const itemIds = new Set(pending.map((it) => it.id));
  try {
    const resp = await provider.chatCompletion({
      model,
      messages,
      temperature: 0.1,
      maxTokens: 4096,
      enableThinking: false
    });
    const decisions = parseFilterResult(resp.content, itemIds);
    log24.info(
      {
        parsed: decisions.length,
        total: pending.length,
        promptTokens: resp.usage.promptTokens,
        completionTokens: resp.usage.completionTokens
      },
      "LLM \u7B5B\u9009\u5B8C\u6210: \u89E3\u6790 %d/%d \u6761",
      decisions.length,
      pending.length
    );
    if (decisions.length > 0) {
      store.updateNewsLlmStatus(decisions);
    }
    const decidedIds = new Set(decisions.map((d) => d.id));
    const fallback = pending.filter((it) => !decidedIds.has(it.id)).map((it) => ({ id: it.id, status: "kept", reason: "LLM \u672A\u8986\u76D6\uFF0C\u9ED8\u8BA4\u4FDD\u7559" }));
    if (fallback.length > 0) {
      store.updateNewsLlmStatus(fallback);
      log24.info({ count: fallback.length }, "LLM \u672A\u8986\u76D6 %d \u6761\uFF0C\u9ED8\u8BA4\u6807\u8BB0 kept", fallback.length);
    }
    return pending.length;
  } catch (err) {
    log24.error({ err }, "LLM \u7B5B\u9009\u8C03\u7528\u5931\u8D25\uFF0C\u5168\u90E8\u9ED8\u8BA4\u4FDD\u7559");
    store.updateNewsLlmStatus(pending.map((it) => ({ id: it.id, status: "kept" })));
    return pending.length;
  }
}

// src/tool/finance-news/refresh-service.ts
var log25 = createLogger("news-refresh");
var LLM_FILTER_THRESHOLD = 50;
var DEFAULT_FETCH_COUNT = 30;
var DEFAULT_TIMEOUT_MS4 = 15e3;
var CLEANUP_HOURS = 48;
var MAX_FILTER_ROUNDS = 2;
var FILTER_BATCH_SIZE = 50;
var NewsRefreshService = class {
  sources;
  store;
  provider;
  filterModel;
  timeoutMs;
  fetchCount;
  cronJob = null;
  currentCronExpr = "0 * * * *";
  enabled = true;
  refreshing = false;
  constructor(options) {
    this.store = options.store;
    this.provider = options.provider;
    this.filterModel = options.filterModel;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS4;
    this.fetchCount = options.fetchCount ?? DEFAULT_FETCH_COUNT;
    this.sources = [
      createClsSource(),
      createEastmoneySource(),
      // createSinaSource(),  // 新浪源暂停使用，保留备用
      createJin10Source()
    ];
  }
  /** 启动定时刷新（从 DB 恢复配置） */
  start() {
    const config = this.store.getNewsRefreshConfig();
    this.enabled = config.enabled === 1;
    this.currentCronExpr = config.cronExpr;
    if (this.enabled) {
      this.scheduleCron(this.currentCronExpr);
      log25.info({ cron: this.currentCronExpr }, "\u8D44\u8BAF\u5B9A\u65F6\u5237\u65B0\u5DF2\u542F\u52A8: %s", this.currentCronExpr);
      void this.refresh();
    } else {
      log25.info("\u8D44\u8BAF\u5B9A\u65F6\u5237\u65B0\u5DF2\u6682\u505C\uFF08DB\u914D\u7F6E enabled=0\uFF09");
    }
  }
  /** 停止定时刷新 */
  stop() {
    this.cronJob?.stop();
    this.cronJob = null;
    this.enabled = false;
    this.store.updateNewsRefreshConfig({ enabled: 0 });
    log25.info("\u8D44\u8BAF\u5B9A\u65F6\u5237\u65B0\u5DF2\u505C\u6B62");
  }
  /** 恢复定时刷新 */
  resume() {
    this.enabled = true;
    this.store.updateNewsRefreshConfig({ enabled: 1 });
    this.scheduleCron(this.currentCronExpr);
    log25.info({ cron: this.currentCronExpr }, "\u8D44\u8BAF\u5B9A\u65F6\u5237\u65B0\u5DF2\u6062\u590D");
    void this.refresh();
  }
  /** 更新 cron 表达式 */
  updateCron(cronExpr) {
    if (!cron2.validate(cronExpr)) {
      log25.warn({ cronExpr }, "\u65E0\u6548\u7684 cron \u8868\u8FBE\u5F0F");
      return false;
    }
    this.currentCronExpr = cronExpr;
    this.store.updateNewsRefreshConfig({ cronExpr });
    if (this.enabled) {
      this.scheduleCron(cronExpr);
    }
    log25.info({ cronExpr }, "\u8D44\u8BAF\u5237\u65B0\u95F4\u9694\u5DF2\u66F4\u65B0: %s", cronExpr);
    return true;
  }
  /** 获取当前状态 */
  getStatus() {
    const config = this.store.getNewsRefreshConfig();
    return {
      enabled: this.enabled,
      cronExpr: this.currentCronExpr,
      lastRefreshAt: config.lastRefreshAt,
      isRefreshing: this.refreshing
    };
  }
  /** 销毁服务（系统关闭时调用） */
  destroy() {
    this.cronJob?.stop();
    this.cronJob = null;
    log25.info("\u8D44\u8BAF\u5237\u65B0\u670D\u52A1\u5DF2\u9500\u6BC1");
  }
  /** 执行一次完整刷新流程 */
  async refresh() {
    if (this.refreshing) {
      log25.debug("\u4E0A\u4E00\u8F6E\u5237\u65B0\u5C1A\u672A\u5B8C\u6210\uFF0C\u8DF3\u8FC7\u672C\u6B21");
      return;
    }
    this.refreshing = true;
    const startMs = Date.now();
    try {
      log25.info("\u5F00\u59CB\u540E\u53F0\u8D44\u8BAF\u5237\u65B0...");
      const fetchResults = await Promise.all(
        this.sources.map(async (src) => {
          try {
            return await src.fetch({ count: this.fetchCount, timeoutMs: this.timeoutMs });
          } catch (err) {
            log25.warn({ source: src.id, err }, "\u6E20\u9053 %s \u62C9\u53D6\u5931\u8D25", src.name);
            return [];
          }
        })
      );
      const allItems = fetchResults.flat();
      log25.info({ totalRaw: allItems.length }, "\u540E\u53F0\u5237\u65B0: \u6C47\u805A %d \u6761", allItems.length);
      const inserted = persistNewsItems(this.store, allItems);
      let totalFiltered = 0;
      const pendingCount = this.store.countPendingNews(CLEANUP_HOURS);
      if (pendingCount >= LLM_FILTER_THRESHOLD) {
        log25.info({ pendingCount }, "pending \u8FBE\u5230\u9608\u503C %d\uFF0C\u89E6\u53D1 LLM \u7B5B\u9009", pendingCount);
        try {
          for (let round = 0; round < MAX_FILTER_ROUNDS; round++) {
            const processed = await filterNewsByLlm(
              { provider: this.provider, model: this.filterModel, store: this.store, batchSize: FILTER_BATCH_SIZE },
              CLEANUP_HOURS
            );
            totalFiltered += processed;
            if (processed === 0) break;
          }
        } catch (err) {
          log25.warn({ err }, "\u540E\u53F0 LLM \u7B5B\u9009\u5F02\u5E38");
        }
      }
      const cleaned = this.store.cleanupOldNews(CLEANUP_HOURS);
      this.store.updateNewsRefreshConfig({ lastRefreshAt: (/* @__PURE__ */ new Date()).toISOString() });
      const elapsed = Date.now() - startMs;
      log25.info(
        { inserted, pendingCount, filtered: totalFiltered, cleaned, elapsedMs: elapsed },
        "\u540E\u53F0\u5237\u65B0\u5B8C\u6210: \u65B0\u589E%d, pending%d, \u7B5B\u9009%d, \u6E05\u7406%d, \u8017\u65F6%dms",
        inserted,
        pendingCount,
        totalFiltered,
        cleaned,
        elapsed
      );
    } catch (err) {
      log25.error({ err }, "\u540E\u53F0\u8D44\u8BAF\u5237\u65B0\u5F02\u5E38");
    } finally {
      this.refreshing = false;
    }
  }
  // ────── 内部方法 ──────
  scheduleCron(cronExpr) {
    this.cronJob?.stop();
    this.cronJob = cron2.schedule(cronExpr, () => {
      void this.refresh();
    }, { timezone: "Asia/Shanghai" });
    this.cronJob.start();
  }
};

// src/tool/finance-news/index.ts
var log26 = createLogger("tool-finance-news");
var IMPORTANCE_LABEL = {
  high: "\u{1F534}",
  medium: "\u{1F7E1}",
  low: "\u26AA"
};
function formatCacheItem(item, idx) {
  const d = new Date(item.publishedAt);
  const today2 = /* @__PURE__ */ new Date();
  const isToday = d.getFullYear() === today2.getFullYear() && d.getMonth() === today2.getMonth() && d.getDate() === today2.getDate();
  const time = d.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    ...isToday ? {} : { month: "2-digit", day: "2-digit" },
    hour: "2-digit",
    minute: "2-digit"
  });
  const imp = item.importance || "low";
  const label = IMPORTANCE_LABEL[imp] ?? "\u26AA";
  const title = item.title || "(\u5FEB\u8BAF)";
  const tags = (() => {
    try {
      return JSON.parse(item.tags);
    } catch {
      return [];
    }
  })();
  const tagStr = tags.length > 0 ? ` [${tags.slice(0, 3).join(", ")}]` : "";
  const summary = item.summary.length > 200 ? item.summary.slice(0, 200) + "..." : item.summary;
  return `${label} [${idx + 1}] ${time} ${title}${tagStr}
   ${summary}`;
}
function formatCacheOutput(items) {
  if (items.length === 0) {
    return "\u6682\u65E0\u6700\u65B0\u8D22\u7ECF\u8D44\u8BAF\u3002";
  }
  const lines = items.map((item, i) => formatCacheItem(item, i));
  return `\u6700\u65B0\u8D22\u7ECF\u8D44\u8BAF\uFF08\u5171 ${items.length} \u6761\uFF09:

${lines.join("\n\n")}`;
}
var IMPORTANCE_ALIAS = {
  high: "high",
  medium: "medium",
  low: "low",
  "\u91CD\u8981": "high",
  "\u52A0\u7EA2": "high",
  "\u5168\u90E8": "low"
};
function parseImportance(raw) {
  const str = String(raw ?? "").trim().toLowerCase();
  return IMPORTANCE_ALIAS[str] ?? "low";
}
var IMP_WEIGHT = { high: 3, medium: 2, low: 1 };
function handleQuery(store, count, minWeight) {
  const keptItems = store.getKeptNews(24, count + 20);
  const filtered = keptItems.filter((it) => (IMP_WEIGHT[it.importance] ?? 1) >= minWeight).sort((a, b) => {
    const wDiff = (IMP_WEIGHT[b.importance] ?? 1) - (IMP_WEIGHT[a.importance] ?? 1);
    if (wDiff !== 0) return wDiff;
    return b.publishedAt < a.publishedAt ? 1 : b.publishedAt > a.publishedAt ? -1 : 0;
  }).slice(0, count);
  log26.info({ kept: keptItems.length, filtered: filtered.length }, "\u67E5\u8BE2\u8F93\u51FA %d \u6761", filtered.length);
  const cleaned = store.cleanupOldNews(48);
  if (cleaned > 0) log26.info({ cleaned }, "\u6E05\u7406 %d \u6761\u8FC7\u671F\u8D44\u8BAF", cleaned);
  return { content: formatCacheOutput(filtered), isError: false };
}
function handleCount(store) {
  const kept = store.countKeptNews(48);
  const pending = store.countPendingNews(48);
  const content = `\u{1F4CA} \u8D44\u8BAF\u7EDF\u8BA1\uFF0848\u5C0F\u65F6\u5185\uFF09:
- \u6709\u6548\u8D44\u8BAF\uFF08\u5DF2\u7B5B\u9009\uFF09: ${kept} \u6761
- \u5F85\u7B5B\u9009: ${pending} \u6761
- \u5408\u8BA1: ${kept + pending} \u6761`;
  return { content, isError: false };
}
function handlePause(refreshService) {
  refreshService.stop();
  return { content: "\u2705 \u8D44\u8BAF\u540E\u53F0\u5237\u65B0\u5DF2\u6682\u505C\u3002", isError: false };
}
function handleResume(refreshService) {
  refreshService.resume();
  const status = refreshService.getStatus();
  return { content: `\u2705 \u8D44\u8BAF\u540E\u53F0\u5237\u65B0\u5DF2\u6062\u590D\uFF0C\u5F53\u524D\u95F4\u9694: ${status.cronExpr}`, isError: false };
}
function handleStatus(refreshService, store) {
  const status = refreshService.getStatus();
  const kept = store.countKeptNews(48);
  const pending = store.countPendingNews(48);
  const stateText = status.enabled ? "\u8FD0\u884C\u4E2D" : "\u5DF2\u6682\u505C";
  const lastText = status.lastRefreshAt ? new Date(status.lastRefreshAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "\u5C1A\u672A\u5237\u65B0";
  const refreshingText = status.isRefreshing ? "\uFF08\u6B63\u5728\u5237\u65B0\u4E2D...\uFF09" : "";
  const content = `\u{1F4E1} \u8D44\u8BAF\u5237\u65B0\u72B6\u6001:
- \u72B6\u6001: ${stateText}${refreshingText}
- \u5237\u65B0\u95F4\u9694: ${status.cronExpr}
- \u4E0A\u6B21\u5237\u65B0: ${lastText}
- \u6709\u6548\u8D44\u8BAF: ${kept} \u6761
- \u5F85\u7B5B\u9009: ${pending} \u6761`;
  return { content, isError: false };
}
function handleSetInterval(refreshService, cronExpr) {
  const ok = refreshService.updateCron(cronExpr);
  if (!ok) {
    return { content: `\u274C \u65E0\u6548\u7684 cron \u8868\u8FBE\u5F0F: ${cronExpr}`, isError: true };
  }
  return { content: `\u2705 \u8D44\u8BAF\u5237\u65B0\u95F4\u9694\u5DF2\u66F4\u65B0\u4E3A: ${cronExpr}`, isError: false };
}
function createFinanceNewsTool(options) {
  const { store, provider, filterModel, timeoutMs } = options;
  const refreshService = new NewsRefreshService({
    store,
    provider,
    filterModel,
    timeoutMs
  });
  return {
    name: "finance_news",
    description: `\u8D22\u7ECF\u8D44\u8BAF\u5DE5\u5177\u3002\u652F\u6301\u4EE5\u4E0B\u64CD\u4F5C:
- action="query"\uFF08\u9ED8\u8BA4\uFF09: \u83B7\u53D6\u6700\u65B0\u8D22\u7ECF\u8D44\u8BAF\uFF0C\u53EF\u6307\u5B9A count\uFF08\u6761\u6570\uFF09\u548C importance\uFF08\u91CD\u8981\u5EA6\uFF09
- action="count": \u67E5\u770B\u5F53\u524D\u8D44\u8BAF\u5E93\u5B58\u6570\u91CF
- action="pause": \u6682\u505C\u540E\u53F0\u81EA\u52A8\u83B7\u53D6\u65B0\u95FB
- action="resume": \u6062\u590D\u540E\u53F0\u81EA\u52A8\u83B7\u53D6\u65B0\u95FB
- action="status": \u67E5\u770B\u540E\u53F0\u5237\u65B0\u72B6\u6001
- action="set_interval": \u8BBE\u7F6E\u5237\u65B0\u95F4\u9694\uFF0C\u9700\u63D0\u4F9B cron_expr \u53C2\u6570\uFF08\u5982 "*/30 * * * *" \u8868\u793A\u6BCF30\u5206\u949F\uFF09
\u5F53\u7528\u6237\u8BE2\u95EE\u8D22\u7ECF\u65B0\u95FB\u3001\u80A1\u5E02\u52A8\u6001\u3001\u671F\u8D27\u884C\u60C5\u3001\u5B8F\u89C2\u7ECF\u6D4E\u653F\u7B56\u7B49\u91D1\u878D\u76F8\u5173\u5B9E\u65F6\u8D44\u8BAF\u65F6\u4F7F\u7528 query\u3002
\u5F53\u7528\u6237\u8981\u6C42\u6682\u505C/\u6062\u590D/\u4FEE\u6539\u83B7\u53D6\u65B0\u95FB\u9891\u7387\u65F6\u4F7F\u7528\u5BF9\u5E94 action\u3002`,
    systemHint: `finance_news: \u8D22\u7ECF/\u80A1\u5E02/\u671F\u8D27/\u7ECF\u6D4E\u76F8\u5173\u8D44\u8BAF\u4F18\u5148\u7528\u6B64\u5DE5\u5177\uFF0C\u6BD4 web_search \u66F4\u5FEB\u66F4\u7CBE\u51C6\u3002
\u652F\u6301\u63A7\u5236\u64CD\u4F5C: pause(\u6682\u505C)\u3001resume(\u6062\u590D)\u3001status(\u72B6\u6001)\u3001count(\u7EDF\u8BA1)\u3001set_interval(\u6539\u95F4\u9694)\u3002`,
    loadingHint: "\u{1F4E1} \u6B63\u5728\u83B7\u53D6\u6700\u65B0\u8D22\u7ECF\u8D44\u8BAF\uFF0C\u8BF7\u7A0D\u5019...",
    timeoutMs: 3e4,
    parameterSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["query", "count", "pause", "resume", "status", "set_interval"],
          description: "\u64CD\u4F5C\u7C7B\u578B\uFF0C\u9ED8\u8BA4 query"
        },
        count: {
          type: "number",
          description: "\u83B7\u53D6\u6761\u6570\uFF0C\u9ED8\u8BA415\uFF0C\u6700\u592730\uFF08\u4EC5 query \u65F6\u6709\u6548\uFF09"
        },
        importance: {
          type: "string",
          description: "\u91CD\u8981\u5EA6\u7B5B\u9009: '\u91CD\u8981'(\u4EC5\u91CD\u5927) / 'medium'(\u4E2D\u7B49\u4EE5\u4E0A) / '\u5168\u90E8'(\u9ED8\u8BA4)\uFF08\u4EC5 query \u65F6\u6709\u6548\uFF09"
        },
        cron_expr: {
          type: "string",
          description: "cron \u8868\u8FBE\u5F0F\uFF08\u4EC5 set_interval \u65F6\u9700\u8981\uFF09\uFF0C\u5982 '*/30 * * * *' \u8868\u793A\u6BCF30\u5206\u949F"
        }
      },
      required: []
    },
    /** 注册后自动启动后台刷新 */
    onStart() {
      refreshService.start();
    },
    /** 系统关闭时销毁后台刷新 */
    onStop() {
      refreshService.destroy();
    },
    async execute(params, _ctx) {
      const action = String(params["action"] ?? "query").trim().toLowerCase();
      switch (action) {
        case "query": {
          const rawCount = Math.min(Math.max(Number(params["count"]) || 15, 1), 30);
          const minImportance = parseImportance(params["importance"]);
          const minWeight = IMP_WEIGHT[minImportance] ?? 1;
          log26.info({ rawCount, minImportance, action }, "\u6267\u884C\u8D44\u8BAF\u67E5\u8BE2");
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
            return { content: "\u274C \u8BF7\u63D0\u4F9B cron_expr \u53C2\u6570", isError: true };
          }
          return handleSetInterval(refreshService, cronExpr);
        }
        default:
          return { content: `\u274C \u672A\u77E5\u64CD\u4F5C: ${action}`, isError: true };
      }
    }
  };
}

// src/tool/create-builtin-tools.ts
var log27 = createLogger("builtin-tools");
function createBuiltinTools(deps) {
  const tools = [];
  tools.push(...createReminderTools({
    scheduler: deps.scheduler
  }));
  tools.push(createWebSearchTool({
    timeoutMs: deps.config.tools.webFetch.timeoutMs,
    maxBodySizeKB: deps.config.tools.webFetch.maxBodySizeKB,
    fetchDetail: true,
    fetchDetailMax: 2
  }));
  tools.push(createFinanceNewsTool({
    timeoutMs: deps.config.tools.webFetch.timeoutMs,
    store: deps.store,
    provider: deps.provider,
    filterModel: deps.config.tools.filterModel ?? deps.config.session.memory.summaryModel
  }));
  log27.info({ count: tools.length, names: tools.map((t) => t.name) }, "\u5185\u7F6E\u5DE5\u5177\u521B\u5EFA\u5B8C\u6210");
  return tools;
}

// src/index.ts
if (process.platform === "win32") {
  try {
    execSync("chcp 65001", { stdio: "ignore" });
  } catch {
  }
}
var log28 = createLogger("main");
async function main() {
  log28.info("FroadClaw-Agent \u542F\u52A8\u4E2D...");
  const config = loadConfig();
  const dbPath = process.env["DB_PATH"] ?? resolve3(process.cwd(), "data", "froadclaw.db");
  const store = await SqliteSessionStore.create(dbPath);
  const providerRegistry = new ProviderRegistry();
  let defaultContextWindow = 131072;
  for (const p of config.providers) {
    providerRegistry.register(new OpenAICompatibleProvider(p.id, p.baseUrl, p.apiKey, p.models));
    log28.info({ id: p.id, models: p.models }, "LLM Provider \u6CE8\u518C\u6210\u529F\uFF0C\u53EF\u7528\u6A21\u578B: %s", p.models.join(", "));
    if (p.contextWindow) defaultContextWindow = p.contextWindow;
  }
  const modelRouter = new ModelRouter(config.modelRouting);
  const schedulerStore = new SchedulerStore(store.getDatabase());
  const channelMap = /* @__PURE__ */ new Map();
  const toolRegistry = new ToolRegistry();
  const toolExecutor = new ToolExecutor(toolRegistry, defaultContextWindow);
  const sessionManager = new SessionManager(store, config.session, config.modelRouting.default ?? "qwen/qwen-plus");
  const channelRegistry = new ChannelRegistry();
  const feishuChannel = new FeishuChannel(config.channels.feishu);
  channelRegistry.register(feishuChannel);
  channelMap.set("feishu", feishuChannel);
  const scheduler = new SchedulerService({ store: schedulerStore, channelMap });
  const defaultProvider = providerRegistry.getOrThrow(config.providers[0].id);
  const builtinTools = createBuiltinTools({ config, scheduler, store, provider: defaultProvider });
  builtinTools.forEach((t) => toolRegistry.register(t));
  const router = createRouter({
    providerRegistry,
    modelRouter,
    toolRegistry,
    toolExecutor,
    sessionManager,
    sessionStore: store,
    sessionConfig: config.session,
    channel: feishuChannel,
    rateLimitConfig: config.rateLimit
  });
  feishuChannel.onMessage((msg) => router.onInboundMessage(msg));
  scheduler.setAgentTriggerCallback((msg) => router.onInboundMessage(msg));
  const fastify = Fastify({ logger: false });
  fastify.get("/health", async () => ({ status: "ok", uptime: process.uptime() }));
  await fastify.listen({ port: config.server.port, host: config.server.host });
  log28.info({ port: config.server.port }, "HTTP \u670D\u52A1\u5DF2\u542F\u52A8");
  await channelRegistry.startAll();
  scheduler.start();
  log28.info("FroadClaw-Agent \u5DF2\u5C31\u7EEA");
  setInterval(() => {
    const result = store.cleanupExpired();
    if (result.sessions > 0 || result.dedups > 0) {
      log28.info(result, "\u6E05\u7406\u8FC7\u671F\u6570\u636E");
    }
  }, 36e5);
  const shutdown = async (signal) => {
    log28.info({ signal }, "\u6536\u5230\u5173\u95ED\u4FE1\u53F7");
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
  log28.fatal({ err }, "\u542F\u52A8\u5931\u8D25");
  process.exit(1);
});
//# sourceMappingURL=index.js.map