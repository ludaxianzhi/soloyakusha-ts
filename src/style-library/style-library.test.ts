import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalConfigManager } from "../config/manager.ts";
import { EmbeddingClient } from "../llm/base.ts";
import type { LlmClientConfig } from "../llm/types.ts";
import { VectorStoreClientProvider } from "../vector/provider.ts";
import {
  buildManagedStyleLibraryCollectionName,
  buildStyleLibraryEmbeddingFingerprint,
  splitTextIntoChunks,
  StyleLibraryService,
} from "./service.ts";
import { STYLE_LIBRARY_COLLECTION_PREFIX } from "./types.ts";

describe("StyleLibraryService", () => {
  test("creates, imports, queries, and discovers managed libraries", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-style-library-"));
    const manager = new GlobalConfigManager({ filePath: join(workspaceDir, "config.json") });
    await manager.setEmbeddingConfig(createEmbeddingConfig("embed-a"));
    await manager.setVectorStore("memory", {
      provider: "sqlite-memory",
      endpoint: join(workspaceDir, "vector.sqlite"),
      distance: "cosine",
      timeoutMs: 30_000,
      retries: 1,
    });

    const service = new StyleLibraryService({
      manager,
      tempRootDir: workspaceDir,
      embeddingClientResolver: async () => new FakeEmbeddingClient(createEmbeddingConfig("embed-a")),
    });

    try {
      const created = await service.createLibrary("campus-style", {
        vectorStoreName: "memory",
        targetLanguage: "zh-CN",
        chunkLength: 8,
      });
      expect(created.collectionName).toBe(`${STYLE_LIBRARY_COLLECTION_PREFIX}campus_style`);

      const imported = await service.importLibrary("campus-style", {
        fileName: "sample.txt",
        content: new TextEncoder().encode("校园的清晨\n微风掠过树梢\n铃声打破寂静\n"),
      });
      expect(imported.importedFiles).toEqual(["sample.txt"]);
      expect(imported.chunkCount).toBe(3);

      const query = await service.queryLibrary("campus-style", "校园里很安静");
      expect(query.chunks).toHaveLength(1);
      expect(query.matches[0]?.document).toContain("校园");

      const catalog = await service.listLibraries();
      expect(catalog.discoveryErrors).toEqual({});
      expect(catalog.libraries).toHaveLength(1);
      expect(catalog.libraries[0]).toMatchObject({
        name: "campus-style",
        source: "registered",
        embeddingState: "compatible",
        existsInVectorStore: true,
      });
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test("imports zip archives and prefers translated target text", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-style-library-"));
    const manager = new GlobalConfigManager({ filePath: join(workspaceDir, "config.json") });
    await manager.setEmbeddingConfig(createEmbeddingConfig("embed-a"));
    await manager.setVectorStore("memory", {
      provider: "sqlite-memory",
      endpoint: join(workspaceDir, "vector.sqlite"),
      distance: "cosine",
      timeoutMs: 30_000,
      retries: 1,
    });

    const service = new StyleLibraryService({
      manager,
      tempRootDir: workspaceDir,
      embeddingClientResolver: async () => new FakeEmbeddingClient(createEmbeddingConfig("embed-a")),
    });

    try {
      await service.createLibrary("dialog-style", {
        vectorStoreName: "memory",
        targetLanguage: "zh-CN",
        chunkLength: 32,
      });

      const zip = new JSZip();
      zip.file(
        "script.m3t",
        [
          "○ NAME: 爱丽丝",
          "",
          "○ 校园的早晨",
          "● 【爱丽丝】晨光轻轻落下",
          "",
          "",
        ].join("\n"),
      );
      const archive = await zip.generateAsync({ type: "uint8array" });

      await service.importLibrary("dialog-style", {
        fileName: "dialog.zip",
        content: archive,
      });

      const query = await service.queryLibrary("dialog-style", "晨光映在走廊里");
      expect(query.matches[0]?.document).toContain("晨光轻轻落下");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test("marks library invalid after embedding config changes", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-style-library-"));
    const manager = new GlobalConfigManager({ filePath: join(workspaceDir, "config.json") });
    await manager.setEmbeddingConfig(createEmbeddingConfig("embed-a"));
    await manager.setVectorStore("memory", {
      provider: "sqlite-memory",
      endpoint: join(workspaceDir, "vector.sqlite"),
      distance: "cosine",
      timeoutMs: 30_000,
      retries: 1,
    });

    const service = new StyleLibraryService({
      manager,
      tempRootDir: workspaceDir,
      embeddingClientResolver: async () => new FakeEmbeddingClient(createEmbeddingConfig("embed-a")),
    });

    try {
      await service.createLibrary("invalid-test", {
        vectorStoreName: "memory",
        targetLanguage: "zh-CN",
        chunkLength: 10,
      });
      await service.importLibrary("invalid-test", {
        fileName: "sample.txt",
        content: new TextEncoder().encode("校园\n微风\n"),
      });

      await manager.setEmbeddingConfig(createEmbeddingConfig("embed-b"));

      const catalog = await service.listLibraries();
      expect(catalog.libraries[0]?.embeddingState).toBe("invalid");
      await expect(service.queryLibrary("invalid-test", "校园")).rejects.toThrow("样式库绑定的嵌入模型与当前全局嵌入模型不一致");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test("discovers external style library collections by prefix fallback", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-style-library-"));
    const manager = new GlobalConfigManager({ filePath: join(workspaceDir, "config.json") });
    await manager.setEmbeddingConfig(createEmbeddingConfig("embed-a"));
    await manager.setVectorStore("memory", {
      provider: "sqlite-memory",
      endpoint: join(workspaceDir, "vector.sqlite"),
      distance: "cosine",
      timeoutMs: 30_000,
      retries: 1,
    });

    const service = new StyleLibraryService({
      manager,
      tempRootDir: workspaceDir,
      embeddingClientResolver: async () => new FakeEmbeddingClient(createEmbeddingConfig("embed-a")),
    });

    try {
      await manager.setStyleLibrary("registered", {
        displayName: "已注册",
        vectorStoreName: "memory",
        collectionName: "stylelib__registered",
        targetLanguage: "zh-CN",
        chunkLength: 32,
        embeddingFingerprint: buildStyleLibraryEmbeddingFingerprint(createEmbeddingConfig("embed-a")),
        discoveryMode: "managed",
        managedByApp: true,
        createdAt: "2026-04-29T00:00:00.000Z",
        updatedAt: "2026-04-29T00:00:00.000Z",
      });

      const directVectorService = new StyleLibraryService({
        manager,
        tempRootDir: workspaceDir,
        embeddingClientResolver: async () => new FakeEmbeddingClient(createEmbeddingConfig("embed-a")),
      });
      await directVectorService.createLibrary("registered", {
        vectorStoreName: "memory",
        targetLanguage: "zh-CN",
        chunkLength: 32,
        collectionName: "stylelib__registered",
      });
      await directVectorService.deleteLibrary({ libraryName: "registered", deleteCollection: false });

      const provider = new VectorStoreClientProvider();
      provider.register("memory", await manager.getResolvedVectorStoreConfig("memory"));
      try {
        const client = provider.getClient("memory");
        await client.ensureCollection({
          name: "stylelib__external_lib",
          dimension: 4,
        });
      } finally {
        await provider.closeAll();
      }

      const catalog = await service.listLibraries();
      const discovered = catalog.libraries.find((item) => item.source === "discovered");
      expect(discovered).toMatchObject({
        name: "external_lib",
        collectionName: "stylelib__external_lib",
        embeddingState: "unknown",
      });
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe("style library helpers", () => {
  test("builds deterministic collection names and embedding fingerprints", () => {
    expect(buildManagedStyleLibraryCollectionName("Campus Style")).toBe("stylelib__campus_style");
    expect(buildStyleLibraryEmbeddingFingerprint(createEmbeddingConfig("embed-a"))).toBe(
      buildStyleLibraryEmbeddingFingerprint(createEmbeddingConfig("embed-a")),
    );
  });

  test("splits oversized text by line and character threshold", () => {
    expect(splitTextIntoChunks("abcdefghi", 4)).toEqual([
      { text: "abcd", charCount: 4 },
      { text: "efgh", charCount: 4 },
      { text: "i", charCount: 1 },
    ]);
  });
});

class FakeEmbeddingClient extends EmbeddingClient {
  constructor(config: LlmClientConfig) {
    super(config);
  }

  override async getEmbedding(text: string): Promise<number[]> {
    return keywordVector(text);
  }

  override async getEmbeddings(texts: string[]): Promise<number[][]> {
    return texts.map((text) => keywordVector(text));
  }
}

function keywordVector(text: string): number[] {
  return [
    text.includes("校园") ? 10 : 0,
    text.includes("风") ? 10 : 0,
    text.includes("铃") || text.includes("晨") ? 10 : 0,
    Math.min(text.length, 10),
  ];
}

function createEmbeddingConfig(modelName: string): LlmClientConfig {
  return {
    provider: "openai",
    modelName,
    apiKey: "secret",
    endpoint: "https://example.com/v1",
    modelType: "embedding",
    retries: 1,
  };
}