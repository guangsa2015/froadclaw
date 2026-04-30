import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { config as loadDotenv } from "dotenv";
import { DEFAULT_CONFIG } from "./defaults.js";
import type { AppConfig } from "./types.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("config");

/**
 * 加载配置：YAML 文件 → 环境变量替换 → 合并默认值
 */
export function loadConfig(configPath?: string): AppConfig {
  // 加载 .env
  loadDotenv();

  const filePath = configPath ?? resolve(process.cwd(), "configs", "config.yaml");
  log.info({ path: filePath }, "加载配置文件");

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    log.warn("配置文件不存在，使用默认配置");
    return DEFAULT_CONFIG;
  }

  // 替换 ${ENV_VAR} 占位符
  const expanded = raw.replace(/\$\{(\w+)}/g, (_, key: string) => {
    const val = process.env[key];
    if (!val) log.warn({ key }, "环境变量未设置");
    return val ?? "";
  });

  const parsed = parseYaml(expanded) as Record<string, unknown>;
  const merged = deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, parsed) as unknown as AppConfig;

  // 解析 providers.models: 逗号分隔字符串 → string[]
  for (const p of merged.providers) {
    if (typeof p.models === "string") {
      p.models = (p.models as string).split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  // 自动派生 modelRouting.default（第一个 provider 的第一个 model）
  if (!merged.modelRouting.default && merged.providers.length > 0) {
    const first = merged.providers[0]!;
    const firstModel = first.models[0];
    if (firstModel) merged.modelRouting.default = `${first.id}/${firstModel}`;
  }

  return merged;
}

/** 递归合并对象（不合并数组，直接覆盖） */
function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const baseVal = base[key];
    const overVal = override[key];

    if (
      overVal !== null &&
      typeof overVal === "object" &&
      !Array.isArray(overVal) &&
      typeof baseVal === "object" &&
      baseVal !== null &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(baseVal as Record<string, unknown>, overVal as Record<string, unknown>);
    } else if (overVal !== undefined) {
      result[key] = overVal;
    }
  }
  return result;
}
