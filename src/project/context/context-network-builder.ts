import type { ChunkLinkGraphResult } from "../../vector/chunk-link-graph.ts";
import {
  CONTEXT_NETWORK_SCHEMA_VERSION,
  type ContextNetworkData,
} from "./context-network-types.ts";

type OutgoingEdge = {
  target: number;
  strength: number;
};

export function buildContextNetworkData(params: {
  sourceRevision: number;
  fragmentCount: number;
  graph: ChunkLinkGraphResult;
}): ContextNetworkData {
  const { sourceRevision, fragmentCount, graph } = params;
  if (graph.blockSize !== 1) {
    throw new Error(`仅支持 blockSize=1 的 chunk link graph，当前为 ${graph.blockSize}`);
  }
  if (graph.blockCount !== fragmentCount || graph.lineCount !== fragmentCount) {
    throw new Error(
      `chunk link graph 片段数量不匹配: blockCount=${graph.blockCount}, lineCount=${graph.lineCount}, fragmentCount=${fragmentCount}`,
    );
  }
  validateBlockPairLengths(graph);

  const outgoing = new Map<number, OutgoingEdge[]>();
  for (let index = 0; index < graph.blockPairCount; index += 1) {
    const source = graph.blockPairSourceBlocks[index];
    const target = graph.blockPairTargetBlocks[index];
    const strength = graph.blockPairStrengths[index];
    if (source === undefined || target === undefined || strength === undefined) {
      continue;
    }
    if (
      source < 0 ||
      source >= fragmentCount ||
      target < 0 ||
      target >= fragmentCount
    ) {
      throw new Error(`chunk link graph block pair 越界: source=${source}, target=${target}`);
    }

    const existing = outgoing.get(source) ?? [];
    existing.push({ target, strength });
    outgoing.set(source, existing);
  }

  return createContextNetworkData({
    sourceRevision,
    fragmentCount,
    blockSize: graph.blockSize,
    outgoing,
  });
}

export function buildContextNetworkDataFromTinyChunkGraph(params: {
  sourceRevision: number;
  fragmentCount: number;
  chunkToFragmentIndices: ReadonlyArray<number>;
  graph: ChunkLinkGraphResult;
  minEdgeStrength?: number;
}): ContextNetworkData {
  const {
    sourceRevision,
    fragmentCount,
    chunkToFragmentIndices,
    graph,
    minEdgeStrength = 0.5,
  } = params;
  if (graph.blockSize !== 1) {
    throw new Error(`仅支持 blockSize=1 的 tiny chunk link graph，当前为 ${graph.blockSize}`);
  }
  if (graph.blockCount !== graph.lineCount) {
    throw new Error(
      `Tiny chunk link graph 数据无效: blockCount=${graph.blockCount}, lineCount=${graph.lineCount}`,
    );
  }
  if (chunkToFragmentIndices.length !== graph.lineCount) {
    throw new Error(
      `Chunk 映射长度不匹配: chunkToFragmentIndices=${chunkToFragmentIndices.length}, lineCount=${graph.lineCount}`,
    );
  }
  if (!(minEdgeStrength > 0)) {
    throw new Error(`minEdgeStrength 必须是正数，当前为 ${String(minEdgeStrength)}`);
  }
  validateBlockPairLengths(graph);

  const pairStrengths = new Map<string, number>();
  for (let chunkIndex = 0; chunkIndex < chunkToFragmentIndices.length; chunkIndex += 1) {
    const fragmentIndex = chunkToFragmentIndices[chunkIndex];
    if (
      fragmentIndex === undefined ||
      fragmentIndex < 0 ||
      fragmentIndex >= fragmentCount
    ) {
      throw new Error(
        `Chunk 到片段映射越界: chunk=${chunkIndex}, fragment=${String(fragmentIndex)}`,
      );
    }
  }

  for (let index = 0; index < graph.blockPairCount; index += 1) {
    const sourceChunk = graph.blockPairSourceBlocks[index];
    const targetChunk = graph.blockPairTargetBlocks[index];
    const strength = graph.blockPairStrengths[index];
    if (
      sourceChunk === undefined ||
      targetChunk === undefined ||
      strength === undefined
    ) {
      continue;
    }
    if (
      sourceChunk < 0 ||
      sourceChunk >= graph.lineCount ||
      targetChunk < 0 ||
      targetChunk >= graph.lineCount
    ) {
      throw new Error(
        `Tiny chunk link graph block pair 越界: source=${sourceChunk}, target=${targetChunk}`,
      );
    }

    const sourceFragment = chunkToFragmentIndices[sourceChunk]!;
    const targetFragment = chunkToFragmentIndices[targetChunk]!;
    if (sourceFragment === targetFragment) {
      continue;
    }

    const pairKey = `${sourceFragment}:${targetFragment}`;
    pairStrengths.set(pairKey, (pairStrengths.get(pairKey) ?? 0) + strength);
  }

  const outgoing = new Map<number, OutgoingEdge[]>();
  for (const [pairKey, strength] of pairStrengths) {
    if (strength < minEdgeStrength) {
      continue;
    }

    const [sourceText, targetText] = pairKey.split(":");
    const source = Number.parseInt(sourceText ?? "", 10);
    const target = Number.parseInt(targetText ?? "", 10);
    if (!Number.isInteger(source) || !Number.isInteger(target)) {
      throw new Error(`Tiny chunk 片段聚合键无效: ${pairKey}`);
    }

    const existing = outgoing.get(source) ?? [];
    existing.push({ target, strength });
    outgoing.set(source, existing);
  }

  return createContextNetworkData({
    sourceRevision,
    fragmentCount,
    blockSize: 1,
    outgoing,
  });
}

function validateBlockPairLengths(graph: ChunkLinkGraphResult): void {
  if (
    graph.blockPairSourceBlocks.length !== graph.blockPairCount ||
    graph.blockPairTargetBlocks.length !== graph.blockPairCount ||
    graph.blockPairStrengths.length !== graph.blockPairCount
  ) {
    throw new Error("chunk link graph block pair 数据长度不一致");
  }
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