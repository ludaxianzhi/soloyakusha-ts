import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddingClient } from "../llm/base.ts";
import type { LlmClientConfig } from "../llm/types.ts";
import {
  ChromaVectorStoreClient,
  createVectorStoreConfig,
  QdrantVectorStoreClient,
  SqliteMemoryVectorStoreClient,
  VectorRetriever,
  VectorStoreClient,
  VectorStoreClientProvider,
} from "./index.ts";
import type {
  VectorCollectionInfo,
  VectorCollectionConfig,
  VectorSearchResult,
  VectorStoreCollectionDeleteParams,
  VectorStoreDeleteParams,
  VectorStoreQueryParams,
  VectorStoreUpsertParams,
} from "./types.ts";
import type {
  SqliteMemoryQueryResult,
  SqliteMemoryWorkerRequest,
  SqliteMemoryWorkerResponse,
} from "./sqlite-memory-protocol.ts";

describe("createVectorStoreConfig", () => {
  test("resolves apiKey from environment variables", () => {
    process.env.SOLOYAKUSHA_VECTOR_TEST_KEY = "vector-secret";

    const config = createVectorStoreConfig({
      provider: "qdrant",
      endpoint: "https://vector.example.com",
      apiKeyEnv: "SOLOYAKUSHA_VECTOR_TEST_KEY",
    });

    expect(config.apiKey).toBe("vector-secret");
    expect(config.distance).toBe("cosine");
    expect(config.timeoutMs).toBe(60_000);

    delete process.env.SOLOYAKUSHA_VECTOR_TEST_KEY;
  });
});

describe("VectorStoreClientProvider", () => {
  test("reuses the same instance for equivalent configs", () => {
    const provider = new VectorStoreClientProvider();
    provider.register("primary", {
      provider: "qdrant",
      endpoint: "https://vector.example.com",
      apiKey: "secret",
    });
    provider.register("alias", {
      provider: "qdrant",
      endpoint: "https://vector.example.com",
      apiKey: "secret",
    });

    const primary = provider.getClient("primary");
    const alias = provider.getClient("alias");

    expect(primary).toBe(alias);
    expect(primary).toBeInstanceOf(VectorStoreClient);
  });

  test("creates sqlite-memory client instances", () => {
    const provider = new VectorStoreClientProvider();
    provider.register("local", {
      provider: "sqlite-memory",
      endpoint: "C:/temp/soloyakusha-vector-test.sqlite",
    });

    const client = provider.getClient("local");

    expect(client).toBeInstanceOf(SqliteMemoryVectorStoreClient);
  });
});

describe("VectorRetriever", () => {
  test("embeds text before storing and querying", async () => {
    const store = new FakeVectorStoreClient();
    const retriever = new VectorRetriever(store, new FakeEmbeddingClient(), {
      defaultCollectionName: "chapters",
    });

    await retriever.upsertTexts({
      records: [
        {
          id: "frag-1",
          text: "勇者登场",
          payload: { chapter: 1 },
        },
      ],
    });
    const results = await retriever.searchText({
      text: "勇者",
      topK: 2,
    });

    expect(store.lastUpsert).toMatchObject({
      collectionName: "chapters",
      records: [
        {
          id: "frag-1",
          vector: [4, 2],
          document: "勇者登场",
          payload: { chapter: 1 },
        },
      ],
    });
    expect(store.lastQuery).toMatchObject({
      collectionName: "chapters",
      vector: [2, 1],
      topK: 2,
    });
    expect(results).toEqual([
      {
        id: "frag-1",
        score: 0.91,
        rawScore: 0.91,
        document: "勇者登场",
        payload: { chapter: 1 },
      },
    ]);
  });
});

