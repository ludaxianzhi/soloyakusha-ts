import type { OrderedFragmentSnapshot } from "../pipeline/pipeline.ts";
import type { StoryTopology } from "./story-topology.ts";
import {
  CONTEXT_NETWORK_SCHEMA_VERSION,
  type ContextNetworkData,
} from "./context-network-types.ts";

type OutgoingEdge = {
  target: number;
  strength: number;
};

type TinyChunkEmbeddingInput = {
  fragmentGlobalIndex: number;
};

type NormalizedVector = {
  values: ReadonlyArray<number> | Float32Array;
  norm: number;
};

export function buildContextNetworkDataFromTinyChunkEmbeddings(params: {
  sourceRevision: number;
  orderedFragments: ReadonlyArray<OrderedFragmentSnapshot>;
  tinyChunks: ReadonlyArray<TinyChunkEmbeddingInput>;
  embeddings: ReadonlyArray<ReadonlyArray<number> | Float32Array>;
  maxOutgoingCandidates: number;
  topology?: StoryTopology;
}): ContextNetworkData {
  const {
    sourceRevision,
    orderedFragments,
    tinyChunks,
    embeddings,
    maxOutgoingCandidates,
    topology,
  } = params;

  if (!Number.isInteger(maxOutgoingCandidates) || maxOutgoingCandidates <= 0) {
    throw new Error(`maxOutgoingCandidates 必须是正整数，当前为 ${String(maxOutgoingCandidates)}`);
  }
  if (tinyChunks.length !== embeddings.length) {
    throw new Error(
      `Tiny chunk 与 embedding 数量不匹配: tinyChunks=${tinyChunks.length}, embeddings=${embeddings.length}`,
    );
  }

  const fragmentCount = orderedFragments.length;
  const outgoing = new Map<number, OutgoingEdge[]>();
  const predecessorChapterIdsByChapter = buildPredecessorChapterIdsByChapter(
    orderedFragments,
    topology,
  );
  const fragmentGlobalIndicesByChapter = buildFragmentGlobalIndicesByChapter(orderedFragments);
  const normalizedEmbeddings = embeddings.map((embedding, index) =>
    normalizeEmbedding(embedding, index),
  );
  const tinyChunkIndicesByFragment = buildTinyChunkIndicesByFragment({
    tinyChunks,
    fragmentCount,
  });

  for (let sourceGlobalIndex = 0; sourceGlobalIndex < fragmentCount; sourceGlobalIndex += 1) {
    const sourceFragment = orderedFragments[sourceGlobalIndex];
    if (!sourceFragment) {
      continue;
    }

    const sourceTinyChunkIndices = tinyChunkIndicesByFragment[sourceGlobalIndex] ?? [];
    if (sourceTinyChunkIndices.length === 0) {
      continue;
    }

    const candidateGlobalIndices = collectVisiblePredecessorFragmentIndices({
      sourceGlobalIndex,
      sourceFragment,
      orderedFragments,
      predecessorChapterIdsByChapter,
      fragmentGlobalIndicesByChapter,
    });

    const scoredCandidates = candidateGlobalIndices
      .map((targetGlobalIndex) => {
        const targetTinyChunkIndices = tinyChunkIndicesByFragment[targetGlobalIndex] ?? [];
        if (targetTinyChunkIndices.length === 0) {
          return undefined;
        }

        return {
          target: targetGlobalIndex,
          strength: scoreFragmentPair({
            sourceTinyChunkIndices,
            targetTinyChunkIndices,
            embeddings: normalizedEmbeddings,
          }),
        } satisfies OutgoingEdge;
      })
      .filter((candidate): candidate is OutgoingEdge => candidate !== undefined)
      .sort((left, right) => right.strength - left.strength || left.target - right.target)
      .slice(0, maxOutgoingCandidates);

    if (scoredCandidates.length > 0) {
      outgoing.set(sourceGlobalIndex, scoredCandidates);
    }
  }

  return createContextNetworkData({
    sourceRevision,
    fragmentCount,
    blockSize: 1,
    outgoing,
  });
}

function createContextNetworkData(params: {
  sourceRevision: number;
  fragmentCount: number;
  blockSize: number;
  outgoing: ReadonlyMap<number, ReadonlyArray<OutgoingEdge>>;
}): ContextNetworkData {
  const { sourceRevision, fragmentCount, blockSize, outgoing } = params;
  const offsets = new Uint32Array(fragmentCount + 1);
  const targets: number[] = [];
  const strengths: number[] = [];
  let maxOutgoingPerNode = 0;

  for (let source = 0; source < fragmentCount; source += 1) {
    const neighbors = [...(outgoing.get(source) ?? [])].sort(
      (left, right) => right.strength - left.strength || left.target - right.target,
    );
    maxOutgoingPerNode = Math.max(maxOutgoingPerNode, neighbors.length);
    offsets[source] = targets.length;
    for (const neighbor of neighbors) {
      targets.push(neighbor.target);
      strengths.push(neighbor.strength);
    }
  }
  offsets[fragmentCount] = targets.length;

  return {
    manifest: {
      schemaVersion: CONTEXT_NETWORK_SCHEMA_VERSION,
      sourceRevision,
      fragmentCount,
      blockSize,
      edgeCount: targets.length,
      maxOutgoingPerNode,
      createdAt: new Date().toISOString(),
    },
    offsets,
    targets: Int32Array.from(targets),
    strengths: Float32Array.from(strengths),
  };
}

