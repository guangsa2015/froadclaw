/**
 * 渠道层接口定义
 */

export interface InboundMessage {
  messageId: string;
  channelType: string;
  chatId: string;
  senderId: string;
  senderName: string;
  content: string;
  mentionBot: boolean;
  isGroup: boolean;
  receivedAt: Date;
  /** 消息在渠道侧的原始创建时间（飞书 create_time），用于丢弃过期补推消息 */
  messageCreatedAt?: Date;
}

export interface OutboundMessage {
  chatId: string;
  replyToMsgId?: string;
  content: string;
}

export interface Channel {
  id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => void): void;
}
