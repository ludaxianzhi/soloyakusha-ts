import type { JsonObject } from "../llm/types.ts";

export type VectorStoreProviderName = "qdrant" | "chroma" | "sqlite-memory";

export type VectorDistanceMetric = "cosine" | "dot" | "euclid" | "manhattan";

export type VectorStoreConfig = {
  provider: VectorStoreProviderName;
  endpoint: string;
  apiKey?: string;
  defaultCollection?: string;
  distance: VectorDistanceMetric;
  timeoutMs: number;
  retries: number;
  extraHeaders?: Record<string, string>;
  options?: JsonObject;
};

export type VectorStoreConfigInput = {
  provider: VectorStoreProviderName;
  endpoint: string;
  apiKey?: string;
  apiKeyEnv?: string;
  defaultCollection?: string;
  distance?: VectorDistanceMetric;
  timeoutMs?: number;
  retries?: number;
  extraHeaders?: Record<string, string>;
  options?: JsonObject;
};

export type VectorCollectionConfig = {
  name: string;
  dimension: number;
  distance?: VectorDistanceMetric;
  metadata?: JsonObject;
  options?: JsonObject;
};

export type VectorRecord = {
  id: string;
  vector: number[];
  payload?: JsonObject;
  document?: string;
};

export type TextVectorRecordInput = {
  id: string;
  text: string;
  payload?: JsonObject;
  document?: string;
};

export type VectorStoreUpsertParams = {
  collectionName: string;
  records: VectorRecord[];
};

export type VectorStoreQueryParams = {
  collectionName: string;
  vector: number[];
  topK: number;
  filter?: JsonObject;
  includeVectors?: boolean;
};

export type VectorStoreDeleteParams = {
  collectionName: string;
  ids?: string[];
  filter?: JsonObject;
};

export type VectorSearchResult = {
  id: string;
  score: number;
  rawScore?: number;
  payload?: JsonObject;
  document?: string;
  vector?: number[];
};

export type TextSearchParams = {
  collectionName?: string;
  text: string;
  topK: number;
  filter?: JsonObject;
  includeVectors?: boolean;
};

export type VectorSearchParams = {
  collectionName?: string;
  vector: number[];
  topK: number;
  filter?: JsonObject;
  includeVectors?: boolean;
};

export type TextUpsertParams = {
  collectionName?: string;
  records: TextVectorRecordInput[];
};

export type VectorUpsertParams = {
  collectionName?: string;
  records: VectorRecord[];
};

const DEFAULT_TIMEOUT_MS = 60_000;

export function createVectorStoreConfig(
  input: VectorStoreConfigInput,
): VectorStoreConfig {
  if (input.apiKey && input.apiKeyEnv) {
    throw new Error("apiKey 和 apiKeyEnv 只能配置其中一个");
  }

  const apiKey = input.apiKey ?? readEnvApiKey(input.apiKeyEnv);
  return {
    provider: input.provider,
    endpoint: input.endpoint,
    apiKey,
    defaultCollection: input.defaultCollection,
    distance: input.distance ?? "cosine",
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retries: input.retries ?? 3,
    extraHeaders: input.extraHeaders
      ? { ...input.extraHeaders }
      : undefined,
    options: input.options ? cloneJsonObject(input.options) : undefined,
  };
}

function readEnvApiKey(apiKeyEnv?: string): string | undefined {
  if (!apiKeyEnv) {
    return undefined;
  }

  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(`环境变量 ${apiKeyEnv} 未设置`);
  }

  return apiKey;
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
