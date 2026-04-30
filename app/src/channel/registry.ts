import type { Channel } from "./types.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("channel-registry");

export class ChannelRegistry {
  private channels = new Map<string, Channel>();

  register(channel: Channel): void {
    log.info({ id: channel.id }, "注册渠道");
    this.channels.set(channel.id, channel);
  }

  get(id: string): Channel | undefined {
    return this.channels.get(id);
  }

  /** 启动所有渠道 */
  async startAll(): Promise<void> {
    for (const [id, ch] of this.channels) {
      log.info({ id }, "启动渠道");
      await ch.start();
    }
  }

  /** 停止所有渠道 */
  async stopAll(): Promise<void> {
    for (const [id, ch] of this.channels) {
      log.info({ id }, "停止渠道");
      await ch.stop();
    }
  }

  list(): Channel[] {
    return [...this.channels.values()];
  }
}
