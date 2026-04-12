/**
 * 基于 Bottleneck 的速率限制器，实现对外部模型接口的节流。
 *
 * 本模块实现 {@link RateLimiter} 类，用于：
 * - 保护外部 API 不被超量调用
 * - 防止触发服务的速率限制
 * - 控制并发请求数量
 *
 * 支持两种限制模式：
 * - QPS 限制：每秒最大请求数，通过 `minTime` 控制
 * - 并发限制：同时进行的请求数，通过 `maxConcurrent` 控制
 *
 * @module llm/rate-limiter
 */

import Bottleneck from "bottleneck";

/**
 * 组合 QPS 与并发约束的速率限制器，用于保护外部模型接口。
 *
 * 使用方式：
 * 1. 创建限制器，配置 qps 和 maxParallel
 * 2. 调用 run() 包裹需要节流的异步任务
 * 3. 限速器负责排队、并发与启动间隔
 */
export class RateLimiter {
  private readonly limiter?: Bottleneck;

  constructor(options: { qps?: number; maxParallel?: number } = {}) {
    const minTime =
      typeof options.qps === "number" && options.qps > 0
        ? Math.ceil(1000 / options.qps)
        : undefined;
    const maxConcurrent =
      typeof options.maxParallel === "number" && options.maxParallel > 0
        ? options.maxParallel
        : undefined;

    if (minTime === undefined && maxConcurrent === undefined) {
      return;
    }

    this.limiter = new Bottleneck({
      ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
      ...(minTime !== undefined ? { minTime } : {}),
    });
  }

  async run<T>(task: () => T | PromiseLike<T>): Promise<T> {
    if (!this.limiter) {
      return task();
    }

    return this.limiter.schedule(() => Promise.resolve(task()));
  }
}
