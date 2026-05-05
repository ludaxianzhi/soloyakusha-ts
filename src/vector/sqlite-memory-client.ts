import { VectorStoreClient } from "./base.ts";
import type {
  VectorCollectionInfo,
  VectorCollectionConfig,
  VectorSearchResult,
  VectorStoreCollectionDeleteParams,
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
import { createSqliteMemoryWorkerRuntime } from "./sqlite-memory-runtime.ts";

type UpsertRequestParams = Extract<SqliteMemoryWorkerRequest, { type: "upsert" }> ["params"];
type QueryRequestParams = Extract<SqliteMemoryWorkerRequest, { type: "query" }> ["params"];
type DeleteRequestParams = Extract<SqliteMemoryWorkerRequest, { type: "delete" }> ["params"];

type ClientWorkerRequest =
  | { type: "init"; databasePath: string }
  | { type: "probe" }
  | { type: "listCollections" }
  | { type: "ensureCollection"; collection: VectorCollectionConfig }
  | { type: "deleteCollection"; params: VectorStoreCollectionDeleteParams }
  | { type: "upsert"; params: UpsertRequestParams }
  | { type: "query"; params: QueryRequestParams }
  | { type: "delete"; params: DeleteRequestParams }
  | { type: "close" };

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
};

type WorkerMessageListener = (event: MessageEvent<SqliteMemoryWorkerResponse>) => void;
type WorkerErrorListener = (event: ErrorEvent) => void;

type WorkerLike = {
  addEventListener(type: "message", listener: WorkerMessageListener): void;
  addEventListener(type: "error", listener: WorkerErrorListener): void;
  removeEventListener(type: "message", listener: WorkerMessageListener): void;
  removeEventListener(type: "error", listener: WorkerErrorListener): void;
  postMessage: Worker["postMessage"];
  terminate: Worker["terminate"];
};

type WorkerFactory = () => WorkerLike;

type CollectionWorkerHandle = {
  collectionName: string;
  worker: WorkerLike;
  pendingRequests: Map<number, PendingRequest>;
  nextRequestId: number;
  initializationPromise?: Promise<void>;
  queue: Promise<void>;
  pendingTaskCount: number;
  activityToken: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
};

type SqliteMemoryVectorStoreClientOptions = {
  idleTtlMs?: number;
  workerFactory?: WorkerFactory;
};

const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000;
const SQLITE_MEMORY_WORKER_ENTRY = new URL("./sqlite-memory-worker.ts", import.meta.url).href;

export class SqliteMemoryVectorStoreClient extends VectorStoreClient {
  private readonly collectionWorkers = new Map<string, CollectionWorkerHandle>();
  private readonly idleTtlMs: number;
  private readonly workerFactory: WorkerFactory;
  private closed = false;

  constructor(
    config: VectorStoreConfig,
    options: SqliteMemoryVectorStoreClientOptions = {},
  ) {
    super(config);
    this.idleTtlMs = options.idleTtlMs ?? resolveIdleTtlMs(config);
    this.workerFactory = options.workerFactory ?? (() => shouldUseInProcessSqliteMemoryWorker()
      ? createInProcessSqliteMemoryWorker()
      : new Worker(SQLITE_MEMORY_WORKER_ENTRY, { type: "module" }));
  }

  override async probeConnection(): Promise<void> {
    const handle = this.createWorkerHandle("__probe__");
    try {
      await this.ensureInitialized(handle);
      await this.postRequest(handle, { type: "probe" });
    } finally {
      await this.disposeWorkerHandle(handle);
    }
  }

  override async listCollections(): Promise<VectorCollectionInfo[]> {
    const handle = this.createWorkerHandle("__listCollections__");
    try {
      await this.ensureInitialized(handle);
      const collections = await this.postRequest<VectorCollectionInfo[]>(handle, {
        type: "listCollections",
      });
      return collections.map((collection) => ({
        name: collection.name,
        dimension: collection.dimension,
        distance: collection.distance,
        metadata: collection.metadata ? { ...collection.metadata } : undefined,
        options: collection.options ? { ...collection.options } : undefined,
      }));
    } finally {
      await this.disposeWorkerHandle(handle);
    }
  }

  override async ensureCollection(collection: VectorCollectionConfig): Promise<void> {
    await this.runCollectionTask(collection.name, (handle) => this.postRequest(handle, {
      type: "ensureCollection",
      collection: {
        ...collection,
        metadata: collection.metadata ? { ...collection.metadata } : undefined,
        options: collection.options ? { ...collection.options } : undefined,
      },
    }));
  }

