/**
 * 定时提醒工具组 — schedule_reminder / list_reminders / cancel_reminder
 *
 * 工厂函数模式：通过闭包持有 scheduler 依赖，
 * 用户上下文（userId/chatId）通过 ToolCallContext 参数传递（无全局变量）。
 */
import type { Tool, ToolResult } from "../types.js";
import type { ToolCallContext } from "../tool-context.js";
import type { SchedulerService } from "../scheduler/service.js";
import type { ScheduledTaskRow } from "../scheduler/types.js";
import { nextLunarDate, lunarDateText } from "../scheduler/lunar-util.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("tool-reminder");

/** 工厂函数依赖 */
export interface ReminderToolOptions {
  scheduler: SchedulerService;
}

/** 创建定时提醒工具组（3 个工具） */
export function createReminderTools(options: ReminderToolOptions): Tool[] {
  const { scheduler } = options;

  // ─────────────── schedule_reminder ───────────────

  const scheduleReminderTool: Tool = {
    name: "schedule_reminder",
    description: `创建定时提醒或循环任务。
当用户说"提醒我/叫我/到时候/每天/每周/定时"等包含时间+事项的需求时调用。
你需要根据用户的自然语言描述，准确解析出任务类型和时间参数。

类型说明：
- delay: 倒计时（如"30秒后""5分钟后"）→ 填 delay_seconds
- once: 指定时间点一次性（如"明天12点""下周一9点"）→ 填 trigger_at（ISO8601格式，时区+08:00）
- cron: 循环任务（如"每天9点""每个工作日18点""每周五下午3点"）→ 填 cron_expr（5位cron: 分 时 日 月 周）
- lunar: 农历日期（如"每年农历十月初一""农历八月十五"）→ 填 lunar_month + lunar_day

常用cron示例：
- 每天9点 → "0 9 * * *"
- 每个工作日9点 → "0 9 * * 1-5"
- 每周五15点 → "0 15 * * 5"
- 每月1号10点 → "0 10 1 * *"`,
    systemHint: `schedule_reminder: trigger_mode 判断——触发时需要AI思考、回答问题或调用工具 → agent；仅发固定提醒文本 → direct。`,
    parameterSchema: {
      type: "object",
      properties: {
        remind_text: {
          type: "string",
          description: "提醒内容，简洁明了，如'该喝水了''去打球''看财经新闻'",
        },
        task_type: {
          type: "string",
          enum: ["delay", "once", "cron", "lunar"],
          description: "任务类型",
        },
        trigger_mode: {
          type: "string",
          enum: ["direct", "agent"],
          description: `触发模式：
- direct: 到时间后直接发送 remind_text 给用户（仅适合纯提醒，如"该喝水了""开会了"）
- agent: 到时间后由AI重新思考并回复（适合任何需要AI动脑的任务：回答问题、联网搜索、数据分析、组词造句等）
判断：触发时用户期望收到AI的回答或执行结果 → agent；只需一句固定提醒 → direct`,
        },
        delay_seconds: {
          type: "number",
          description: "delay类型专用：延迟秒数",
        },
        trigger_at: {
          type: "string",
          description: "once类型专用：触发时间ISO8601，如 2026-03-22T12:00:00+08:00",
        },
        cron_expr: {
          type: "string",
          description: "cron类型专用：5位cron表达式（分 时 日 月 周），如 '0 9 * * 1-5'",
        },
        lunar_month: {
          type: "number",
          description: "lunar类型专用：农历月(1-12)",
        },
        lunar_day: {
          type: "number",
          description: "lunar类型专用：农历日(1-30)",
        },
        lunar_repeat_yearly: {
          type: "boolean",
          description: "lunar类型专用：是否每年重复，默认true",
        },
        user_description: {
          type: "string",
          description: "用户原始描述（完整保留用户原话）",
        },
      },
      required: ["remind_text", "task_type"],
    },

    async execute(params: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const remindText = String(params["remind_text"] ?? "");
      const taskType = String(params["task_type"] ?? "") as "delay" | "once" | "cron" | "lunar";
      const description = String(params["user_description"] ?? remindText);
      const triggerMode = (params["trigger_mode"] === "agent" ? "agent" : "direct") as "direct" | "agent";

      if (!remindText) {
        return { content: "缺少提醒内容 remind_text", isError: true };
      }

      if (!["delay", "once", "cron", "lunar"].includes(taskType)) {
        return { content: `无效的任务类型: ${taskType}，可选: delay/once/cron/lunar`, isError: true };
      }

      try {
        let triggerAt: string | null = null;
        let cronExpr: string | null = null;
        let lunarMonth: number | null = null;
        let lunarDay: number | null = null;
        let lunarRepeatYearly = 0;

        if (taskType === "delay") {
          const seconds = Number(params["delay_seconds"]);
          if (!seconds || seconds <= 0) {
            return { content: "delay 类型需要 delay_seconds > 0", isError: true };
          }
          if (seconds > 86400 * 7) {
            return { content: "倒计时最长7天，更长时间请用 once 类型指定具体时间", isError: true };
          }
          triggerAt = new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
        } else if (taskType === "once") {
          const t = String(params["trigger_at"] ?? "");
          if (!t) {
            return { content: "once 类型需要 trigger_at 参数", isError: true };
          }
          const parsed = new Date(t);
          if (isNaN(parsed.getTime())) {
            return { content: `无法解析时间: ${t}`, isError: true };
          }
          if (parsed.getTime() <= Date.now()) {
            return { content: "指定的时间已过去，请设置未来的时间", isError: true };
          }
          triggerAt = parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
        } else if (taskType === "cron") {
          cronExpr = String(params["cron_expr"] ?? "");
          if (!cronExpr) {
            return { content: "cron 类型需要 cron_expr 参数", isError: true };
          }
          if (!validateCronExpr(cronExpr)) {
            return { content: `无效的cron表达式: ${cronExpr}，格式: 分 时 日 月 周`, isError: true };
          }
        } else if (taskType === "lunar") {
          lunarMonth = Number(params["lunar_month"]);
          lunarDay = Number(params["lunar_day"]);
          if (!lunarMonth || !lunarDay || lunarMonth < 1 || lunarMonth > 12 || lunarDay < 1 || lunarDay > 30) {
            return { content: "农历月(1-12)和日(1-30)参数无效", isError: true };
          }
          lunarRepeatYearly = params["lunar_repeat_yearly"] === false ? 0 : 1;
          triggerAt = nextLunarDate(lunarMonth, lunarDay);
        }

        const task = scheduler.addTask({
          userId: ctx.senderId,
          chatId: ctx.chatId,
          channelType: ctx.channelType,
          description,
          remindText,
          taskType,
          triggerAt,
          cronExpr,
          lunarMonth,
          lunarDay,
          lunarRepeatYearly,
          triggerMode,
          status: "active",
          lastTriggeredAt: null,
          nextTriggerAt: triggerAt,
        });

        const confirmText = buildConfirmText(task);
        log.info({ id: task.id, type: taskType, triggerMode, remind: remindText }, "任务创建成功");
        return { content: confirmText, isError: false, directReply: `✅ ${confirmText}` };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error({ err }, "创建定时任务失败");
        return { content: `创建失败: ${errMsg}`, isError: true };
      }
    },
  };

  // ─────────────── list_reminders ───────────────

  const listRemindersTool: Tool = {
    name: "list_reminders",
    description: "查看用户当前所有活跃的定时提醒和循环任务。当用户说'我有哪些提醒/定时任务列表/查看提醒'时调用。",
    parameterSchema: {
      type: "object",
      properties: {},
    },

    async execute(_params: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const tasks = scheduler.listUserTasks(ctx.senderId);
      if (tasks.length === 0) {
        return { content: "当前没有活跃的定时任务。", isError: false };
      }

      const lines = tasks.map((t, i) => {
        const typeLabel = { delay: "倒计时", once: "定时", cron: "循环", lunar: "农历" }[t.taskType] ?? t.taskType;
        const modeLabel = t.triggerMode === "agent" ? "🤖AI执行" : "📢直接提醒";
        let timeDesc = "";
        if (t.taskType === "cron") {
          timeDesc = `cron: ${t.cronExpr}`;
        } else if (t.taskType === "lunar") {
          timeDesc = lunarDateText(t.lunarMonth!, t.lunarDay!) + (t.lunarRepeatYearly ? "（每年）" : "");
        } else if (t.triggerAt) {
          timeDesc = formatTime(t.triggerAt);
        }
        return `${i + 1}. [#${t.id}] [${typeLabel}] [${modeLabel}] ${t.remindText}  ${timeDesc}`;
      });

      return { content: `活跃任务 ${tasks.length} 个:\n${lines.join("\n")}`, isError: false };
    },
  };

  // ─────────────── cancel_reminder ───────────────

  const cancelReminderTool: Tool = {
    name: "cancel_reminder",
    description: "取消指定的定时提醒。当用户说'取消提醒/删除提醒/不用提醒了'时调用。需要先用 list_reminders 查出任务ID。",
    parameterSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "number",
          description: "要取消的任务ID（从 list_reminders 获取）",
        },
      },
      required: ["task_id"],
    },

    async execute(params: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
      const taskId = Number(params["task_id"]);
      if (!taskId) {
        return { content: "缺少 task_id 参数", isError: true };
      }

      const success = scheduler.cancelTask(taskId);
      if (success) {
        log.info({ id: taskId }, "任务已取消");
        return { content: `已取消任务 #${taskId}`, isError: false, directReply: `✅ 已取消任务 #${taskId}` };
      }
      return { content: `任务 #${taskId} 不存在或已完成`, isError: true };
    },
  };

  return [scheduleReminderTool, listRemindersTool, cancelReminderTool];
}

// ─────────────── 辅助函数 ───────────────

function buildConfirmText(task: ScheduledTaskRow): string {
  const parts: string[] = [`任务 #${task.id} 已创建`];

  if (task.taskType === "delay" || task.taskType === "once") {
    if (task.triggerAt) parts.push(`触发时间: ${formatTime(task.triggerAt)}`);
  } else if (task.taskType === "cron") {
    parts.push(`循环规则: ${task.cronExpr}`);
  } else if (task.taskType === "lunar") {
    parts.push(`${lunarDateText(task.lunarMonth!, task.lunarDay!)}${task.lunarRepeatYearly ? "（每年重复）" : ""}`);
    if (task.triggerAt) parts.push(`最近一次: ${formatTime(task.triggerAt)}`);
  }

  const modeLabel = task.triggerMode === "agent" ? "AI执行" : "直接提醒";
  parts.push(`触发模式: ${modeLabel}`);
  parts.push(`提醒内容: ${task.remindText}`);
  return parts.join("\n");
}

function formatTime(isoStr: string): string {
  const d = new Date(isoStr);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function validateCronExpr(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5;
}
