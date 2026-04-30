/**
 * 定时任务调度引擎
 *
 * 职责：
 *   1. 启动时从 DB 加载所有 active 任务并注册定时器
 *   2. 新增任务时写 DB + 注册定时器
 *   3. 触发时通过 Channel.send() 发消息
 *   4. 进程重启自动恢复
 */
import cron from "node-cron";
import type { Channel, OutboundMessage, InboundMessage } from "../../channel/types.js";
import type { ScheduledTaskRow, NewScheduledTask } from "./types.js";
import { SchedulerStore } from "./store.js";
import { isTodayLunar, nextLunarDate, lunarDateText } from "./lunar-util.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("scheduler");

/** 过期容忍窗口：重启后如果 once/delay 过期不超过此时间则补发 */
const EXPIRED_TOLERANCE_MS = 5 * 60_000;

/**
 * agent 模式触发回调：接收合成的 InboundMessage，重新走 Agent Loop
 * 由 index.ts 装配时注入 router.onInboundMessage
 */
export type AgentTriggerCallback = (msg: InboundMessage) => void;

export interface SchedulerDeps {
  store: SchedulerStore;
  channelMap: Map<string, Channel>;
}

export class SchedulerService {
  private store: SchedulerStore;
  private channelMap: Map<string, Channel>;
  /** 内存定时器：taskId → clearFn */
  private timers = new Map<number, () => void>();
  /** 农历每日检查 cron job */
  private lunarCronJob: cron.ScheduledTask | null = null;
  /** agent 模式回调（延迟注入，解决循环依赖） */
  private agentTriggerCallback: AgentTriggerCallback | null = null;

  constructor(deps: SchedulerDeps) {
    this.store = deps.store;
    this.channelMap = deps.channelMap;
  }

  /** 注册 agent 模式触发回调（由 index.ts 在 router 创建后调用） */
  setAgentTriggerCallback(cb: AgentTriggerCallback): void {
    this.agentTriggerCallback = cb;
    log.info("agent 触发回调已注册");
  }

  /** 启动调度引擎：加载并恢复所有 active 任务 */
  start(): void {
    const tasks = this.store.getActiveTasks();
    let registered = 0;
    let expired = 0;

    for (const task of tasks) {
      if (task.taskType === "delay" || task.taskType === "once") {
        const triggerMs = task.triggerAt ? new Date(task.triggerAt).getTime() : 0;
        const delayMs = triggerMs - Date.now();

        if (delayMs <= 0) {
          // 已过期
          if (-delayMs <= EXPIRED_TOLERANCE_MS) {
            // 过期不超过5分钟，补发
            log.info({ id: task.id, type: task.taskType }, "补发过期任务");
            void this.triggerTask(task);
          } else {
            // 过期太久，标记完成
            log.info({ id: task.id, expired: -delayMs }, "任务过期太久，标记完成");
            this.store.markDone(task.id);
          }
          expired++;
        } else {
          this.registerTimeout(task, delayMs);
          registered++;
        }
      } else if (task.taskType === "cron") {
        this.registerCron(task);
        registered++;
      } else if (task.taskType === "lunar") {
        // 农历任务由统一的每日检查处理
        registered++;
      }
    }

    // 注册农历每日检查：每天 00:01 执行
    this.startLunarDailyCheck();

    log.info({ total: tasks.length, registered, expired }, "调度引擎启动，已加载 %d 个任务", tasks.length);
  }

  /** 创建新任务 */
  addTask(task: NewScheduledTask): ScheduledTaskRow {
    const id = this.store.insert(task);
    const saved = this.store.getTaskById(id)!;
    log.info({ id, type: task.taskType, remind: task.remindText }, "创建定时任务 #%d", id);

    // 注册定时器
    if (task.taskType === "delay" || task.taskType === "once") {
      const triggerMs = task.triggerAt ? new Date(task.triggerAt).getTime() : 0;
      const delayMs = Math.max(triggerMs - Date.now(), 1000);
      this.registerTimeout(saved, delayMs);
    } else if (task.taskType === "cron") {
      this.registerCron(saved);
    }
    // lunar 由每日检查自动覆盖

    return saved;
  }