function buildPredecessorChapterIdsByChapter(
  orderedFragments: ReadonlyArray<OrderedFragmentSnapshot>,
  topology: StoryTopology | undefined,
): Map<number, number[]> {
  const chapterIds = [...new Set(orderedFragments.map((fragment) => fragment.chapterId))];
  const predecessorChapterIdsByChapter = new Map<number, number[]>();

  for (const chapterId of chapterIds) {
    predecessorChapterIdsByChapter.set(
      chapterId,
      topology?.getPredecessorChapterIds(chapterId) ?? fallbackPredecessorChapterIds(chapterIds, chapterId),
    );
  }

  return predecessorChapterIdsByChapter;
}

function fallbackPredecessorChapterIds(chapterIds: number[], chapterId: number): number[] {
  const index = chapterIds.indexOf(chapterId);
  return index <= 0 ? [] : chapterIds.slice(0, index);
}

function buildFragmentGlobalIndicesByChapter(
  orderedFragments: ReadonlyArray<OrderedFragmentSnapshot>,
): Map<number, number[]> {
  const result = new Map<number, number[]>();

  orderedFragments.forEach((fragment, globalIndex) => {
    const existing = result.get(fragment.chapterId) ?? [];
    existing.push(globalIndex);
    result.set(fragment.chapterId, existing);
  });

  return result;
}

function buildTinyChunkIndicesByFragment(params: {
  tinyChunks: ReadonlyArray<TinyChunkEmbeddingInput>;
  fragmentCount: number;
}): number[][] {
  const { tinyChunks, fragmentCount } = params;
  const result = Array.from({ length: fragmentCount }, () => [] as number[]);

  tinyChunks.forEach((chunk, chunkIndex) => {
    if (!Number.isInteger(chunk.fragmentGlobalIndex) || chunk.fragmentGlobalIndex < 0 || chunk.fragmentGlobalIndex >= fragmentCount) {
      throw new Error(
        `Chunk 到片段映射越界: chunk=${chunkIndex}, fragment=${String(chunk.fragmentGlobalIndex)}`,
      );
    }

    result[chunk.fragmentGlobalIndex]!.push(chunkIndex);
  });

  return result;
}

function collectVisiblePredecessorFragmentIndices(params: {
  sourceGlobalIndex: number;
  sourceFragment: OrderedFragmentSnapshot;
  orderedFragments: ReadonlyArray<OrderedFragmentSnapshot>;
  predecessorChapterIdsByChapter: ReadonlyMap<number, ReadonlyArray<number>>;
  fragmentGlobalIndicesByChapter: ReadonlyMap<number, ReadonlyArray<number>>;
}): number[] {
  const {
    sourceGlobalIndex,
    sourceFragment,
    predecessorChapterIdsByChapter,
    fragmentGlobalIndicesByChapter,
  } = params;
  const result = new Set<number>();

  const sameChapterIndices = fragmentGlobalIndicesByChapter.get(sourceFragment.chapterId) ?? [];
  for (const candidateGlobalIndex of sameChapterIndices) {
    if (candidateGlobalIndex >= sourceGlobalIndex) {
      break;
    }

    const candidate = params.orderedFragments[candidateGlobalIndex];
    if (!candidate) {
      continue;
    }
    if (candidate.fragmentIndex < sourceFragment.fragmentIndex) {
      result.add(candidateGlobalIndex);
    }
  }

  const predecessorChapterIds = predecessorChapterIdsByChapter.get(sourceFragment.chapterId) ?? [];
  for (const predecessorChapterId of predecessorChapterIds) {
    const candidateIndices = fragmentGlobalIndicesByChapter.get(predecessorChapterId) ?? [];
    for (const candidateGlobalIndex of candidateIndices) {
      result.add(candidateGlobalIndex);
    }
  }

  return [...result];
}

function scoreFragmentPair(params: {
  sourceTinyChunkIndices: ReadonlyArray<number>;
  targetTinyChunkIndices: ReadonlyArray<number>;
  embeddings: ReadonlyArray<NormalizedVector>;
}): number {
  const { sourceTinyChunkIndices, targetTinyChunkIndices, embeddings } = params;
  const retainedScoreCount = Math.min(sourceTinyChunkIndices.length, targetTinyChunkIndices.length);
  if (retainedScoreCount <= 0) {
    return 0;
  }

  const scores: number[] = [];
  for (const sourceTinyChunkIndex of sourceTinyChunkIndices) {
    for (const targetTinyChunkIndex of targetTinyChunkIndices) {
      scores.push(calculateCosineSimilarity(
        embeddings[sourceTinyChunkIndex]!,
        embeddings[targetTinyChunkIndex]!,
      ));
    }
  }

  scores.sort((left, right) => right - left);
  const retainedScores = scores.slice(0, retainedScoreCount);
  const total = retainedScores.reduce((sum, score) => sum + score, 0);
  return total / retainedScores.length;
}

function normalizeEmbedding(
  embedding: ReadonlyArray<number> | Float32Array,
  index: number,
): NormalizedVector {
  if (embedding.length === 0) {
    throw new Error(`第 ${index} 个 tiny chunk embedding 为空`);
  }

  let sumSquares = 0;
  for (let offset = 0; offset < embedding.length; offset += 1) {
    const value = embedding[offset] ?? 0;
    sumSquares += value * value;
  }

  const norm = Math.sqrt(sumSquares);
  if (!(norm > 0)) {
    throw new Error(`第 ${index} 个 tiny chunk embedding 的范数必须大于 0`);
  }

  return {
    values: embedding,
    norm,
  };
}

function calculateCosineSimilarity(left: NormalizedVector, right: NormalizedVector): number {
  if (left.values.length !== right.values.length) {
    throw new Error(
      `tiny chunk embedding 维度不一致: left=${left.values.length}, right=${right.values.length}`,
    );
  }

  let dot = 0;
  for (let offset = 0; offset < left.values.length; offset += 1) {
    dot += (left.values[offset] ?? 0) * (right.values[offset] ?? 0);
  }

  return dot / (left.norm * right.norm);
}