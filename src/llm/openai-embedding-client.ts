/**
 * 实现 OpenAI 兼容嵌入客户端，支持批量请求与可选缓存。
 */

import { EmbeddingClient } from "./base.ts";
import { RateLimiter } from "./rate-limiter.ts";
import type { ClientHooks, LlmClientConfig } from "./types.ts";
import {
  ApiConnectionError,
  ApiHttpError,
  createHttpError,
  isRecord,
  joinUrl,
  retryAsync,
} from "./utils.ts";

const REQUEST_TIMEOUT_MS = 60_000;

type CacheEntry = {
  embedding: number[];
  timestamp: number;
};

/**
 * OpenAI 嵌入客户端实现，支持批量向量化与内存缓存。
 */
export class OpenAIEmbeddingClient extends EmbeddingClient {
  private readonly rateLimiter: RateLimiter;
  private readonly batchSize: number;
  private readonly cacheTtlMs?: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    config: LlmClientConfig,
    hooks?: ClientHooks,
    options: {
      batchSize?: number;
      cacheTtlMs?: number;
    } = {},
  ) {
    super(config, hooks);
    this.rateLimiter = new RateLimiter({
      qps: config.qps,
      maxParallel: config.maxParallelRequests,
    });
    this.batchSize = options.batchSize ?? 50;
    this.cacheTtlMs = options.cacheTtlMs ?? 3_600_000;
  }

  override async getEmbedding(text: string): Promise<number[]> {
    const cached = this.getFromCache(text);
    if (cached) {
      return cached;
    }

    const [embedding] = await this.requestEmbeddings([text]);
    if (!embedding) {
      throw new Error("Embedding 响应缺少首个向量");
    }

    this.saveToCache(text, embedding);
    return embedding;
  }

  override async getEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const results: Array<number[] | undefined> = new Array(texts.length);
    const pending: Array<{ index: number; text: string }> = [];

    for (const [index, text] of texts.entries()) {
      const cached = this.getFromCache(text);
      if (cached) {
        results[index] = cached;
      } else {
        pending.push({ index, text });
      }
    }

    for (let offset = 0; offset < pending.length; offset += this.batchSize) {
      const batch = pending.slice(offset, offset + this.batchSize);
      const embeddings = await this.requestEmbeddings(batch.map((item) => item.text));
      if (embeddings.length !== batch.length) {
        throw new Error("Embedding 响应数量与请求数量不一致");
      }

      for (const [batchIndex, item] of batch.entries()) {
        const embedding = embeddings[batchIndex];
        if (!embedding) {
          throw new Error("Embedding 响应缺少向量数据");
        }

        results[item.index] = embedding;
        this.saveToCache(item.text, embedding);
      }
    }

    return results.map((embedding) => {
      if (!embedding) {
        throw new Error("Embedding 结果中存在未填充项");
      }
      return embedding;
    });
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheStats(): {
    totalEntries: number;
    validEntries: number;
    cacheTtlMs?: number;
  } {
    const now = Date.now();
    let validEntries = 0;

    for (const entry of this.cache.values()) {
      if (!this.cacheTtlMs || now - entry.timestamp <= this.cacheTtlMs) {
        validEntries += 1;
      }
    }

    return {
      totalEntries: this.cache.size,
      validEntries,
      cacheTtlMs: this.cacheTtlMs,
    };
  }

  private async requestEmbeddings(texts: string[]): Promise<number[][]> {
    return retryAsync(
      async () => {
        const release = await this.rateLimiter.acquire();
        try {
          let response: Response;
          try {
            response = await fetch(joinUrl(this.config.endpoint, "/embeddings"), {
              method: "POST",
              headers: {
                Authorization: `Bearer ${this.config.apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: this.config.modelName,
                input: texts.length === 1 ? texts[0] : texts,
              }),
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
          } catch (error) {
            throw new ApiConnectionError(
              `OpenAI Embedding API 连接失败: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
          }

          if (!response.ok) {
            throw await createHttpError(response, "OpenAI Embedding API 请求失败");
          }

          const result = (await response.json()) as unknown;
          if (!isRecord(result) || !Array.isArray(result.data)) {
            throw new Error("OpenAI Embedding API 响应格式错误: 缺少 data 数组");
          }

          return result.data.map((item) => {
            if (!isRecord(item) || !Array.isArray(item.embedding)) {
              throw new Error("OpenAI Embedding API 响应格式错误: embedding 缺失");
            }

            return item.embedding.map((value) => {
              if (typeof value !== "number") {
                throw new Error("OpenAI Embedding API 响应格式错误: embedding 值必须为数字");
              }
              return value;
            });
          });
        } finally {
          release();
        }
      },
      {
        retries: this.config.retries,
        minDelayMs: 2_000,
        maxDelayMs: 10_000,
        multiplier: 2,
        shouldRetry: (error) =>
          error instanceof ApiConnectionError ||
          (error instanceof ApiHttpError &&
            (error.status === 429 || error.status >= 500)),
      },
    );
  }

  private getFromCache(text: string): number[] | undefined {
    if (!this.cacheTtlMs) {
      return undefined;
    }

    const key = createCacheKey(text);
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }

    if (Date.now() - entry.timestamp > this.cacheTtlMs) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.embedding;
  }

  private saveToCache(text: string, embedding: number[]): void {
    if (!this.cacheTtlMs) {
      return;
    }

    this.cache.set(createCacheKey(text), {
      embedding,
      timestamp: Date.now(),
    });
  }
}

function createCacheKey(text: string): string {
  return Bun.hash(text).toString(16);
}
