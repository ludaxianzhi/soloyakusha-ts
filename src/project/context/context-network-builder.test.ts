import { describe, expect, test } from "bun:test";
import {
  buildContextNetworkData,
  buildContextNetworkDataFromTinyChunkEmbeddings,
} from "./context-network-builder.ts";
import { StoryTopology } from "./story-topology.ts";

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
        blockPairCount: 4,
        blockPairSourceBlocks: Int32Array.from([0, 0, 2, 2]),
        blockPairTargetBlocks: Int32Array.from([1, 2, 1, 3]),
        blockPairStrengths: Float32Array.from([5.0, 1.0, 2.0, 3.0]),
      },
    });

    expect(data.manifest.sourceRevision).toBe(4);
    expect(data.manifest.fragmentCount).toBe(4);
    expect(data.manifest.edgeCount).toBe(4);
    expect(Array.from(data.offsets)).toEqual([0, 2, 2, 4, 4]);
    expect(Array.from(data.targets)).toEqual([1, 2, 3, 1]);
    expect(Array.from(data.strengths)).toEqual([5.0, 1.0, 3.0, 2.0]);
  });

  test("scores tiny chunk pairs and keeps the top m predecessor fragments", () => {
    const data = buildContextNetworkDataFromTinyChunkEmbeddings({
      sourceRevision: 7,
      orderedFragments: [
        { chapterId: 1, fragmentIndex: 0 },
        { chapterId: 1, fragmentIndex: 1 },
        { chapterId: 1, fragmentIndex: 2 },
      ],
      tinyChunks: [
        { fragmentGlobalIndex: 0 },
        { fragmentGlobalIndex: 1 },
        { fragmentGlobalIndex: 1 },
        { fragmentGlobalIndex: 2 },
        { fragmentGlobalIndex: 2 },
      ],
      embeddings: [
        [1, 0],
        [1, 0],
        [0.6, 0.8],
        [1, 0],
        [0.8, 0.6],
      ],
      maxOutgoingCandidates: 1,
    });

    expect(data.manifest.sourceRevision).toBe(7);
    expect(data.manifest.fragmentCount).toBe(3);
    expect(data.manifest.edgeCount).toBe(2);
    expect(Array.from(data.offsets)).toEqual([0, 0, 1, 2]);
    expect(Array.from(data.targets)).toEqual([0, 0]);
    expect(data.strengths[0]).toBeCloseTo(1.0, 5);
    expect(data.strengths[1]).toBeCloseTo(1.0, 5);
  });

  test("uses story topology to restrict visible predecessor chapters", () => {
    const topology = StoryTopology.createEmpty();
    topology.setMainRouteChapters([1, 2]);
    topology.addBranch({ id: "branch-a", name: "A", forkAfterChapterId: 1, chapters: [3] });

    const data = buildContextNetworkDataFromTinyChunkEmbeddings({
      sourceRevision: 8,
      orderedFragments: [
        { chapterId: 1, fragmentIndex: 0 },
        { chapterId: 1, fragmentIndex: 1 },
        { chapterId: 2, fragmentIndex: 0 },
        { chapterId: 3, fragmentIndex: 0 },
      ],
      tinyChunks: [
        { fragmentGlobalIndex: 0 },
        { fragmentGlobalIndex: 1 },
        { fragmentGlobalIndex: 2 },
        { fragmentGlobalIndex: 3 },
      ],
      embeddings: [
        [1, 0],
        [0.8, 0.2],
        [1, 0],
        [0.95, 0.05],
      ],
      maxOutgoingCandidates: 2,
      topology,
    });

    expect(data.manifest.edgeCount).toBe(5);
    expect(Array.from(data.offsets)).toEqual([0, 0, 1, 3, 5]);
    expect(Array.from(data.targets)).toEqual([0, 0, 1, 0, 1]);
    expect(data.strengths[3]).toBeCloseTo(0.998, 2);
    expect(data.strengths[4]).toBeCloseTo(0.982, 2);
  });
});