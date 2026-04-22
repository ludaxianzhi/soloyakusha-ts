// @ts-expect-error Bun import attributes resolve this worker module to a file URL string.
import workerEntry from "./sqlite-memory-worker.ts" with { type: "file" };
import { VectorStoreClient } from "./base.ts";
import type {
  VectorCollectionConfig,
  VectorSearchResult,
  VectorStoreConfig,
  VectorStoreDeleteParams,
  VectorStoreQueryParams,
  VectorStoreUpsertParams,
} from "./types.ts";
import type {
  SqliteMemoryQueryResult,
  SqliteMemoryWorkerRequest,
  SqliteMemoryWorkerResponse,
} from "./sqlite-memory-protocol.ts";

type UpsertRequestParams = Extract<SqliteMemoryWorkerRequest, { type: "upsert" }> ["params"];
type QueryRequestParams = Extract<SqliteMemoryWorkerRequest, { type: "query" }> ["params"];
type DeleteRequestParams = Extract<SqliteMemoryWorkerRequest, { type: "delete" }> ["params"];

type ClientWorkerRequest =
  | { type: "init"; databasePath: string }
  | { type: "probe" }
  | { type: "ensureCollection"; collection: VectorCollectionConfig }
  | { type: "upsert"; params: UpsertRequestParams }
  | { type: "query"; params: QueryRequestParams }
  | { type: "delete"; params: DeleteRequestParams }
  | { type: "close" };

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
};

export class SqliteMemoryVectorStoreClient extends VectorStoreClient {
  private readonly worker: Worker;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private initializationPromise?: Promise<void>;
  private closed = false;

  constructor(config: VectorStoreConfig) {
    super(config);
    this.worker = new Worker(workerEntry, { type: "module" });
    this.worker.addEventListener("message", (event: MessageEvent<SqliteMemoryWorkerResponse>) => {
      this.handleWorkerMessage(event.data);
    });
    this.worker.addEventListener("error", (event) => {
      const error = event.error instanceof Error
        ? event.error
        : new Error(event.message || "sqlite-memory worker 运行失败");
      this.rejectAll(error);
    });
  }

  override async probeConnection(): Promise<void> {
    await this.ensureInitialized();
    await this.postRequest({ type: "probe" });
  }

  override async ensureCollection(collection: VectorCollectionConfig): Promise<void> {
    await this.ensureInitialized();
    await this.postRequest({
      type: "ensureCollection",
      collection: {
        ...collection,
        metadata: collection.metadata ? { ...collection.metadata } : undefined,
        options: collection.options ? { ...collection.options } : undefined,
      },
    });
  }

  override async upsert(params: VectorStoreUpsertParams): Promise<void> {
    await this.ensureInitialized();
    const transfer = params.records.map((record) => ({
      id: record.id,
      vector: Float32Array.from(record.vector),
      payload: record.payload ? { ...record.payload } : undefined,
      document: record.document,
    }));
    await this.postRequest({
      type: "upsert",
      params: {
        collectionName: params.collectionName,
        records: transfer,
      },
    }, transfer.map((record) => record.vector.buffer));
  }

  override async query(params: VectorStoreQueryParams): Promise<VectorSearchResult[]> {
    await this.ensureInitialized();
    const vector = Float32Array.from(params.vector);
    const response = await this.postRequest<SqliteMemoryQueryResult[]>({
      type: "query",
      params: {
        collectionName: params.collectionName,
        vector,
        topK: params.topK,
        filter: params.filter ? { ...params.filter } : undefined,
        includeVectors: params.includeVectors,
      },
    }, [vector.buffer]);

    const results = Array.isArray(response) ? response : [];
    return results.map((item) => ({
      id: item.id,
      score: item.score,
      rawScore: item.rawScore,
      payload: item.payload ? { ...item.payload } : undefined,
      document: item.document,
      vector: item.vector ? Array.from(item.vector) : undefined,
    }));
  }

  override async delete(params: VectorStoreDeleteParams): Promise<void> {
    await this.ensureInitialized();
    await this.postRequest({
      type: "delete",
      params: {
        collectionName: params.collectionName,
        ids: params.ids ? [...params.ids] : undefined,
        filter: params.filter ? { ...params.filter } : undefined,
      },
    });
  }

  override async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    try {
      if (this.initializationPromise) {
        await this.initializationPromise;
        await this.postRequest({ type: "close" });
      }
    } finally {
      this.closed = true;
      this.rejectAll(new Error("sqlite-memory client 已关闭"));
      this.worker.terminate();
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.closed) {
      throw new Error("sqlite-memory client 已关闭");
    }

    this.initializationPromise ??= this.postRequest({
      type: "init",
      databasePath: this.config.endpoint,
    }).then(() => undefined);
    await this.initializationPromise;
  }

  private async postRequest<TResult = undefined>(
    request: ClientWorkerRequest,
    transfer: Transferable[] = [],
  ): Promise<TResult> {
    if (this.closed) {
      throw new Error("sqlite-memory client 已关闭");
    }

    const id = this.nextRequestId++;
    const payload = { id, ...request } as SqliteMemoryWorkerRequest;
    return await new Promise<TResult>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.worker.postMessage(payload, transfer);
    });
  }

  private handleWorkerMessage(response: SqliteMemoryWorkerResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(response.id);
    if (!response.ok) {
      const error = new Error(response.error.message);
      error.name = response.error.name;
      error.stack = response.error.stack;
      pending.reject(error);
      return;
    }

    pending.resolve(response.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}