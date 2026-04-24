import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeChunkLinkGraph } from "./chunk-link-graph.ts";
import { createVectorStoreConfig, SqliteMemoryVectorStoreClient } from "./index.ts";

describe("computeChunkLinkGraph", () => {
  test("builds bidirectional cross-block pair strengths with sqlite-memory vectors", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-chunk-link-graph-"));
    const databasePath = join(workspaceDir, "vector.sqlite");
    const logs: string[] = [];

    try {
      const result = await computeChunkLinkGraph({
        vectorStoreConfig: createVectorStoreConfig({
          provider: "sqlite-memory",
          endpoint: databasePath,
          distance: "cosine",
        }),
        embeddings: [
          [1, 0],
          [0, 1],
          [0.99, 0.01],
          [0.01, 0.99],
        ],
        blockSize: 2,
        topCandidates: 1,
        topPercent: 100,
        upsertBatchSize: 2,
        tempCollectionName: "temp-link-graph",
      }, {
        logger: {
          info(message, metadata) {
            logs.push(`${message}:${String(metadata?.phase)}:${metadata?.processed}/${metadata?.total}`);
          },
        },
      });

      expect(result.lineCount).toBe(4);
      expect(result.blockCount).toBe(2);
      expect(result.candidateEdgeCount).toBe(4);
      expect(result.crossBlockCandidateCount).toBe(4);
      expect(result.strongEdgeCount).toBe(4);
      expect(result.bidirectionalEdgeCount).toBe(4);
      expect(result.blockPairCount).toBe(2);
      expect(Array.from(result.blockPairSourceBlocks)).toEqual([0, 1]);
      expect(Array.from(result.blockPairTargetBlocks)).toEqual([1, 0]);
      // Each block pair aggregates 2 bidirectional chunk pairs; each contributes
      // cos(a,b)^2 + cos(b,a)^2 ≈ 2 * (0.99/√0.9802)^2 ≈ 2 * 0.9999 per pair.
      // Total ≈ 4 * (0.9801/0.9802) ≈ 3.9996.
      expect(result.blockPairStrengths).toBeInstanceOf(Float32Array);
      expect(result.blockPairStrengths[0]).toBeCloseTo(4, 0);
      expect(result.blockPairStrengths[1]).toBeCloseTo(4, 0);
      expect(logs.some((entry) => entry.includes("top10 获取进度:topk:4/4"))).toBe(true);
      expect(logs.some((entry) => entry.includes("块间连接矩阵计算进度:matrix:4/4"))).toBe(true);

      const probeClient = new SqliteMemoryVectorStoreClient(
        createVectorStoreConfig({
          provider: "sqlite-memory",
          endpoint: databasePath,
          distance: "cosine",
        }),
      );
      await expect(probeClient.query({
        collectionName: "temp-link-graph",
        vector: [1, 0],
        topK: 1,
      })).rejects.toThrow("未找到向量集合: temp-link-graph");
      await probeClient.close();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});