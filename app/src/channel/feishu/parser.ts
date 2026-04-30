import type { InboundMessage } from "../../channel/types.js";

/** 飞书 im.message.receive_v1 事件顶层结构 */
export interface FeishuMessageReceiveEvent {
  sender: {
    sender_id: {
      open_id: string;
      user_id?: string;
    };
    sender_type: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: "p2p" | "group";
    message_type: string;
    content: string;
    /** 消息创建时间（毫秒时间戳字符串），用于判断补推消息是否过期 */
    create_time?: string;
    mentions?: Array<{
      key: string;
      id: { open_id: string };
      name: string;
    }>;
  };
}

/** 解析飞书事件 → InboundMessage */
export function parseFeishuEvent(event: FeishuMessageReceiveEvent, botOpenId: string): InboundMessage | null {
  const { sender, message } = event;
  if (!sender || !message) return null;

  // 只处理文本消息
  if (message.message_type !== "text") return null;

  let text: string;
  try {
    const parsed = JSON.parse(message.content) as { text?: string };
    text = parsed.text ?? "";
  } catch {
    return null;
  }

  // 去除 @bot 前缀
  text = text.replace(/@_user_\d+/g, "").trim();
  if (!text) return null;

  const isGroup = message.chat_type === "group";
  const mentionBot = message.mentions?.some((m) => m.id.open_id === botOpenId) ?? false;

  // 群聊必须 @bot 才响应
  if (isGroup && !mentionBot) return null;

  // 解析消息原始创建时间（飞书 create_time 为毫秒时间戳字符串）
  const messageCreatedAt = message.create_time
    ? new Date(Number(message.create_time))
    : undefined;

  return {
    messageId: message.message_id,
    channelType: "feishu",
    chatId: message.chat_id,
    senderId: sender.sender_id.open_id,
    senderName: "",
    content: text,
    mentionBot,
    isGroup,
    receivedAt: new Date(),
    messageCreatedAt,
  };
}