  override async deleteCollection(params: VectorStoreCollectionDeleteParams): Promise<void> {
    const handle = this.getOrCreateCollectionWorker(params.collectionName);
    await this.runCollectionTask(params.collectionName, (activeHandle) => this.postRequest(activeHandle, {
      type: "deleteCollection",
      params: {
        collectionName: params.collectionName,
      },
    }));

    if (this.collectionWorkers.get(params.collectionName) === handle) {
      this.collectionWorkers.delete(params.collectionName);
    }
    await this.disposeWorkerHandle(handle);
  }

  override async upsert(params: VectorStoreUpsertParams): Promise<void> {
    const transfer = params.records.map((record) => ({
      id: record.id,
      vector: Float32Array.from(record.vector),
      payload: record.payload ? { ...record.payload } : undefined,
      document: record.document,
    }));
    await this.runCollectionTask(params.collectionName, (handle) => this.postRequest(handle, {
      type: "upsert",
      params: {
        collectionName: params.collectionName,
        records: transfer,
      },
    }, transfer.map((record) => record.vector.buffer)));
  }

  override async query(params: VectorStoreQueryParams): Promise<VectorSearchResult[]> {
    const vector = Float32Array.from(params.vector);
    const response = await this.runCollectionTask(
      params.collectionName,
      (handle) => this.postRequest<SqliteMemoryQueryResult[]>(
        handle,
        {
          type: "query",
          params: {
            collectionName: params.collectionName,
            vector,
            topK: params.topK,
            filter: params.filter ? { ...params.filter } : undefined,
            includeVectors: params.includeVectors,
          },
        },
        [vector.buffer],
      ),
    );

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
    await this.runCollectionTask(params.collectionName, (handle) => this.postRequest(handle, {
      type: "delete",
      params: {
        collectionName: params.collectionName,
        ids: params.ids ? [...params.ids] : undefined,
        filter: params.filter ? { ...params.filter } : undefined,
      },
    }));
  }

  override async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    const handles = Array.from(this.collectionWorkers.values());
    this.collectionWorkers.clear();
    await Promise.all(handles.map((handle) => this.disposeWorkerHandle(handle)));
  }

  private async runCollectionTask<TResult>(
    collectionName: string,
    operation: (handle: CollectionWorkerHandle) => Promise<TResult>,
  ): Promise<TResult> {
    if (this.closed) {
      throw new Error("sqlite-memory client 已关闭");
    }

    const handle = this.getOrCreateCollectionWorker(collectionName);
    this.clearIdleTimer(handle);
    handle.pendingTaskCount += 1;
    handle.activityToken += 1;
    const activityToken = handle.activityToken;

    const task = handle.queue.then(async () => {
      await this.ensureInitialized(handle);
      return await operation(handle);
    });

    handle.queue = task.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await task;
    } finally {
      handle.pendingTaskCount -= 1;
      if (
        !this.closed &&
        !handle.closed &&
        handle.pendingTaskCount === 0 &&
        this.collectionWorkers.get(collectionName) === handle
      ) {
        this.scheduleIdleCleanup(handle, activityToken);
      }
    }
  }

  private getOrCreateCollectionWorker(collectionName: string): CollectionWorkerHandle {
    const existing = this.collectionWorkers.get(collectionName);
    if (existing) {
      return existing;
    }

    const created = this.createWorkerHandle(collectionName);
    this.collectionWorkers.set(collectionName, created);
    return created;
  }

  private createWorkerHandle(collectionName: string): CollectionWorkerHandle {
    const worker = this.workerFactory();
    const handle: CollectionWorkerHandle = {
      collectionName,
      worker,
      pendingRequests: new Map<number, PendingRequest>(),
      nextRequestId: 1,
      queue: Promise.resolve(),
      pendingTaskCount: 0,
      activityToken: 0,
      closed: false,
    };

    worker.addEventListener("message", (event: MessageEvent<SqliteMemoryWorkerResponse>) => {
      this.handleWorkerMessage(handle, event.data);
    });
    worker.addEventListener("error", (event) => {
      const error = event.error instanceof Error
        ? event.error
        : new Error(event.message || "sqlite-memory worker 运行失败");
      this.rejectAll(handle, error);
    });
    return handle;
  }

  private async ensureInitialized(handle: CollectionWorkerHandle): Promise<void> {
    if (handle.closed) {
      throw new Error(`collection worker 已关闭: ${handle.collectionName}`);
    }

    handle.initializationPromise ??= this.postRequest(handle, {
      type: "init",
      databasePath: this.config.endpoint,
    }).then(() => undefined);
    await handle.initializationPromise;
  }

  private async postRequest<TResult = undefined>(
    handle: CollectionWorkerHandle,
    request: ClientWorkerRequest,
    transfer: Transferable[] = [],
  ): Promise<TResult> {
    if (this.closed && request.type !== "close") {
      throw new Error("sqlite-memory client 已关闭");
    }
    if (handle.closed && request.type !== "close") {
      throw new Error(`collection worker 已关闭: ${handle.collectionName}`);
    }

    const id = handle.nextRequestId++;
    const payload = { id, ...request } as SqliteMemoryWorkerRequest;
    return await new Promise<TResult>((resolve, reject) => {
      handle.pendingRequests.set(id, { resolve, reject });
      handle.worker.postMessage(payload, transfer);
    });
  }

  private handleWorkerMessage(
    handle: CollectionWorkerHandle,
    response: SqliteMemoryWorkerResponse,
  ): void {
    const pending = handle.pendingRequests.get(response.id);
    if (!pending) {
      return;
    }

    handle.pendingRequests.delete(response.id);
    if (!response.ok) {
      const error = new Error(response.error.message);
      error.name = response.error.name;
      error.stack = response.error.stack;
      pending.reject(error);
      return;
    }

    pending.resolve(response.result);
  }

  private rejectAll(handle: CollectionWorkerHandle, error: Error): void {
    for (const pending of handle.pendingRequests.values()) {
      pending.reject(error);
    }
    handle.pendingRequests.clear();
  }

  private scheduleIdleCleanup(handle: CollectionWorkerHandle, activityToken: number): void {
    if (this.idleTtlMs <= 0) {
      return;
    }

    handle.idleTimer = setTimeout(() => {
      if (handle.closed || handle.pendingTaskCount !== 0 || handle.activityToken !== activityToken) {
        return;
      }
      if (this.collectionWorkers.get(handle.collectionName) !== handle) {
        return;
      }

      this.collectionWorkers.delete(handle.collectionName);
      void this.disposeWorkerHandle(handle);
    }, this.idleTtlMs);
  }

  private clearIdleTimer(handle: CollectionWorkerHandle): void {
    if (!handle.idleTimer) {
      return;
    }

    clearTimeout(handle.idleTimer);
    handle.idleTimer = undefined;
  }

  private async disposeWorkerHandle(handle: CollectionWorkerHandle): Promise<void> {
    if (handle.closed) {
      return;
    }

    this.clearIdleTimer(handle);
    await handle.queue;
    if (handle.closed) {
      return;
    }

    handle.closed = true;
    try {
      if (handle.initializationPromise) {
        await handle.initializationPromise;
        await this.postRequest(handle, { type: "close" });
      }
    } finally {
      this.rejectAll(handle, new Error("sqlite-memory client 已关闭"));
      handle.worker.terminate();
    }
  }
}

