import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { resolve } from "node:path";
import { Transform } from "node:stream";
import pino from "pino";

const isDev = process.env["NODE_ENV"] !== "production";
const LOG_LEVEL = process.env["LOG_LEVEL"] ?? "info";
const LOG_DIR = process.env["LOG_DIR"] ?? resolve(process.cwd(), "logs");

/** 级别数字 → 标签 */
const LEVEL_LABELS: Record<number, string> = {
  10: "TRACE", 20: "DEBUG", 30: "INFO", 40: "WARN", 50: "ERROR", 60: "FATAL",
};

/** 时间戳格式化为 yyyy-MM-dd HH:mm:ss（本地时区） */
function formatTime(epoch: number): string {
  const d = new Date(epoch);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 获取当前日期字符串 YYYY-MM-DD */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 按天滚动的文件流管理器 */
class RollingFileStream {
  private stream: WriteStream | null = null;
  private currentDate = "";
  private readonly dir: string;
  private readonly prefix: string;

  constructor(dir: string, prefix: string) {
    this.dir = dir;
    this.prefix = prefix;
  }

  getStream(): WriteStream {
    const d = today();
    if (d !== this.currentDate || !this.stream) {
      this.currentDate = d;
      const filePath = resolve(this.dir, `${this.prefix}-${d}.log`);
      const oldStream = this.stream;
      if (oldStream) setTimeout(() => oldStream.end(), 1000);
      this.stream = createWriteStream(filePath, { flags: "a" });
    }
    return this.stream;
  }
}

/** 创建写入代理 */
function createRollingDestination(rolling: RollingFileStream): NodeJS.WritableStream {
  return new Proxy({} as NodeJS.WritableStream, {
    get(_target, prop) {
      const stream = rolling.getStream();
      const val = (stream as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof val === "function") return val.bind(stream);
      return val;
    },
  });
}

/** 去掉冗余字段的排除列表 */
const OMIT_KEYS = new Set(["level", "time", "pid", "hostname", "msg", "module"]);

/**
 * 将 pino JSON 行转为简洁格式：
 * 2026-03-20 16:28:11 [INFO] agent-loop - 开始处理: 财经资讯 | sessionId=feishu:... turn=3
 */
function createCompactTransform(): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        const obj = JSON.parse(chunk.toString().trim()) as Record<string, unknown>;

        const time = formatTime(obj.time as number);
        const level = LEVEL_LABELS[obj.level as number] ?? "INFO";
        const mod = obj.module ? String(obj.module) : "app";
        const msg = obj.msg ? String(obj.msg) : "";

        // 收集除排除字段外的其它上下文
        const extras: string[] = [];
        for (const [k, v] of Object.entries(obj)) {
          if (OMIT_KEYS.has(k)) continue;
          if (v === undefined || v === null) continue;
          // 对象/数组序列化为 JSON
          const val = typeof v === "object" ? JSON.stringify(v) : String(v);
          extras.push(`${k}=${val}`);
        }

        let line = `${time} [${level}] ${mod} - ${msg}`;
        if (extras.length > 0) line += ` | ${extras.join(" ")}`;

        callback(null, line + "\n");
      } catch {
        // 非 JSON 行原样透传
        callback(null, chunk);
      }
    },
  });
}

function buildLogger(): pino.Logger {
  mkdirSync(LOG_DIR, { recursive: true });

  const appRolling = new RollingFileStream(LOG_DIR, "app");
  const errorRolling = new RollingFileStream(LOG_DIR, "error");

  // 文件流前加 Transform 做格式转换
  const appTransform = createCompactTransform();
  appTransform.pipe(createRollingDestination(appRolling));

  const errorTransform = createCompactTransform();
  errorTransform.pipe(createRollingDestination(errorRolling));

  const streams: pino.StreamEntry[] = [
    { level: LOG_LEVEL as pino.Level, stream: appTransform },
    { level: "error", stream: errorTransform },
  ];

  if (isDev) {
    // 开发环境：控制台彩色输出
    const pretty = pino.transport({
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss",
        ignore: "pid,hostname",
      },
    });
    streams.push({ level: LOG_LEVEL as pino.Level, stream: pretty });
  } else {
    // 生产环境：控制台简洁输出（供 docker logs 查看）
    const stdoutTransform = createCompactTransform();
    stdoutTransform.pipe(process.stdout);
    streams.push({ level: LOG_LEVEL as pino.Level, stream: stdoutTransform });
  }

  return pino({ level: LOG_LEVEL }, pino.multistream(streams));
}

export const logger = buildLogger();

/** 创建带模块标签的子 logger */
export function createLogger(module: string): pino.Logger {
  return logger.child({ module });
}
