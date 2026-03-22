import { ChatClient, EmbeddingClient, ManagedLlmClient } from "./base.ts";
import { AnthropicChatClient } from "./anthropic-chat-client.ts";
import { OpenAIEmbeddingClient } from "./openai-embedding-client.ts";
import { OpenAIChatClient } from "./openai-chat-client.ts";
import type {
  ClientHooks,
  LlmClientConfig,
  LlmClientConfigInput,
} from "./types.ts";
import { createLlmClientConfig } from "./types.ts";
import { stableStringify } from "./utils.ts";

export class LlmClientProvider {
  private readonly registry = new Map<string, LlmClientConfig>();
  private readonly instances = new Map<string, ManagedLlmClient>();
  private historyLogger?: ClientHooks["historyLogger"];
  private requestObserver?: ClientHooks["requestObserver"];

  constructor(hooks: ClientHooks = {}) {
    this.historyLogger = hooks.historyLogger;
    this.requestObserver = hooks.requestObserver;
  }

  setHistoryLogger(historyLogger?: ClientHooks["historyLogger"]): void {
    this.historyLogger = historyLogger;
    this.syncHooksToInstances();
  }

  setRequestObserver(requestObserver?: ClientHooks["requestObserver"]): void {
    this.requestObserver = requestObserver;
    this.syncHooksToInstances();
  }

  register(name: string, configInput: LlmClientConfigInput | LlmClientConfig): void {
    const config = isResolvedConfig(configInput)
      ? configInput
      : createLlmClientConfig(configInput);
    this.registry.set(name, config);
  }

  registerMany(
    configs: Record<string, LlmClientConfigInput | LlmClientConfig>,
  ): void {
    for (const [name, config] of Object.entries(configs)) {
      this.register(name, config);
    }
  }

  getClient(name: string): ChatClient | EmbeddingClient {
    const config = this.registry.get(name);
    if (!config) {
      throw new Error(`未找到名为 '${name}' 的 LLM 客户端配置。请先注册。`);
    }

    const cacheKey = stableStringify(config);
    const existingClient = this.instances.get(cacheKey);
    if (existingClient) {
      return existingClient as ChatClient | EmbeddingClient;
    }

    const createdClient = this.createClient(config);
    this.instances.set(cacheKey, createdClient);
    return createdClient;
  }

  getChatClient(name: string): ChatClient {
    const client = this.getClient(name);
    if (!(client instanceof ChatClient)) {
      throw new Error(`客户端 '${name}' 不是 chat 类型`);
    }

    return client;
  }

  getEmbeddingClient(name: string): EmbeddingClient {
    const client = this.getClient(name);
    if (!(client instanceof EmbeddingClient)) {
      throw new Error(`客户端 '${name}' 不是 embedding 类型`);
    }

    return client;
  }

  async closeAll(): Promise<void> {
    await Promise.all(Array.from(this.instances.values(), (client) => client.close()));
    this.instances.clear();
  }

  private createClient(config: LlmClientConfig): ChatClient | EmbeddingClient {
    const hooks: ClientHooks = {
      historyLogger: this.historyLogger,
      requestObserver: this.requestObserver,
    };

    if (config.modelType === "chat") {
      if (config.provider === "openai") {
        return new OpenAIChatClient(config, hooks);
      }

      if (config.provider === "anthropic") {
        return new AnthropicChatClient(config, hooks);
      }

      throw new Error(`不支持的 Chat Provider: ${config.provider}`);
    }

    if (config.modelType === "embedding") {
      if (config.provider === "openai") {
        return new OpenAIEmbeddingClient(config, hooks);
      }

      throw new Error(`不支持的 Embedding Provider: ${config.provider}`);
    }

    throw new Error(`不支持的模型类型(modelType): ${config.modelType}`);
  }

  private syncHooksToInstances(): void {
    for (const client of this.instances.values()) {
      client.setHistoryLogger(this.historyLogger);
      client.setRequestObserver(this.requestObserver);
    }
  }
}

export function createProviderFromConfigs(
  configs: Record<string, LlmClientConfigInput | LlmClientConfig>,
  hooks?: ClientHooks,
): LlmClientProvider {
  const provider = new LlmClientProvider(hooks);
  provider.registerMany(configs);
  return provider;
}

function isResolvedConfig(
  value: LlmClientConfigInput | LlmClientConfig,
): value is LlmClientConfig {
  return "apiKey" in value && typeof value.apiKey === "string";
}
