/**
 * 每用户请求限流 — 滑动窗口计数器
 */
export class RateLimiter {
  /** userId → 时间戳队列 */
  private windows = new Map<string, number[]>();

  constructor(
    private maxPerMinute: number,
    private maxConcurrentGlobal: number,
  ) {}

  private activeConcurrent = 0;

  /** 检查是否允许请求，返回需等待秒数（0=允许） */
  check(userId: string): number {
    // 全局并发检查
    if (this.activeConcurrent >= this.maxConcurrentGlobal) {
      return 5;
    }

    const now = Date.now();
    const window = this.windows.get(userId) ?? [];

    // 清理 1 分钟前的记录
    const cutoff = now - 60_000;
    const recent = window.filter((ts) => ts > cutoff);

    if (recent.length >= this.maxPerMinute) {
      const oldestInWindow = recent[0]!;
      const waitMs = oldestInWindow + 60_000 - now;
      return Math.ceil(waitMs / 1000);
    }

    recent.push(now);
    this.windows.set(userId, recent);
    return 0;
  }

  acquire(): void {
    this.activeConcurrent++;
  }

  release(): void {
    this.activeConcurrent = Math.max(0, this.activeConcurrent - 1);
  }
}
