/**
 * 按 key 隔离的串行执行队列
 * 同一 key 下的任务严格 FIFO；不同 key 之间完全并行
 */

type Task<T> = {
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

export class KeyedQueue {
  private queues = new Map<string, Task<unknown>[]>();
  private running = new Set<string>();

  async enqueue<T>(key: string, execute: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: Task<T> = { execute, resolve, reject };

      if (!this.queues.has(key)) {
        this.queues.set(key, []);
      }
      this.queues.get(key)!.push(task as Task<unknown>);

      if (!this.running.has(key)) {
        void this.drain(key);
      }
    });
  }

  /** 当前某 key 是否有任务在执行 */
  isActive(key: string): boolean {
    return this.running.has(key);
  }

  private async drain(key: string): Promise<void> {
    this.running.add(key);

    const queue = this.queues.get(key)!;
    while (queue.length > 0) {
      const task = queue.shift()!;
      try {
        const result = await task.execute();
        task.resolve(result);
      } catch (err) {
        task.reject(err);
      }
    }

    this.running.delete(key);
    this.queues.delete(key);
  }
}
