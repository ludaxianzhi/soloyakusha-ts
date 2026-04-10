import type {
  VectorCollectionConfig,
  VectorSearchResult,
  VectorStoreConfig,
  VectorStoreDeleteParams,
  VectorStoreQueryParams,
  VectorStoreUpsertParams,
} from "./types.ts";

export abstract class ManagedVectorStoreClient {
  protected constructor(public readonly config: VectorStoreConfig) {}

  async close(): Promise<void> {}
}

export abstract class VectorStoreClient extends ManagedVectorStoreClient {
  abstract ensureCollection(collection: VectorCollectionConfig): Promise<void>;
  abstract upsert(params: VectorStoreUpsertParams): Promise<void>;
  abstract query(params: VectorStoreQueryParams): Promise<VectorSearchResult[]>;
  abstract delete(params: VectorStoreDeleteParams): Promise<void>;
}
