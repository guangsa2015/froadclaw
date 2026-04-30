import type { ModelRoutingConfig } from "../config/types.js";
import type { Scene } from "../agent/scene-classifier.js";

export interface RouteResult {
  providerId: string;
  modelId: string;
  cleanContent: string;
}

/**
 * 模型路由 — 根据命令前缀 / 场景 / 默认规则分发
 */
export class ModelRouter {
  constructor(private config: ModelRoutingConfig) {}

  resolve(content: string, scene?: Scene): RouteResult {
    // 检查命令前缀
    for (const [cmd, modelPath] of Object.entries(this.config.commands)) {
      if (content.startsWith(cmd)) {
        const { providerId, modelId } = this.parseModelPath(modelPath);
        return { providerId, modelId, cleanContent: content.slice(cmd.length).trim() };
      }
    }

    // 场景路由：work → workModel, life → lifeModel
    if (scene && this.config.sceneModels) {
      const modelPath = scene === "work"
        ? this.config.sceneModels.work
        : this.config.sceneModels.life;
      if (modelPath) {
        const { providerId, modelId } = this.parseModelPath(modelPath);
        return { providerId, modelId, cleanContent: content };
      }
    }

    // 默认模型
    const defaultPath = this.config.default ?? "";
    if (!defaultPath) throw new Error("未配置默认模型路由");
    const { providerId, modelId } = this.parseModelPath(defaultPath);
    return { providerId, modelId, cleanContent: content };
  }

  /** 解析 "qwen/qwen-plus" → { providerId: "qwen", modelId: "qwen-plus" } */
  private parseModelPath(path: string): { providerId: string; modelId: string } {
    const sep = path.indexOf("/");
    if (sep === -1) return { providerId: path, modelId: path };
    return { providerId: path.slice(0, sep), modelId: path.slice(sep + 1) };
  }
}
