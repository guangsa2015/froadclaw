import type { Provider } from "./types.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("llm-registry");

/**
 * Provider 注册表 — 按 ID 查找
 */
export class ProviderRegistry {
  private providers = new Map<string, Provider>();

  register(provider: Provider): void {
    log.info({ id: provider.id }, "注册 LLM Provider");
    this.providers.set(provider.id, provider);
  }

  get(id: string): Provider | undefined {
    return this.providers.get(id);
  }

  getOrThrow(id: string): Provider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Provider 未注册: ${id}`);
    return provider;
  }

  listIds(): string[] {
    return [...this.providers.keys()];
  }
}
