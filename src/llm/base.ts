import type {
  ChatRequestOptions,
  ClientHooks,
  ErrorLogEntry,
  LlmClientConfig,
  LlmProvider,
} from "./types.ts";
import { createRequestId, getDurationSeconds } from "./utils.ts";

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

export abstract class EmbeddingClient extends ManagedLlmClient {
  abstract getEmbedding(text: string): Promise<number[]>;
  abstract getEmbeddings(texts: string[]): Promise<number[][]>;
}
