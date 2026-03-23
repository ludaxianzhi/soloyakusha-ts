/**
 * 提供受管 LLM 客户端的抽象基类，统一配置、观测与历史记录钩子。
 *
 * 本模块定义 LLM 客户端的继承体系：
 * - {@link ManagedLlmClient}: 受管基类，持有配置与钩子
 * - {@link ChatClient}: 聊天客户端基类，定义单轮请求接口
 * - {@link EmbeddingClient}: 嵌入客户端基类，定义向量化接口
 *
 * 所有客户端实现都继承自 ManagedLlmClient，共享：
 * - 配置解析与默认值处理
 * - 请求日志记录钩子
 * - 进度观测钩子
 *
 * @module llm/base
 */

import type {
  ChatRequestOptions,
  ClientHooks,
  ErrorLogEntry,
  LlmClientConfig,
  LlmProvider,
} from "./types.ts";
import { createRequestId, getDurationSeconds } from "./utils.ts";

/**
 * 受管 LLM 客户端基类，统一配置持有、日志记录与请求观测钩子。
 *
 * 所有 LLM 客户端都继承此类，获得：
 * - 配置访问（modelName、endpoint 等）
 * - 历史日志记录器注入
 * - 请求进度观测器注入
 * - 资源释放钩子
 */
export abstract class ManagedLlmClient {
  protected historyLogger?: ClientHooks["historyLogger"];
  protected requestObserver?: ClientHooks["requestObserver"];

  protected constructor(
    public readonly config: LlmClientConfig,
    hooks: ClientHooks = {},
  ) {
    this.historyLogger = hooks.historyLogger;
    this.requestObserver = hooks.requestObserver;
  }

  get modelName(): string {
    return this.config.modelName;
  }

  setHistoryLogger(historyLogger?: ClientHooks["historyLogger"]): void {
    this.historyLogger = historyLogger;
  }

  setRequestObserver(requestObserver?: ClientHooks["requestObserver"]): void {
    this.requestObserver = requestObserver;
  }

  async close(): Promise<void> {}
}

/**
 * 聊天客户端抽象基类，封装单轮请求、多结果请求与通用生命周期管理。
 *
 * 提供核心方法：
 * - {@link singleTurnRequest}: 执行单轮聊天请求，返回补全文本
 * - {@link multipleResultsRequest}: 并行执行多次请求，返回多个候选结果
 *
 * 子类需要实现 singleTurnRequest，享受：
 * - 请求启动通知（触发 onRequestStart）
 * - 失败日志记录（调用 logFailure）
 */
export abstract class ChatClient extends ManagedLlmClient {
  abstract singleTurnRequest(
    prompt: string,
    options?: ChatRequestOptions,
  ): Promise<string>;

  async multipleResultsRequest(
    prompt: string,
    count: number,
    options: ChatRequestOptions = {},
  ): Promise<string[]> {
    if (count <= 0) {
      return [];
    }

    return Promise.all(
      Array.from({ length: count }, () => this.singleTurnRequest(prompt, options)),
    );
  }

  protected startRequest(provider: LlmProvider): {
    requestId: string;
    startedAt: number;
  } {
    const requestId = createRequestId();
    this.requestObserver?.onRequestStart?.({
      requestId,
      provider,
      modelName: this.config.modelName,
    });

    return {
      requestId,
      startedAt: performance.now(),
    };
  }

  protected async logFailure(
    prompt: string,
    requestId: string,
    startedAt: number,
    error: unknown,
    options: ChatRequestOptions,
    responseBody?: string,
  ): Promise<void> {
    const errorMessage =
      error instanceof Error ? error.message : `未知错误: ${String(error)}`;

    const entry: ErrorLogEntry = {
      prompt,
      errorMessage,
      requestId,
      requestConfig: options.requestConfig
        ? {
            ...options.requestConfig,
          }
        : undefined,
      modelName: this.config.modelName,
      durationSeconds: getDurationSeconds(startedAt),
      responseBody,
    };

    await this.historyLogger?.logError(entry);
    this.requestObserver?.onRequestError?.({
      requestId,
      errorMessage,
    });
  }
}

/**
 * 嵌入客户端抽象基类，约定文本向量化能力的公共接口。
 *
 * 提供两个向量化方法：
 * - {@link getEmbedding}: 单文本嵌入，返回单个向量
 * - {@link getEmbeddings}: 批量文本嵌入，返回向量数组
 *
 * 子类需要实现这两个方法，通常包含：
 * - 批量请求优化
 * - 结果缓存
 */
export abstract class EmbeddingClient extends ManagedLlmClient {
  abstract getEmbedding(text: string): Promise<number[]>;
  abstract getEmbeddings(texts: string[]): Promise<number[][]>;
}
