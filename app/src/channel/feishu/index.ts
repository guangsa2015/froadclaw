import * as lark from "@larksuiteoapi/node-sdk";
import type { Channel, InboundMessage, OutboundMessage } from "../types.js";
import type { FeishuChannelConfig } from "../../config/types.js";
import { parseFeishuEvent, type FeishuMessageReceiveEvent } from "./parser.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("feishu");

/**
 * 飞书渠道 — WebSocket 长连接接入 + REST API 回复
 */
export class FeishuChannel implements Channel {
  readonly id = "feishu";

  private client: lark.Client;
  private wsClient?: lark.WSClient;
  private messageHandler?: (msg: InboundMessage) => void;
  private processedIds = new Map<string, number>(); // 消息去重

  constructor(private config: FeishuChannelConfig) {
    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
    });
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    log.info("启动飞书 WebSocket 长连接");

    // 获取 bot openId 用于判断 @bot
    // 获取 bot openId（用于群聊 @bot 判断）
    let botOpenId = "";
    try {
      const resp = await this.client.request({
        method: "GET",
        url: "/open-apis/bot/v3/info/",
      });
      const data = resp as { bot?: { open_id?: string } };
      botOpenId = data.bot?.open_id ?? "";
      if (botOpenId) log.info({ botOpenId }, "获取 bot 信息成功");
    } catch {
      log.warn("获取 bot 信息失败，群聊 @bot 判断可能异常");
    }

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    });

    await this.wsClient.start({
      eventDispatcher: new lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data) => {
          const event = data as unknown as FeishuMessageReceiveEvent;
          const msg = parseFeishuEvent(event, botOpenId);
          if (!msg) return;

          // 去重（飞书重连可能重复推送）
          if (this.isDuplicate(msg.messageId)) return;

          this.messageHandler?.(msg);
        },
      }),
    });

    // 定期清理去重缓存
    setInterval(() => this.cleanupDedup(), 5 * 60 * 1000);

    log.info("飞书 WebSocket 已连接");
  }

  async stop(): Promise<void> {
    log.info("断开飞书 WebSocket");
  }

  async send(msg: OutboundMessage): Promise<void> {
    try {
      await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: msg.chatId,
          msg_type: "text",
          content: JSON.stringify({ text: msg.content }),
        },
      });
    } catch (err) {
      log.error({ err, chatId: msg.chatId }, "飞书消息发送失败");
      throw err;
    }
  }

  /** 去重：5 分钟内的重复消息丢弃 */
  private isDuplicate(messageId: string): boolean {
    if (this.processedIds.has(messageId)) return true;
    this.processedIds.set(messageId, Date.now());
    return false;
  }

  private cleanupDedup(): void {
    const expireMs = 5 * 60 * 1000;
    const now = Date.now();
    for (const [id, ts] of this.processedIds) {
      if (now - ts > expireMs) this.processedIds.delete(id);
    }
  }
}
