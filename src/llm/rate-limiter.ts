/**
 * 提供同时约束 QPS 与并发数的速率限制器，实现对外部模型接口的节流。
 */

import { sleep } from "./utils.ts";

/**
 * 组合 QPS 与并发约束的速率限制器，用于保护外部模型接口。
 */
export class RateLimiter {
  private readonly qps?: number;
  private readonly maxParallel?: number;
  private activeCount = 0;
  private readonly parallelWaiters: Array<() => void> = [];
  private qpsLock: Promise<void> = Promise.resolve();
  private nextAvailableAt = 0;

  constructor(options: { qps?: number; maxParallel?: number } = {}) {
    this.qps = options.qps;
    this.maxParallel = options.maxParallel;
  }

  async acquire(): Promise<() => void> {
    await this.acquireParallelSlot();

    try {
      await this.acquireQpsSlot();
    } catch (error) {
      this.releaseParallelSlot();
      throw error;
    }

    let released = false;
    return () => {
      if (released) {
        return;
      }

      released = true;
      this.releaseParallelSlot();
    };
  }

  private async acquireParallelSlot(): Promise<void> {
    if (!this.maxParallel || this.maxParallel <= 0) {
      return;
    }

    if (this.activeCount < this.maxParallel) {
      this.activeCount += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.parallelWaiters.push(() => {
        this.activeCount += 1;
        resolve();
      });
    });
  }

  private releaseParallelSlot(): void {
    if (!this.maxParallel || this.maxParallel <= 0) {
      return;
    }

    this.activeCount = Math.max(0, this.activeCount - 1);
    const next = this.parallelWaiters.shift();
    next?.();
  }

  private async acquireQpsSlot(): Promise<void> {
    if (!this.qps || this.qps <= 0) {
      return;
    }

    const previousLock = this.qpsLock;
    let releaseLock!: () => void;
    this.qpsLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    await previousLock;

    try {
      const now = Date.now();
      const waitMs = Math.max(0, this.nextAvailableAt - now);
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      this.nextAvailableAt = Date.now() + Math.ceil(1000 / this.qps);
    } finally {
      releaseLock();
    }
  }
}
