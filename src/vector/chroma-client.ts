import type { JsonObject } from "../llm/types.ts";
import { VectorStoreClient } from "./base.ts";
import { requestJson } from "./http.ts";
import type {
  VectorCollectionConfig,
  VectorDistanceMetric,
  VectorSearchResult,
  VectorStoreConfig,
  VectorStoreDeleteParams,
  VectorStoreQueryParams,
  VectorStoreUpsertParams,
} from "./types.ts";

type ChromaQueryResponse = {
  ids?: string[][];
  distances?: number[][];
  metadatas?: Array<Array<Record<string, unknown> | null>>;
  documents?: Array<Array<string | null>>;
  embeddings?: Array<Array<number[] | null>>;
};

export class ChromaVectorStoreClient extends VectorStoreClient {
  constructor(config: VectorStoreConfig) {
    super(config);
  }

  override async probeConnection(): Promise<void> {
    await requestJson<void>({
      endpoint: this.config.endpoint,
      path: buildChromaPath(this.config.endpoint, "collections"),
      method: "GET",
      timeoutMs: this.config.timeoutMs,
      retries: this.config.retries,
      errorPrefix: "Chroma 连接检查失败",
      headers: this.buildHeaders(),
    });
  }

  override async ensureCollection(collection: VectorCollectionConfig): Promise<void> {
    const metadata = {
      ...(collection.metadata ?? {}),
      ...(collection.distance
        ? { "hnsw:space": mapChromaDistance(collection.distance) }
        : {}),
    };

    await requestJson<void>({
      endpoint: this.config.endpoint,
      path: buildChromaPath(this.config.endpoint, "collections"),
      method: "POST",
      timeoutMs: this.config.timeoutMs,
      retries: this.config.retries,
      errorPrefix: "Chroma collection 创建失败",
      headers: this.buildHeaders(),
      body: {
        name: collection.name,
        get_or_create: true,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        ...(collection.options ?? {}),
      },
    });
  }

  override async upsert(params: VectorStoreUpsertParams): Promise<void> {
    const records = params.records;
    const hasDocuments = records.some((record) => record.document !== undefined);
    const hasPayload = records.some((record) => record.payload !== undefined);

    await requestJson<void>({
      endpoint: this.config.endpoint,
      path: buildChromaPath(
        this.config.endpoint,
        `collections/${encodeURIComponent(params.collectionName)}/upsert`,
      ),
      method: "POST",
      timeoutMs: this.config.timeoutMs,
      retries: this.config.retries,
      errorPrefix: "Chroma 向量写入失败",
      headers: this.buildHeaders(),
      body: {
        ids: records.map((record) => record.id),
        embeddings: records.map((record) => record.vector),
        ...(hasDocuments
          ? { documents: records.map((record) => record.document ?? null) }
          : {}),
        ...(hasPayload
          ? { metadatas: records.map((record) => record.payload ?? null) }
          : {}),
      },
    });
  }

  override async query(params: VectorStoreQueryParams): Promise<VectorSearchResult[]> {
    const response = await requestJson<ChromaQueryResponse>({
      endpoint: this.config.endpoint,
      path: buildChromaPath(
        this.config.endpoint,
        `collections/${encodeURIComponent(params.collectionName)}/query`,
      ),
      method: "POST",
      timeoutMs: this.config.timeoutMs,
      retries: this.config.retries,
      errorPrefix: "Chroma 向量检索失败",
      headers: this.buildHeaders(),
      body: {
        query_embeddings: [params.vector],
        n_results: params.topK,
        ...(params.filter ? { where: params.filter } : {}),
        ...(params.includeVectors ? { include: ["metadatas", "documents", "distances", "embeddings"] } : {}),
      },
    });

    const ids = response.ids?.[0] ?? [];
    const distances = response.distances?.[0] ?? [];
    const metadatas = response.metadatas?.[0] ?? [];
    const documents = response.documents?.[0] ?? [];
    const embeddings = response.embeddings?.[0] ?? [];

    return ids.map((id, index) => {
      const rawScore = distances[index];
      const payload = normalizePayload(metadatas[index] ?? undefined);
      const document = documents[index] ?? undefined;
      const vector = embeddings[index] ?? undefined;
      return {
        id,
        score: rawScore === undefined ? 0 : 1 / (1 + rawScore),
        rawScore,
        payload,
        document: typeof document === "string" ? document : undefined,
        vector: Array.isArray(vector) ? vector : undefined,
      };
    });
  }

  override async delete(params: VectorStoreDeleteParams): Promise<void> {
    if ((!params.ids || params.ids.length === 0) && !params.filter) {
      throw new Error("Chroma 删除操作必须提供 ids 或 filter");
    }

    await requestJson<void>({
      endpoint: this.config.endpoint,
      path: buildChromaPath(
        this.config.endpoint,
        `collections/${encodeURIComponent(params.collectionName)}/delete`,
      ),
      method: "POST",
      timeoutMs: this.config.timeoutMs,
      retries: this.config.retries,
      errorPrefix: "Chroma 向量删除失败",
      headers: this.buildHeaders(),
      body: {
        ...(params.ids && params.ids.length > 0 ? { ids: params.ids } : {}),
        ...(params.filter ? { where: params.filter } : {}),
      },
    });
  }

  private buildHeaders(): Record<string, string> {
    return {
      ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      ...(this.config.extraHeaders ?? {}),
    };
  }
}

function buildChromaPath(endpoint: string, path: string): string {
  const pathname = new URL(endpoint).pathname;
  const normalizedPath = path.replace(/^\/+/, "");
  return /\/api\/v\d+/.test(pathname)
    ? normalizedPath
    : `api/v1/${normalizedPath}`;
}

function mapChromaDistance(metric: VectorDistanceMetric): string {
  switch (metric) {
    case "cosine":
      return "cosine";
    case "dot":
      return "ip";
    case "euclid":
      return "l2";
    case "manhattan":
      throw new Error("Chroma 当前不支持 manhattan 距离");
  }
}

function normalizePayload(payload: Record<string, unknown> | undefined): JsonObject | undefined {
  if (!payload || Array.isArray(payload)) {
    return undefined;
  }

  return payload as JsonObject;
}
