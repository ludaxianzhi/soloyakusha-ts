import type { JsonObject, JsonValue } from "../llm/types.ts";
import { VectorStoreClient } from "./base.ts";
import { requestJson } from "./http.ts";
import type {
  VectorCollectionConfig,
  VectorCollectionInfo,
  VectorDistanceMetric,
  VectorSearchResult,
  VectorStoreCollectionDeleteParams,
  VectorStoreConfig,
  VectorStoreDeleteParams,
  VectorStoreQueryParams,
  VectorStoreUpsertParams,
} from "./types.ts";

type QdrantSearchResponse = {
  result?: Array<{
    id: string | number;
    score: number;
    payload?: Record<string, unknown>;
    vector?: number[] | { [key: string]: unknown };
  }>;
};

type QdrantCollectionsResponse = {
  result?: {
    collections?: Array<{
      name?: string;
    }>;
  };
};

type QdrantCollectionDetailResponse = {
  result?: {
    config?: {
      params?: {
        vectors?: {
          size?: number;
          distance?: string;
        };
      };
      hnsw_config?: Record<string, unknown>;
      optimizers_config?: Record<string, unknown>;
      wal_config?: Record<string, unknown>;
      quantization_config?: Record<string, unknown>;
      on_disk_payload?: boolean;
    };
  };
};

export class QdrantVectorStoreClient extends VectorStoreClient {
  constructor(config: VectorStoreConfig) {
    super(config);
  }

  override async probeConnection(): Promise<void> {
    await requestJson<void>({
      endpoint: this.config.endpoint,
      path: "collections",
      method: "GET",
      timeoutMs: this.config.timeoutMs,
      retries: this.config.retries,
      errorPrefix: "Qdrant 连接检查失败",
      headers: this.buildHeaders(),
    });
  }

  override async listCollections(): Promise<VectorCollectionInfo[]> {
    const response = await requestJson<QdrantCollectionsResponse>({
      endpoint: this.config.endpoint,
      path: "collections",
      method: "GET",
      timeoutMs: this.config.timeoutMs,
      retries: this.config.retries,
      errorPrefix: "Qdrant collection 列表获取失败",
      headers: this.buildHeaders(),
    });

    const collections = response.result?.collections ?? [];
    const result: VectorCollectionInfo[] = [];
    for (const collection of collections) {
      if (typeof collection.name !== "string" || collection.name.length === 0) {
        continue;
      }

      const detail = await requestJson<QdrantCollectionDetailResponse>({
        endpoint: this.config.endpoint,
        path: `collections/${encodeURIComponent(collection.name)}`,
        method: "GET",
        timeoutMs: this.config.timeoutMs,
        retries: this.config.retries,
        errorPrefix: `Qdrant collection 详情获取失败: ${collection.name}`,
        headers: this.buildHeaders(),
      });
      const vectorConfig = detail.result?.config?.params?.vectors;
      result.push({
        name: collection.name,
        dimension: typeof vectorConfig?.size === "number" ? vectorConfig.size : undefined,
        distance: mapQdrantDistanceFromResponse(vectorConfig?.distance),
        options: normalizeConfigObject(detail.result?.config),
      });
    }

    return result;
  }

  override async ensureCollection(collection: VectorCollectionConfig): Promise<void> {
    await requestJson<void>({
      endpoint: this.config.endpoint,
      path: `collections/${encodeURIComponent(collection.name)}`,
      method: "PUT",
      timeoutMs: this.config.timeoutMs,
      retries: this.config.retries,
      errorPrefix: "Qdrant collection 创建失败",
      headers: this.buildHeaders(),
      body: {
        vectors: {
          size: collection.dimension,
          distance: mapQdrantDistance(collection.distance ?? this.config.distance),
        },
        ...(collection.options ?? {}),
      },
    });
  }

  override async deleteCollection(params: VectorStoreCollectionDeleteParams): Promise<void> {
    await requestJson<void>({
      endpoint: this.config.endpoint,
      path: `collections/${encodeURIComponent(params.collectionName)}?timeout=${this.config.timeoutMs}`,
      method: "DELETE",
      timeoutMs: this.config.timeoutMs,
      retries: this.config.retries,
      errorPrefix: "Qdrant collection 删除失败",
      headers: this.buildHeaders(),
    });
  }

