import { stableStringify } from "../llm/utils.ts";
import { SqliteMemoryVectorStoreClient } from "./sqlite-memory-client.ts";
import { VectorStoreClient } from "./base.ts";
import { ChromaVectorStoreClient } from "./chroma-client.ts";
import { QdrantVectorStoreClient } from "./qdrant-client.ts";
import {
  createVectorStoreConfig,
  type VectorStoreConfig,
  type VectorStoreConfigInput,
} from "./types.ts";

export class VectorStoreClientProvider {
  private readonly registry = new Map<string, VectorStoreConfig>();
  private readonly instances = new Map<string, VectorStoreClient>();

  register(name: string, configInput: VectorStoreConfigInput | VectorStoreConfig): void {
    const config = isResolvedConfig(configInput)
      ? configInput
      : createVectorStoreConfig(configInput);
    this.registry.set(name, config);
  }

  registerMany(configs: Record<string, VectorStoreConfigInput | VectorStoreConfig>): void {
    for (const [name, config] of Object.entries(configs)) {
      this.register(name, config);
    }
  }

  getClient(name: string): VectorStoreClient {
    const config = this.registry.get(name);
    if (!config) {
      throw new Error(`未找到名为 '${name}' 的向量数据库配置。请先注册。`);
    }

    const cacheKey = stableStringify(config);
    const existing = this.instances.get(cacheKey);
    if (existing) {
      return existing;
    }

    const created = this.createClient(config);
    this.instances.set(cacheKey, created);
    return created;
  }

  async closeAll(): Promise<void> {
    await Promise.all(Array.from(this.instances.values(), (client) => client.close()));
    this.instances.clear();
  }

  private createClient(config: VectorStoreConfig): VectorStoreClient {
    switch (config.provider) {
      case "qdrant":
        return new QdrantVectorStoreClient(config);
      case "chroma":
        return new ChromaVectorStoreClient(config);
      case "sqlite-memory":
        return new SqliteMemoryVectorStoreClient(config);
    }
  }
}

export function createVectorStoreProviderFromConfigs(
  configs: Record<string, VectorStoreConfigInput | VectorStoreConfig>,
): VectorStoreClientProvider {
  const provider = new VectorStoreClientProvider();
  provider.registerMany(configs);
  return provider;
}

function isResolvedConfig(
  value: VectorStoreConfigInput | VectorStoreConfig,
): value is VectorStoreConfig {
  return (
    "timeoutMs" in value &&
    typeof value.timeoutMs === "number" &&
    !("apiKeyEnv" in value)
  );
}
