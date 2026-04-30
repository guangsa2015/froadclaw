/**
 * 消息防抖 — 同一 key 下连续消息在窗口内合并
 */

export interface DebouncerOptions<T> {
  /** 防抖延迟（ms） */
  debounceMs: number;
  /** 从消息中提取分组键 */
  buildKey: (item: T) => string;
  /** 窗口结束后批量处理 */
  onFlush: (items: T[]) => Promise<void>;
}

export function createInboundDebouncer<T>(options: DebouncerOptions<T>) {
  const buffers = new Map<string, { items: T[]; timer: ReturnType<typeof setTimeout> }>();

  return {
    push(item: T): void {
      const key = options.buildKey(item);
      const existing = buffers.get(key);

      if (existing) {
        existing.items.push(item);
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => void flush(key), options.debounceMs);
      } else {
        const timer = setTimeout(() => void flush(key), options.debounceMs);
        buffers.set(key, { items: [item], timer });
      }
    },

    /** 立即刷新所有缓冲（优雅关闭时调用） */
    async flushAll(): Promise<void> {
      const keys = [...buffers.keys()];
      await Promise.all(keys.map((k) => flush(k)));
    },
  };

  async function flush(key: string): Promise<void> {
    const buf = buffers.get(key);
    if (!buf) return;
    buffers.delete(key);
    clearTimeout(buf.timer);
    await options.onFlush(buf.items);
  }
}
