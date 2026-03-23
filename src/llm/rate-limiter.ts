/**
 * 提供同时约束 QPS 与并发数的速率限制器，实现对外部模型接口的节流。
 *
 * 本模块实现 {@link RateLimiter} 类，用于：
 * - 保护外部 API 不被超量调用
 * - 防止触发服务的速率限制
 * - 控制并发请求数量
 *
 * 支持两种限制模式：
 * - QPS 限制：每秒最大请求数，通过令牌间隔控制
 * - 并发限制：同时进行的请求数，通过信号量控制
 *
 * 两种限制可同时启用，acquire 方法返回释放函数。
 *
 * @module llm/rate-limiter
 */

import { sleep } from "./utils.ts";

/**
 * 组合 QPS 与并发约束的速率限制器，用于保护外部模型接口。
 *
 * 使用方式：
 * 1. 创建限制器，配置 qps 和 maxParallel
 * 2. 调用 acquire() 获取令牌，等待限制就绪
 * 3. 执行请求
 * 4. 调用返回的释放函数释放并发槽
 *
 * QPS 限制通过队列串行化保证间隔；并发限制通过计数器实现。
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
