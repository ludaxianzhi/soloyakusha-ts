import { describe, expect, test } from "bun:test";
import { buildContextNetworkData } from "./context-network-builder.ts";

describe("buildContextNetworkData", () => {
  test("converts chunk link graph block pairs into CSR-style adjacency arrays", () => {
    const data = buildContextNetworkData({
      sourceRevision: 4,
      fragmentCount: 4,
      graph: {
        lineCount: 4,
        blockSize: 1,
        blockCount: 4,
        topCandidates: 3,
        topPercent: 50,
        thresholdScore: 0.7,
        candidateEdgeCount: 6,
        crossBlockCandidateCount: 5,
        strongEdgeCount: 4,
        bidirectionalEdgeCount: 4,
        matrix: Int32Array.from([
          0, 5, 1, 0,
          0, 0, 0, 0,
          0, 2, 0, 3,
          0, 0, 0, 0,
        ]),
        blockPairCount: 4,
        blockPairSourceBlocks: Int32Array.from([0, 0, 2, 2]),
        blockPairTargetBlocks: Int32Array.from([1, 2, 1, 3]),
        blockPairStrengths: Int32Array.from([5, 1, 2, 3]),
      },
    });

    expect(data.manifest.sourceRevision).toBe(4);
    expect(data.manifest.fragmentCount).toBe(4);
    expect(data.manifest.edgeCount).toBe(4);
    expect(Array.from(data.offsets)).toEqual([0, 2, 2, 4, 4]);
    expect(Array.from(data.targets)).toEqual([1, 2, 3, 1]);
    expect(Array.from(data.strengths)).toEqual([5, 1, 3, 2]);
  });
});