  /** 取消任务 */
  cancelTask(taskId: number): boolean {
    const clearFn = this.timers.get(taskId);
    if (clearFn) {
      clearFn();
      this.timers.delete(taskId);
    }
    return this.store.cancel(taskId);
  }

  /** 查询用户的活跃任务 */
  listUserTasks(userId: string): ScheduledTaskRow[] {
    return this.store.getTasksByUser(userId);
  }

  /** 停止所有定时器 */
  stop(): void {
    for (const [id, clearFn] of this.timers) {
      clearFn();
      log.debug({ id }, "清除定时器");
    }
    this.timers.clear();
    this.lunarCronJob?.stop();
    log.info("调度引擎已停止");
  }

  // ────────── 内部方法 ──────────

  private registerTimeout(task: ScheduledTaskRow, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(task.id);
      void this.triggerTask(task);
    }, delayMs);

    // 防止 timer 阻止进程退出
    timer.unref();

    this.timers.set(task.id, () => clearTimeout(timer));
    log.debug({ id: task.id, delayMs }, "注册 setTimeout %dms", delayMs);
  }

  private registerCron(task: ScheduledTaskRow): void {
    if (!task.cronExpr) return;

    const job = cron.schedule(task.cronExpr, () => {
      void this.triggerTask(task);
    }, { timezone: "Asia/Shanghai" });

    this.timers.set(task.id, () => job.stop());
    log.debug({ id: task.id, cron: task.cronExpr }, "注册 cron 任务");
  }

  private startLunarDailyCheck(): void {
    // 每天 00:01 检查当天是否有农历任务匹配
    this.lunarCronJob = cron.schedule("1 0 * * *", () => {
      const tasks = this.store.getActiveTasks().filter(t => t.taskType === "lunar");
      for (const task of tasks) {
        if (task.lunarMonth != null && task.lunarDay != null && isTodayLunar(task.lunarMonth, task.lunarDay)) {
          log.info({ id: task.id, lunar: lunarDateText(task.lunarMonth, task.lunarDay) }, "农历任务匹配");
          void this.triggerTask(task);
        }
      }
    }, { timezone: "Asia/Shanghai" });
    this.lunarCronJob.start();
  }

  private async triggerTask(task: ScheduledTaskRow): Promise<void> {
    log.info(
      { id: task.id, type: task.taskType, chatId: task.chatId, triggerMode: task.triggerMode },
      "触发任务 #%d [%s]: %s", task.id, task.triggerMode, task.remindText,
    );

    try {
      const channel = this.channelMap.get(task.channelType);
      if (!channel) {
        log.error({ channelType: task.channelType }, "渠道不存在，无法发送提醒");
        return;
      }

      if (task.triggerMode === "agent" && this.agentTriggerCallback) {
        // ── agent 模式：构造合成消息，重新进入 Agent Loop ──
        const syntheticMsg: InboundMessage = {
          messageId: `sched-${task.id}-${Date.now()}`,
          channelType: task.channelType,
          chatId: task.chatId,
          senderId: task.userId,
          senderName: "scheduler",
          content: `[定时任务 #${task.id} 触发] ${task.description}\n请根据任务描述执行相应操作，并将结果回复给我。`,
          mentionBot: true,
          isGroup: false,
          receivedAt: new Date(),
        };
        log.info({ id: task.id }, "agent 模式：合成消息进入 Agent Loop");
        this.agentTriggerCallback(syntheticMsg);
      } else {
        // ── direct 模式：直接发送提醒文本 ──
        const msg: OutboundMessage = {
          chatId: task.chatId,
          content: `⏰ 定时提醒：${task.remindText}`,
        };
        await channel.send(msg);
      }

      // 更新状态
      if (task.taskType === "delay" || task.taskType === "once") {
        this.store.markDone(task.id);
      } else if (task.taskType === "cron") {
        this.store.markTriggered(task.id, null);
      } else if (task.taskType === "lunar") {
        if (task.lunarRepeatYearly) {
          const nextDate = nextLunarDate(task.lunarMonth!, task.lunarDay!);
          this.store.markTriggered(task.id, nextDate);
        } else {
          this.store.markDone(task.id);
        }
      }
    } catch (err) {
      log.error({ err, id: task.id }, "任务触发失败");
    }
  }
}
