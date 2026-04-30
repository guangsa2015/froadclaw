import type { ChatMessage } from "../llm/types.js";

export interface Session {
  id: string;
  channelType: string;
  chatId: string;
  isGroup: boolean;
  currentModel: string;
  estimatedTokens: number;
  summary: string | null;
  messages: ChatMessage[];
  currentTurn: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}
