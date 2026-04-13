import { ChatClient } from "./base.ts";
import type { ChatRequestOptions, ClientHooks } from "./types.ts";

export type FallbackChatClientLogger = {
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
};

export type FallbackChatClientOptions = {
  logger?: FallbackChatClientLogger;
};

export class FallbackChatClient extends ChatClient {
  readonly modelNames: ReadonlyArray<string>;
  private readonly logger?: FallbackChatClientLogger;
  private readonly clients: ReadonlyArray<ChatClient>;

  constructor(
    clients: ReadonlyArray<ChatClient>,
    hooksOrOptions: ClientHooks & FallbackChatClientOptions = {},
  ) {
    const [firstClient] = clients;
    if (!firstClient) {
      throw new Error("创建 FallbackChatClient 时至少需要一个 ChatClient");
    }

    super(
      {
        ...firstClient.config,
        modelName: clients.map((client) => client.modelName).join(" -> "),
      },
      hooksOrOptions,
    );
    this.clients = [...clients];
    this.modelNames = this.clients.map((client) => client.modelName);
    this.logger = hooksOrOptions.logger;
    this.syncHooksToClients();
  }

  override setHistoryLogger(historyLogger?: ClientHooks["historyLogger"]): void {
    super.setHistoryLogger(historyLogger);
    this.syncHooksToClients();
  }

  override setRequestObserver(requestObserver?: ClientHooks["requestObserver"]): void {
    super.setRequestObserver(requestObserver);
    this.syncHooksToClients();
  }

  override async singleTurnRequest(
    prompt: string,
    options: ChatRequestOptions = {},
  ): Promise<string> {
    const errors: Error[] = [];

    for (const [index, client] of this.clients.entries()) {
      try {
        return await client.singleTurnRequest(prompt, options);
      } catch (error) {
        const normalized = normalizeFallbackError(error);
        errors.push(normalized);

        const nextClient = this.clients[index + 1];
        if (!nextClient) {
          break;
        }

        this.logger?.warn?.("模型请求失败，准备切换到回退模型", {
          failedModel: client.modelName,
          nextModel: nextClient.modelName,
          attempt: index + 1,
          totalModels: this.clients.length,
          error: normalized.message,
        });
      }
    }

    throw buildExhaustedFallbackError(this.modelNames, errors);
  }

  override async close(): Promise<void> {
    const uniqueClients = new Set(this.clients);
    await Promise.all(Array.from(uniqueClients, (client) => client.close()));
  }

  override get supportsStructuredOutput(): boolean {
    return this.clients.every((client) => client.supportsStructuredOutput);
  }

  private syncHooksToClients(): void {
    for (const client of this.clients) {
      client.setHistoryLogger(this.historyLogger);
      client.setRequestObserver(this.requestObserver);
    }
  }
}

function normalizeFallbackError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function buildExhaustedFallbackError(
  modelNames: ReadonlyArray<string>,
  errors: ReadonlyArray<Error>,
): Error {
  const attempts = modelNames.map((modelName, index) => {
    const reason = errors[index]?.message ?? "未知错误";
    return `${modelName}: ${reason}`;
  });

  return new Error(`模型回退链全部失败：${attempts.join(" | ")}`);
}
