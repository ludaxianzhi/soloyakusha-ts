/**
 * 集中管理多个 LLM 客户端配置与实例生命周期，并向外提供统一访问入口。
 *
 * 本模块提供 {@link LlmClientProvider} 类，用于：
 * - 注册命名配置（支持批量注册）
 * - 按名称获取客户端实例（自动缓存）
 * - 统一设置日志记录器与请求观测器
 *
 * 配置注册后可通过 getChatClient / getEmbeddingClient 获取对应类型客户端。
 * 相同配置的多次获取会返回同一实例。
 *
 * @module llm/provider
 */

import { ChatClient, EmbeddingClient, ManagedLlmClient } from "./base.ts";
import { AnthropicChatClient } from "./anthropic-chat-client.ts";
import {
  FallbackChatClient,
  type FallbackChatClientOptions,
} from "./fallback-chat-client.ts";
import { OpenAIEmbeddingClient } from "./openai-embedding-client.ts";
import { OpenAIChatClient } from "./openai-chat-client.ts";
import type {
  ClientHooks,
  LlmClientConfig,
  LlmClientConfigInput,
} from "./types.ts";
import { createLlmClientConfig } from "./types.ts";
import { stableStringify } from "./utils.ts";

/**
 * LLM 客户端提供器，集中管理命名配置、实例缓存和请求观测挂钩。
 *
 * 使用方式：
 * 1. 创建提供器实例（可选传入钩子）
 * 2. 注册客户端配置（register 或 registerMany）
 * 3. 按名称获取客户端（getClient、getChatClient、getEmbeddingClient）
 *
 * 客户端实例按配置内容缓存，相同配置的多次获取返回同一实例。
 * 钩子可通过 setHistoryLogger / setRequestObserver 动态更新，已创建的客户端会同步更新。
 */
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

  getChatClientWithFallback(
    names: ReadonlyArray<string>,
    options: FallbackChatClientOptions = {},
  ): ChatClient {
    if (names.length === 0) {
      throw new Error("模型回退链不能为空");
    }

    const clients = names.map((name) => this.getChatClient(name));
    if (clients.length === 1) {
      return clients[0];
    }

    return new FallbackChatClient(clients, {
      historyLogger: this.historyLogger,
      requestObserver: this.requestObserver,
      ...options,
    });
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
