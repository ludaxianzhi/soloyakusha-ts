import type { ChunkLinkGraphResult } from "../vector/chunk-link-graph.ts";
import {
  CONTEXT_NETWORK_SCHEMA_VERSION,
  type ContextNetworkData,
} from "./context-network-types.ts";

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
  if (
    graph.blockPairSourceBlocks.length !== graph.blockPairCount ||
    graph.blockPairTargetBlocks.length !== graph.blockPairCount ||
    graph.blockPairStrengths.length !== graph.blockPairCount
  ) {
    throw new Error("chunk link graph block pair 数据长度不一致");
  }

  const outgoing = new Map<number, Array<{ target: number; strength: number }>>();
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
      blockSize: graph.blockSize,
      edgeCount: targets.length,
      maxOutgoingPerNode,
      createdAt: new Date().toISOString(),
    },
    offsets,
    targets: Int32Array.from(targets),
    strengths: Int32Array.from(strengths),
  };
}