  override async upsert(params: VectorStoreUpsertParams): Promise<void> {
    await requestJson<void>({
      endpoint: this.config.endpoint,
      path: `collections/${encodeURIComponent(params.collectionName)}/points?wait=true`,
      method: "PUT",
      timeoutMs: this.config.timeoutMs,
      retries: this.config.retries,
      errorPrefix: "Qdrant 向量写入失败",
      headers: this.buildHeaders(),
      body: {
        points: params.records.map((record) => ({
          id: record.id,
          vector: record.vector,
          payload: mergeDocumentIntoPayload(record.payload, record.document),
        })),
      },
    });
  }

  override async query(params: VectorStoreQueryParams): Promise<VectorSearchResult[]> {
    const response = await requestJson<QdrantSearchResponse>({
      endpoint: this.config.endpoint,
      path: `collections/${encodeURIComponent(params.collectionName)}/points/search`,
      method: "POST",
      timeoutMs: this.config.timeoutMs,
      retries: this.config.retries,
      errorPrefix: "Qdrant 向量检索失败",
      headers: this.buildHeaders(),
      body: {
        vector: params.vector,
        limit: params.topK,
        with_payload: true,
        with_vector: params.includeVectors ?? false,
        ...(params.filter ? { filter: mapQdrantFilter(params.filter) } : {}),
      },
    });

    return (response.result ?? []).map((item) => {
      const payload = normalizePayload(item.payload);
      return {
        id: String(item.id),
        score: item.score,
        rawScore: item.score,
        payload,
        document: typeof payload?.document === "string" ? payload.document : undefined,
        vector: Array.isArray(item.vector) ? item.vector : undefined,
      };
    });
  }

  override async delete(params: VectorStoreDeleteParams): Promise<void> {
    if ((!params.ids || params.ids.length === 0) && !params.filter) {
      throw new Error("Qdrant 删除操作必须提供 ids 或 filter");
    }

    await requestJson<void>({
      endpoint: this.config.endpoint,
      path: `collections/${encodeURIComponent(params.collectionName)}/points/delete?wait=true`,
      method: "POST",
      timeoutMs: this.config.timeoutMs,
      retries: this.config.retries,
      errorPrefix: "Qdrant 向量删除失败",
      headers: this.buildHeaders(),
      body: params.ids && params.ids.length > 0
        ? { points: params.ids }
        : { filter: mapQdrantFilter(params.filter ?? {}) },
    });
  }

  private buildHeaders(): Record<string, string> {
    return {
      ...(this.config.apiKey ? { "api-key": this.config.apiKey } : {}),
      ...(this.config.extraHeaders ?? {}),
    };
  }
}

function mapQdrantDistance(metric: VectorDistanceMetric): string {
  switch (metric) {
    case "cosine":
      return "Cosine";
    case "dot":
      return "Dot";
    case "euclid":
      return "Euclid";
    case "manhattan":
      return "Manhattan";
  }
}

function mapQdrantDistanceFromResponse(metric: string | undefined): VectorDistanceMetric | undefined {
  switch (metric) {
    case "Cosine":
      return "cosine";
    case "Dot":
      return "dot";
    case "Euclid":
      return "euclid";
    case "Manhattan":
      return "manhattan";
    default:
      return undefined;
  }
}

function mapQdrantFilter(filter: JsonObject): {
  must: Array<{
    key: string;
    match: { value: string | number | boolean | null };
  }>;
} {
  return {
    must: Object.entries(filter).map(([key, value]) => ({
      key,
      match: { value: normalizeQdrantMatchValue(value, key) },
    })),
  };
}

function normalizeQdrantMatchValue(
  value: JsonValue,
  key: string,
): string | number | boolean | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  throw new Error(`Qdrant filter 暂不支持复杂值: ${key}`);
}

function mergeDocumentIntoPayload(
  payload: JsonObject | undefined,
  document: string | undefined,
): JsonObject | undefined {
  if (document === undefined) {
    return payload ? { ...payload } : undefined;
  }

  if (payload?.document !== undefined && payload.document !== document) {
    throw new Error("payload.document 与 document 字段冲突");
  }

  return {
    ...(payload ?? {}),
    document,
  };
}

function normalizePayload(payload: Record<string, unknown> | undefined): JsonObject | undefined {
  if (!payload || Array.isArray(payload)) {
    return undefined;
  }

  return payload as JsonObject;
}

function normalizeConfigObject(
  value: Record<string, unknown> | undefined,
): JsonObject | undefined {
  if (!value || Array.isArray(value)) {
    return undefined;
  }

  return value as JsonObject;
}
