/**
 * 定时任务行类型定义
 */
export interface ScheduledTaskRow {
  id: number;
  userId: string;
  chatId: string;
  channelType: string;
  /** 用户原始描述 */
  description: string;
  /** 提醒文本 */
  remindText: string;
  /** delay | once | cron | lunar */
  taskType: "delay" | "once" | "cron" | "lunar";
  /** once/delay 的触发时间 ISO8601 */
  triggerAt: string | null;
  /** cron 表达式（分 时 日 月 周） */
  cronExpr: string | null;
  /** 农历月 */
  lunarMonth: number | null;
  /** 农历日 */
  lunarDay: number | null;
  /** 农历是否每年重复 */
  lunarRepeatYearly: number;
  /** 触发模式：direct=直接发送提醒文本, agent=重新进入Agent Loop由LLM决定动作 */
  triggerMode: "direct" | "agent";
  /** active | done | cancelled */
  status: string;
  lastTriggeredAt: string | null;
  nextTriggerAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NewScheduledTask = Omit<ScheduledTaskRow, "id" | "createdAt" | "updatedAt">;
