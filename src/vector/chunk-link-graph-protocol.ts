import type { VectorStoreConfig } from "./types.ts";

export type ChunkLinkGraphProgressPhase =
  | "upsert"
  | "topk"
  | "filter"
  | "bidirectional"
  | "matrix"
  | "cleanup";

export type ChunkLinkGraphWorkerComputeRequest = {
  type: "compute";
  params: {
    vectorStoreConfig: VectorStoreConfig;
    flatEmbeddings: Float32Array;
    dimension: number;
    lineCount: number;
    blockSize: number;
    topCandidates: number;
    topPercent: number;
    upsertBatchSize: number;
    tempCollectionName?: string;
  };
};

export type ChunkLinkGraphWorkerRequest = ChunkLinkGraphWorkerComputeRequest;

export type ChunkLinkGraphWorkerProgressEvent = {
  type: "progress";
  phase: ChunkLinkGraphProgressPhase;
  message: string;
  processed: number;
  total: number;
};

export type ChunkLinkGraphWorkerResult = {
  lineCount: number;
  blockSize: number;
  blockCount: number;
  topCandidates: number;
  topPercent: number;
  thresholdScore: number | null;
  candidateEdgeCount: number;
  crossBlockCandidateCount: number;
  strongEdgeCount: number;
  bidirectionalEdgeCount: number;
  blockPairCount: number;
  blockPairSourceBlocks: Int32Array;
  blockPairTargetBlocks: Int32Array;
  blockPairStrengths: Int32Array;
};

export type ChunkLinkGraphWorkerResultEvent = {
  type: "result";
  result: ChunkLinkGraphWorkerResult;
};

export type ChunkLinkGraphWorkerErrorEvent = {
  type: "error";
  error: {
    name: string;
    message: string;
    stack?: string;
  };
};

export type ChunkLinkGraphWorkerResponse =
  | ChunkLinkGraphWorkerProgressEvent
  | ChunkLinkGraphWorkerResultEvent
  | ChunkLinkGraphWorkerErrorEvent;