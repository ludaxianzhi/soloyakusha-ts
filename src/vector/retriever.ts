import type { EmbeddingClient } from "../llm/base.ts";
import { VectorStoreClient } from "./base.ts";
import type {
  TextSearchParams,
  TextUpsertParams,
  VectorCollectionConfig,
  VectorSearchParams,
  VectorSearchResult,
  VectorStoreDeleteParams,
  VectorUpsertParams,
} from "./types.ts";

export class VectorRetriever {
  constructor(
    private readonly storeClient: VectorStoreClient,
    private readonly embeddingClient: EmbeddingClient,
    private readonly options: {
      defaultCollectionName?: string;
    } = {},
  ) {}

  async ensureCollection(
    collection: Omit<VectorCollectionConfig, "name"> & { name?: string },
  ): Promise<void> {
    await this.storeClient.ensureCollection({
      ...collection,
      name: this.resolveCollectionName(collection.name),
    });
  }

  async upsertVectors(params: VectorUpsertParams): Promise<void> {
    await this.storeClient.upsert({
      collectionName: this.resolveCollectionName(params.collectionName),
      records: params.records.map((record) => ({
        id: record.id,
        vector: [...record.vector],
        payload: record.payload ? { ...record.payload } : undefined,
        document: record.document,
      })),
    });
  }

  async upsertTexts(params: TextUpsertParams): Promise<void> {
    const embeddings = await this.embeddingClient.getEmbeddings(
      params.records.map((record) => record.text),
    );

    await this.storeClient.upsert({
      collectionName: this.resolveCollectionName(params.collectionName),
      records: params.records.map((record, index) => {
        const embedding = embeddings[index];
        if (!embedding) {
          throw new Error(`缺少文本向量结果: ${record.id}`);
        }

        return {
          id: record.id,
          vector: [...embedding],
          payload: record.payload ? { ...record.payload } : undefined,
          document: record.document ?? record.text,
        };
      }),
    });
  }

  async searchVector(params: VectorSearchParams): Promise<VectorSearchResult[]> {
    return this.storeClient.query({
      collectionName: this.resolveCollectionName(params.collectionName),
      vector: [...params.vector],
      topK: params.topK,
      filter: params.filter ? { ...params.filter } : undefined,
      includeVectors: params.includeVectors,
    });
  }

  async searchText(params: TextSearchParams): Promise<VectorSearchResult[]> {
    const vector = await this.embeddingClient.getEmbedding(params.text);
    return this.searchVector({
      collectionName: params.collectionName,
      vector,
      topK: params.topK,
      filter: params.filter,
      includeVectors: params.includeVectors,
    });
  }

  async delete(params: Omit<VectorStoreDeleteParams, "collectionName"> & {
    collectionName?: string;
  }): Promise<void> {
    await this.storeClient.delete({
      collectionName: this.resolveCollectionName(params.collectionName),
      ids: params.ids ? [...params.ids] : undefined,
      filter: params.filter ? { ...params.filter } : undefined,
    });
  }

  private resolveCollectionName(collectionName?: string): string {
    const resolved =
      collectionName ??
      this.options.defaultCollectionName ??
      this.storeClient.config.defaultCollection;
    if (!resolved) {
      throw new Error("未提供 collectionName，且未配置默认 collection");
    }

    return resolved;
  }
}
