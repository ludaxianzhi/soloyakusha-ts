import { describe, expect, test } from "bun:test";
import {
  buildContextNetworkData,
  buildContextNetworkDataFromSentenceGraph,
} from "./context-network-builder.ts";

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

  test("aggregates sentence-level edges into fragment-level strengths", () => {
    const data = buildContextNetworkDataFromSentenceGraph({
      sourceRevision: 7,
      fragmentCount: 3,
      sentenceToFragmentIndices: [0, 0, 1, 1, 2],
      graph: {
        lineCount: 5,
        blockSize: 1,
        blockCount: 5,
        topCandidates: 2,
        topPercent: 20,
        thresholdScore: 0.8,
        candidateEdgeCount: 8,
        crossBlockCandidateCount: 8,
        strongEdgeCount: 6,
        bidirectionalEdgeCount: 6,
        matrix: Int32Array.from([
          0, 0, 1, 0, 0,
          0, 0, 0, 1, 0,
          1, 0, 0, 0, 1,
          0, 1, 0, 0, 1,
          0, 0, 1, 0, 0,
        ]),
        blockPairCount: 6,
        blockPairSourceBlocks: Int32Array.from([0, 1, 2, 3, 2, 4]),
        blockPairTargetBlocks: Int32Array.from([2, 3, 0, 1, 4, 2]),
        blockPairStrengths: Int32Array.from([1, 1, 1, 1, 1, 1]),
      },
    });

    expect(data.manifest.sourceRevision).toBe(7);
    expect(data.manifest.fragmentCount).toBe(3);
    expect(data.manifest.edgeCount).toBe(4);
    expect(Array.from(data.offsets)).toEqual([0, 1, 3, 4]);
    expect(Array.from(data.targets)).toEqual([1, 0, 2, 1]);
    expect(Array.from(data.strengths)).toEqual([2, 2, 1, 1]);
  });

  test("filters out fragment edges below the configured minimum strength", () => {
    const data = buildContextNetworkDataFromSentenceGraph({
      sourceRevision: 8,
      fragmentCount: 3,
      sentenceToFragmentIndices: [0, 0, 1, 1, 2],
      minEdgeStrength: 3,
      graph: {
        lineCount: 5,
        blockSize: 1,
        blockCount: 5,
        topCandidates: 2,
        topPercent: 20,
        thresholdScore: 0.8,
        candidateEdgeCount: 10,
        crossBlockCandidateCount: 10,
        strongEdgeCount: 10,
        bidirectionalEdgeCount: 10,
        matrix: Int32Array.from([
          0, 0, 1, 1, 0,
          0, 0, 0, 1, 0,
          1, 0, 0, 0, 1,
          1, 1, 0, 0, 1,
          0, 0, 1, 0, 0,
        ]),
        blockPairCount: 10,
        blockPairSourceBlocks: Int32Array.from([0, 0, 1, 2, 3, 2, 4, 3, 0, 3]),
        blockPairTargetBlocks: Int32Array.from([2, 3, 3, 0, 0, 4, 2, 1, 3, 4]),
        blockPairStrengths: Int32Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
      },
    });

    expect(data.manifest.edgeCount).toBe(2);
    expect(Array.from(data.offsets)).toEqual([0, 1, 2, 2]);
    expect(Array.from(data.targets)).toEqual([1, 0]);
    expect(Array.from(data.strengths)).toEqual([4, 3]);
  });
});