describe("QdrantVectorStoreClient", () => {
  test("probes connectivity via collection listing", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return Response.json({ result: { collections: [] } });
    }) as typeof fetch;

    try {
      const client = new QdrantVectorStoreClient(
        createVectorStoreConfig({
          provider: "qdrant",
          endpoint: "http://localhost:6333",
          apiKey: "secret",
        }),
      );

      await client.probeConnection();

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("http://localhost:6333/collections");
      expect(requests[0]?.init?.method).toBe("GET");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("maps collection, upsert, query, and delete requests", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      const url = String(input);
      if (url.endsWith("/points/search")) {
        return Response.json({
          result: [
            {
              id: "frag-1",
              score: 0.83,
              payload: {
                chapter: 1,
                document: "勇者登场",
              },
            },
          ],
        });
      }
      return Response.json({ result: { status: "ok" } });
    }) as typeof fetch;

    try {
      const client = new QdrantVectorStoreClient(
        createVectorStoreConfig({
          provider: "qdrant",
          endpoint: "http://localhost:6333",
          apiKey: "secret",
        }),
      );

      await client.ensureCollection({
        name: "chapters",
        dimension: 3,
      });
      await client.upsert({
        collectionName: "chapters",
        records: [
          {
            id: "frag-1",
            vector: [0.1, 0.2, 0.3],
            payload: { chapter: 1 },
            document: "勇者登场",
          },
        ],
      });
      const results = await client.query({
        collectionName: "chapters",
        vector: [0.1, 0.2, 0.3],
        topK: 3,
        filter: { chapter: 1 },
      });
      await client.delete({
        collectionName: "chapters",
        ids: ["frag-1"],
      });

      expect(requests).toHaveLength(4);
      expect(requests[0]?.url).toBe("http://localhost:6333/collections/chapters");
      expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
        vectors: {
          size: 3,
          distance: "Cosine",
        },
      });
      expect(requests[1]?.url).toBe("http://localhost:6333/collections/chapters/points?wait=true");
      expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
        points: [
          {
            id: "frag-1",
            vector: [0.1, 0.2, 0.3],
            payload: {
              chapter: 1,
              document: "勇者登场",
            },
          },
        ],
      });
      expect(requests[2]?.url).toBe("http://localhost:6333/collections/chapters/points/search");
      expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({
        vector: [0.1, 0.2, 0.3],
        limit: 3,
        with_payload: true,
        with_vector: false,
        filter: {
          must: [
            {
              key: "chapter",
              match: {
                value: 1,
              },
            },
          ],
        },
      });
      expect(requests[3]?.url).toBe(
        "http://localhost:6333/collections/chapters/points/delete?wait=true",
      );
      expect(results).toEqual([
        {
          id: "frag-1",
          score: 0.83,
          rawScore: 0.83,
          payload: {
            chapter: 1,
            document: "勇者登场",
          },
          document: "勇者登场",
          vector: undefined,
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("lists collections with detail lookups", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      const url = String(input);
      if (url.endsWith("/collections")) {
        return Response.json({
          result: {
            collections: [
              { name: "stylelib__alpha" },
              { name: "stylelib__beta" },
            ],
          },
        });
      }
      if (url.endsWith("/collections/stylelib__alpha")) {
        return Response.json({
          result: {
            config: {
              params: { vectors: { size: 1536, distance: "Cosine" } },
              on_disk_payload: true,
            },
          },
        });
      }
      if (url.endsWith("/collections/stylelib__beta")) {
        return Response.json({
          result: {
            config: {
              params: { vectors: { size: 768, distance: "Dot" } },
            },
          },
        });
      }
      return Response.json({ result: { status: "ok" } });
    }) as typeof fetch;

    try {
      const client = new QdrantVectorStoreClient(
        createVectorStoreConfig({
          provider: "qdrant",
          endpoint: "http://localhost:6333",
          apiKey: "secret",
        }),
      );

      await expect(client.listCollections()).resolves.toEqual([
        {
          name: "stylelib__alpha",
          dimension: 1536,
          distance: "cosine",
          metadata: undefined,
          options: {
            params: { vectors: { size: 1536, distance: "Cosine" } },
            on_disk_payload: true,
          },
        },
        {
          name: "stylelib__beta",
          dimension: 768,
          distance: "dot",
          metadata: undefined,
          options: {
            params: { vectors: { size: 768, distance: "Dot" } },
          },
        },
      ] satisfies VectorCollectionInfo[]);

      expect(requests.map((request) => request.url)).toEqual([
        "http://localhost:6333/collections",
        "http://localhost:6333/collections/stylelib__alpha",
        "http://localhost:6333/collections/stylelib__beta",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("ChromaVectorStoreClient", () => {
  test("probes connectivity via collection listing", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return Response.json({ collections: [] });
    }) as typeof fetch;

    try {
      const client = new ChromaVectorStoreClient(
        createVectorStoreConfig({
          provider: "chroma",
          endpoint: "http://localhost:8000",
          apiKey: "secret",
        }),
      );

      await client.probeConnection();

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("http://localhost:8000/api/v1/collections");
      expect(requests[0]?.init?.method).toBe("GET");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("maps collection, upsert, query, and delete requests", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      const url = String(input);
      if (url.endsWith("/query")) {
        return Response.json({
          ids: [["frag-1"]],
          distances: [[0.2]],
          metadatas: [[{ chapter: 1 }]],
          documents: [["勇者登场"]],
        });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      const client = new ChromaVectorStoreClient(
        createVectorStoreConfig({
          provider: "chroma",
          endpoint: "http://localhost:8000",
          apiKey: "secret",
        }),
      );

      await client.ensureCollection({
        name: "chapters",
        dimension: 3,
        distance: "cosine",
      });
      await client.upsert({
        collectionName: "chapters",
        records: [
          {
            id: "frag-1",
            vector: [0.1, 0.2, 0.3],
            payload: { chapter: 1 },
            document: "勇者登场",
          },
        ],
      });
      const results = await client.query({
        collectionName: "chapters",
        vector: [0.1, 0.2, 0.3],
        topK: 4,
        filter: { chapter: 1 },
      });
      await client.delete({
        collectionName: "chapters",
        ids: ["frag-1"],
      });

      expect(requests).toHaveLength(4);
      expect(requests[0]?.url).toBe("http://localhost:8000/api/v1/collections");
      expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
        name: "chapters",
        get_or_create: true,
        metadata: {
          "hnsw:space": "cosine",
        },
      });
      expect(requests[1]?.url).toBe("http://localhost:8000/api/v1/collections/chapters/upsert");
      expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
        ids: ["frag-1"],
        embeddings: [[0.1, 0.2, 0.3]],
        documents: ["勇者登场"],
        metadatas: [{ chapter: 1 }],
      });
      expect(requests[2]?.url).toBe("http://localhost:8000/api/v1/collections/chapters/query");
      expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({
        query_embeddings: [[0.1, 0.2, 0.3]],
        n_results: 4,
        where: { chapter: 1 },
      });
      expect(requests[3]?.url).toBe("http://localhost:8000/api/v1/collections/chapters/delete");
      expect(results).toEqual([
        {
          id: "frag-1",
          score: 1 / 1.2,
          rawScore: 0.2,
          payload: { chapter: 1 },
          document: "勇者登场",
          vector: undefined,
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("lists collections with metadata", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return Response.json([
        {
          name: "stylelib__alpha",
          metadata: {
            resourceType: "style-library",
            chunkLength: 400,
          },
          configuration_json: {
            hnsw: { M: 16 },
          },
        },
      ]);
    }) as typeof fetch;

    try {
      const client = new ChromaVectorStoreClient(
        createVectorStoreConfig({
          provider: "chroma",
          endpoint: "http://localhost:8000",
          apiKey: "secret",
        }),
      );

      await expect(client.listCollections()).resolves.toEqual([
        {
          name: "stylelib__alpha",
          metadata: {
            resourceType: "style-library",
            chunkLength: 400,
          },
          options: {
            hnsw: { M: 16 },
          },
        },
      ] satisfies VectorCollectionInfo[]);

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("http://localhost:8000/api/v1/collections");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("SqliteMemoryVectorStoreClient", () => {
  test("persists vectors in sqlite and reloads them into worker memory", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-vector-"));
    const databasePath = join(workspaceDir, "vector.sqlite");

    try {
      const client = new SqliteMemoryVectorStoreClient(
        createVectorStoreConfig({
          provider: "sqlite-memory",
          endpoint: databasePath,
          distance: "cosine",
        }),
      );

      await client.ensureCollection({
        name: "chapters",
        dimension: 3,
      });
      await client.upsert({
        collectionName: "chapters",
        records: [
          {
            id: "frag-1",
            vector: [1, 0, 0],
            payload: { chapter: 1 },
            document: "勇者登场",
          },
          {
            id: "frag-2",
            vector: [0, 1, 0],
            payload: { chapter: 2 },
            document: "反派现身",
          },
        ],
      });

      const firstResults = await client.query({
        collectionName: "chapters",
        vector: [0.9, 0.1, 0],
        topK: 2,
        filter: { chapter: 1 },
        includeVectors: true,
      });

      expect(firstResults).toHaveLength(1);
      const firstResult = firstResults[0]!;
      expect(firstResult).toEqual({
        id: "frag-1",
        score: firstResult.score,
        rawScore: firstResult.rawScore,
        payload: { chapter: 1 },
        document: "勇者登场",
        vector: [1, 0, 0],
      });
      expect(firstResult.score > 0.99).toBe(true);

      await client.close();

      const reloadedClient = new SqliteMemoryVectorStoreClient(
        createVectorStoreConfig({
          provider: "sqlite-memory",
          endpoint: databasePath,
          distance: "cosine",
        }),
      );

      const reloadedResults = await reloadedClient.query({
        collectionName: "chapters",
        vector: [0, 1, 0],
        topK: 2,
      });
      expect(reloadedResults.map((item) => item.id)).toEqual(["frag-2", "frag-1"]);

      await reloadedClient.delete({
        collectionName: "chapters",
        ids: ["frag-2"],
      });
      const afterDelete = await reloadedClient.query({
        collectionName: "chapters",
        vector: [0, 1, 0],
        topK: 5,
      });
      expect(afterDelete.map((item) => item.id)).toEqual(["frag-1"]);

      await reloadedClient.close();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test("deletes collections from sqlite worker storage", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-vector-"));
    const databasePath = join(workspaceDir, "vector.sqlite");

    try {
      const client = new SqliteMemoryVectorStoreClient(
        createVectorStoreConfig({
          provider: "sqlite-memory",
          endpoint: databasePath,
          distance: "cosine",
        }),
      );

      await client.ensureCollection({
        name: "temp-links",
        dimension: 2,
      });
      await client.upsert({
        collectionName: "temp-links",
        records: [
          {
            id: "row-1",
            vector: [1, 0],
          },
        ],
      });

      await client.deleteCollection({
        collectionName: "temp-links",
      });

      await expect(client.query({
        collectionName: "temp-links",
        vector: [1, 0],
        topK: 1,
      })).rejects.toThrow("未找到向量集合: temp-links");

      await client.close();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test("lists persisted collections", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-vector-"));
    const databasePath = join(workspaceDir, "vector.sqlite");

    try {
      const client = new SqliteMemoryVectorStoreClient(
        createVectorStoreConfig({
          provider: "sqlite-memory",
          endpoint: databasePath,
          distance: "cosine",
        }),
      );

      await client.ensureCollection({
        name: "stylelib__alpha",
        dimension: 4,
        distance: "cosine",
        metadata: {
          resourceType: "style-library",
          targetLanguage: "zh-CN",
        },
        options: {
          chunkLength: 400,
        },
      });

      await expect(client.listCollections()).resolves.toEqual([
        {
          name: "stylelib__alpha",
          dimension: 4,
          distance: "cosine",
          metadata: {
            resourceType: "style-library",
            targetLanguage: "zh-CN",
          },
          options: {
            chunkLength: 400,
          },
        },
      ] satisfies VectorCollectionInfo[]);

      await client.close();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test("rejects collections beyond configured dimension limit", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-vector-"));
    const databasePath = join(workspaceDir, "vector.sqlite");
    const client = new SqliteMemoryVectorStoreClient(
      createVectorStoreConfig({
        provider: "sqlite-memory",
        endpoint: databasePath,
        distance: "cosine",
      }),
    );

    try {
      await expect(client.ensureCollection({
        name: "too-wide",
        dimension: 257,
      })).rejects.toThrow("仅支持 1-256 维向量");
    } finally {
      await client.close();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test("uses dedicated workers per collection and evicts idle workers", async () => {
    const workers: FakeSqliteWorker[] = [];
    const client = new SqliteMemoryVectorStoreClient(
      createVectorStoreConfig({
        provider: "sqlite-memory",
        endpoint: "C:/temp/soloyakusha-vector-idle.sqlite",
        distance: "cosine",
      }),
      {
        idleTtlMs: 20,
        workerFactory: () => {
          const worker = new FakeSqliteWorker();
          workers.push(worker);
          return worker as unknown as Worker;
        },
      },
    );

    try {
      await client.ensureCollection({ name: "alpha", dimension: 1 });
      await client.ensureCollection({ name: "beta", dimension: 1 });

      expect(workers).toHaveLength(2);
      expect(workers[0]?.messages.map((message) => message.type)).toEqual([
        "init",
        "ensureCollection",
      ]);
      expect(workers[1]?.messages.map((message) => message.type)).toEqual([
        "init",
        "ensureCollection",
      ]);

      await Bun.sleep(50);

      expect(workers.every((worker) => worker.terminated)).toBe(true);
    } finally {
      await client.close();
    }
  });

  test("serializes concurrent tasks for the same collection", async () => {
    const workers: FakeSqliteWorker[] = [];
    const client = new SqliteMemoryVectorStoreClient(
      createVectorStoreConfig({
        provider: "sqlite-memory",
        endpoint: "C:/temp/soloyakusha-vector-queue.sqlite",
        distance: "cosine",
      }),
      {
        idleTtlMs: 1_000,
        workerFactory: () => {
          const worker = new FakeSqliteWorker({ holdQueries: true });
          workers.push(worker);
          return worker as unknown as Worker;
        },
      },
    );

    try {
      await client.ensureCollection({ name: "alpha", dimension: 1 });
      const worker = workers[0]!;

      const firstQuery = client.query({
        collectionName: "alpha",
        vector: [1],
        topK: 1,
      });
      const secondQuery = client.query({
        collectionName: "alpha",
        vector: [1],
        topK: 1,
      });

      await Bun.sleep(0);
      expect(worker.messages.filter((message) => message.type === "query")).toHaveLength(1);

      worker.releaseNextQuery([{ id: "frag-1", score: 1, rawScore: 1 }]);
      await firstQuery;

      await Bun.sleep(0);
      expect(worker.messages.filter((message) => message.type === "query")).toHaveLength(2);

      worker.releaseNextQuery([{ id: "frag-2", score: 0.8, rawScore: 0.8 }]);
      await expect(secondQuery).resolves.toEqual([
        {
          id: "frag-2",
          score: 0.8,
          rawScore: 0.8,
          payload: undefined,
          document: undefined,
          vector: undefined,
        },
      ]);
    } finally {
      await client.close();
    }
  });
});

type FakeSqliteWorkerOptions = {
  holdQueries?: boolean;
};

class FakeSqliteWorker {
  readonly messages: SqliteMemoryWorkerRequest[] = [];
  terminated = false;

  private readonly messageListeners = new Set<
    (event: MessageEvent<SqliteMemoryWorkerResponse>) => void
  >();
  private readonly errorListeners = new Set<(event: ErrorEvent) => void>();
  private readonly queuedQueries: Array<Extract<SqliteMemoryWorkerRequest, { type: "query" }>> = [];

  constructor(private readonly options: FakeSqliteWorkerOptions = {}) {}

  addEventListener(
    type: "message" | "error",
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (type === "message") {
      this.messageListeners.add(listener as (event: MessageEvent<SqliteMemoryWorkerResponse>) => void);
      return;
    }

    this.errorListeners.add(listener as (event: ErrorEvent) => void);
  }

  postMessage(message: SqliteMemoryWorkerRequest): void {
    this.messages.push(message);
    if (message.type === "query" && this.options.holdQueries) {
      this.queuedQueries.push(message);
      return;
    }

    queueMicrotask(() => {
      if (message.type === "query") {
        this.emit({ id: message.id, ok: true, result: [] });
        return;
      }

      this.emit({ id: message.id, ok: true });
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  releaseNextQuery(result: SqliteMemoryQueryResult[]): void {
    const next = this.queuedQueries.shift();
    if (!next) {
      throw new Error("没有待释放的 query 请求");
    }

    this.emit({ id: next.id, ok: true, result });
  }

  private emit(response: SqliteMemoryWorkerResponse): void {
    for (const listener of this.messageListeners) {
      listener({ data: response } as MessageEvent<SqliteMemoryWorkerResponse>);
    }
  }
}

class FakeEmbeddingClient extends EmbeddingClient {
  constructor() {
    super(createStubEmbeddingConfig());
  }

  override async getEmbedding(text: string): Promise<number[]> {
    return [text.length, Math.max(1, Math.floor(text.length / 2))];
  }

  override async getEmbeddings(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.getEmbedding(text)));
  }
}

function createStubEmbeddingConfig(): LlmClientConfig {
  return {
    provider: "openai",
    modelName: "fake-embedding",
    apiKey: "secret",
    endpoint: "https://example.com/v1",
    modelType: "embedding",
    retries: 1,
  };
}

class FakeVectorStoreClient extends VectorStoreClient {
  collections: VectorCollectionInfo[] = [];
  lastCollection?: VectorCollectionConfig;
  lastDeletedCollection?: VectorStoreCollectionDeleteParams;
  lastUpsert?: VectorStoreUpsertParams;
  lastQuery?: VectorStoreQueryParams;
  lastDelete?: VectorStoreDeleteParams;

  constructor() {
    super(
      createVectorStoreConfig({
        provider: "qdrant",
        endpoint: "http://unused.example.com",
        defaultCollection: "chapters",
      }),
    );
  }

  override async probeConnection(): Promise<void> {}

  override async listCollections(): Promise<VectorCollectionInfo[]> {
    return this.collections.map((collection) => ({ ...collection }));
  }

  override async ensureCollection(collection: VectorCollectionConfig): Promise<void> {
    this.lastCollection = collection;
  }

  override async deleteCollection(params: VectorStoreCollectionDeleteParams): Promise<void> {
    this.lastDeletedCollection = params;
  }

  override async upsert(params: VectorStoreUpsertParams): Promise<void> {
    this.lastUpsert = params;
  }

  override async query(params: VectorStoreQueryParams): Promise<VectorSearchResult[]> {
    this.lastQuery = params;
    return [
      {
        id: "frag-1",
        score: 0.91,
        rawScore: 0.91,
        document: "勇者登场",
        payload: { chapter: 1 },
      },
    ];
  }

  override async delete(params: VectorStoreDeleteParams): Promise<void> {
    this.lastDelete = params;
  }
}
