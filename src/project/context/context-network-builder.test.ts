import { describe, expect, test } from "bun:test";
import {
  buildContextNetworkDataFromTinyChunkEmbeddings,
} from "./context-network-builder.ts";
import { StoryTopology } from "./story-topology.ts";

describe("buildContextNetworkData", () => {
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