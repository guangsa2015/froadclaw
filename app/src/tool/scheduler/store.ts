/**
 * 定时任务 DB 存储层 — 直接复用主 SqliteSessionStore 的 db 实例
 */
import type { Database, SqlValue } from "sql.js";
import type { ScheduledTaskRow, NewScheduledTask } from "./types.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("scheduler-store");

export class SchedulerStore {
  constructor(private db: Database) {
    this.initSchema();
  }

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS scheduled_task (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        description TEXT NOT NULL,
        remind_text TEXT NOT NULL,
        task_type TEXT NOT NULL,
        trigger_at TEXT,
        cron_expr TEXT,
        lunar_month INTEGER,
        lunar_day INTEGER,
        lunar_repeat_yearly INTEGER NOT NULL DEFAULT 0,
        trigger_mode TEXT NOT NULL DEFAULT 'direct',
        status TEXT NOT NULL DEFAULT 'active',
        last_triggered_at TEXT,
        next_trigger_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_sched_user ON scheduled_task(user_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_sched_status ON scheduled_task(status)");
    // 兼容旧表：如果 trigger_mode 列不存在，自动添加
    this.safeAddColumn("trigger_mode", "TEXT NOT NULL DEFAULT 'direct'");
    log.info("scheduled_task 表已就绪");
  }

  /** 安全添加列（已存在则忽略） */
  private safeAddColumn(column: string, definition: string): void {
    try {
      this.db.run(`ALTER TABLE scheduled_task ADD COLUMN ${column} ${definition}`);
    } catch {
      // 列已存在，忽略
    }
  }

  insert(task: NewScheduledTask): number {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    this.db.run(
      `INSERT INTO scheduled_task
        (user_id, chat_id, channel_type, description, remind_text, task_type,
         trigger_at, cron_expr, lunar_month, lunar_day, lunar_repeat_yearly,
         trigger_mode, status, last_triggered_at, next_trigger_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        task.userId, task.chatId, task.channelType,
        task.description, task.remindText, task.taskType,
        task.triggerAt, task.cronExpr,
        task.lunarMonth, task.lunarDay, task.lunarRepeatYearly,
        task.triggerMode, task.status, task.lastTriggeredAt, task.nextTriggerAt,
        now, now,
      ] as SqlValue[],
    );
    const row = this.queryOne<{ id: number }>("SELECT last_insert_rowid() AS id");
    return row?.id ?? 0;
  }

  getActiveTasks(): ScheduledTaskRow[] {
    return this.queryAll<ScheduledTaskRow>(
      `SELECT id, user_id AS userId, chat_id AS chatId, channel_type AS channelType,
              description, remind_text AS remindText, task_type AS taskType,
              trigger_at AS triggerAt, cron_expr AS cronExpr,
              lunar_month AS lunarMonth, lunar_day AS lunarDay,
              lunar_repeat_yearly AS lunarRepeatYearly,
              trigger_mode AS triggerMode,
              status, last_triggered_at AS lastTriggeredAt,
              next_trigger_at AS nextTriggerAt,
              created_at AS createdAt, updated_at AS updatedAt
       FROM scheduled_task WHERE status = 'active'`,
    );
  }

  getTaskById(id: number): ScheduledTaskRow | null {
    return this.queryOne<ScheduledTaskRow>(
      `SELECT id, user_id AS userId, chat_id AS chatId, channel_type AS channelType,
              description, remind_text AS remindText, task_type AS taskType,
              trigger_at AS triggerAt, cron_expr AS cronExpr,
              lunar_month AS lunarMonth, lunar_day AS lunarDay,
              lunar_repeat_yearly AS lunarRepeatYearly,
              trigger_mode AS triggerMode,
              status, last_triggered_at AS lastTriggeredAt,
              next_trigger_at AS nextTriggerAt,
              created_at AS createdAt, updated_at AS updatedAt
       FROM scheduled_task WHERE id = ?`,
      [id],
    );
  }

  getTasksByUser(userId: string): ScheduledTaskRow[] {
    return this.queryAll<ScheduledTaskRow>(
      `SELECT id, user_id AS userId, chat_id AS chatId, channel_type AS channelType,
              description, remind_text AS remindText, task_type AS taskType,
              trigger_at AS triggerAt, cron_expr AS cronExpr,
              lunar_month AS lunarMonth, lunar_day AS lunarDay,
              lunar_repeat_yearly AS lunarRepeatYearly,
              trigger_mode AS triggerMode,
              status, last_triggered_at AS lastTriggeredAt,
              next_trigger_at AS nextTriggerAt,
              created_at AS createdAt, updated_at AS updatedAt
       FROM scheduled_task WHERE user_id = ? AND status = 'active'
       ORDER BY created_at DESC`,
      [userId],
    );
  }

  markDone(id: number): void {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    this.db.run("UPDATE scheduled_task SET status = 'done', last_triggered_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
  }

  markTriggered(id: number, nextTriggerAt: string | null): void {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    this.db.run(
      "UPDATE scheduled_task SET last_triggered_at = ?, next_trigger_at = ?, updated_at = ? WHERE id = ?",
      [now, nextTriggerAt, now, id],
    );
  }

  cancel(id: number): boolean {
    const task = this.getTaskById(id);
    if (!task || task.status !== "active") return false;
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    this.db.run("UPDATE scheduled_task SET status = 'cancelled', updated_at = ? WHERE id = ?", [now, id]);
    return true;
  }

  // ── 查询辅助 ──

  private queryOne<T>(sql: string, params: SqlValue[] = []): T | null {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) {
      const row = stmt.getAsObject() as T;
      stmt.free();
      return row;
    }
    stmt.free();
    return null;
  }

  private queryAll<T>(sql: string, params: SqlValue[] = []): T[] {
    const results: T[] = [];
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    while (stmt.step()) {
      results.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return results;
  }
}