function createInProcessSqliteMemoryWorker(): WorkerLike {
  const messageListeners = new Set<WorkerMessageListener>();
  const errorListeners = new Set<WorkerErrorListener>();
  let terminated = false;
  const runtime = createSqliteMemoryWorkerRuntime((response) => {
    if (terminated) {
      return;
    }
    queueMicrotask(() => {
      if (terminated) {
        return;
      }
      const event = { data: response } as MessageEvent<SqliteMemoryWorkerResponse>;
      for (const listener of messageListeners) {
        listener(event);
      }
    });
  });

  return {
    addEventListener(type: "message" | "error", listener: WorkerMessageListener | WorkerErrorListener) {
      if (type === "message") {
        messageListeners.add(listener as WorkerMessageListener);
        return;
      }
      if (type === "error") {
        errorListeners.add(listener as WorkerErrorListener);
      }
    },
    removeEventListener(type: "message" | "error", listener: WorkerMessageListener | WorkerErrorListener) {
      if (type === "message") {
        messageListeners.delete(listener as WorkerMessageListener);
        return;
      }
      if (type === "error") {
        errorListeners.delete(listener as WorkerErrorListener);
      }
    },
    postMessage(message) {
      void runtime.handleRequest(message as SqliteMemoryWorkerRequest).catch((error) => {
        if (terminated) {
          return;
        }
        const normalized = error instanceof Error ? error : new Error(String(error));
        const event = {
          error: normalized,
          message: normalized.message,
        } as ErrorEvent;
        for (const listener of errorListeners) {
          listener(event);
        }
      });
    },
    terminate() {
      terminated = true;
      messageListeners.clear();
      errorListeners.clear();
    },
  };
}

function shouldUseInProcessSqliteMemoryWorker(): boolean {
  return (globalThis as { __SOLOYAKUSHA_STANDALONE__?: boolean }).__SOLOYAKUSHA_STANDALONE__ === true ||
    SQLITE_MEMORY_WORKER_ENTRY.includes("~BUN/root");
}

function resolveIdleTtlMs(config: VectorStoreConfig): number {
  const configured = config.options?.idleTtlMs;
  return typeof configured === "number" && Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_IDLE_TTL_MS;
}