import { describe, expect, test } from "bun:test";
import { EmbeddingClient } from "../llm/base.ts";
import type { LlmClientConfig } from "../llm/types.ts";
import {
  ChromaVectorStoreClient,
  createVectorStoreConfig,
  QdrantVectorStoreClient,
  VectorRetriever,
  VectorStoreClient,
  VectorStoreClientProvider,
} from "./index.ts";
import type {
  VectorCollectionConfig,
  VectorSearchResult,
  VectorStoreDeleteParams,
  VectorStoreQueryParams,
  VectorStoreUpsertParams,
} from "./types.ts";

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
});

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
  lastCollection?: VectorCollectionConfig;
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

  override async ensureCollection(collection: VectorCollectionConfig): Promise<void> {
    this.lastCollection = collection;
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
