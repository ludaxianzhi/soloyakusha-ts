import { VectorStoreClientProvider } from "./provider.ts";
import type {
  ChunkLinkGraphWorkerComputeRequest,
  ChunkLinkGraphWorkerErrorEvent,
  ChunkLinkGraphWorkerProgressEvent,
  ChunkLinkGraphWorkerRequest,
  ChunkLinkGraphWorkerResponse,
  ChunkLinkGraphWorkerResult,
} from "./chunk-link-graph-protocol.ts";

const DEFAULT_PROGRESS_STEPS = 20;

globalThis.addEventListener("message", (event: MessageEvent<ChunkLinkGraphWorkerRequest>) => {
  void handleRequest(event.data);
});

async function handleRequest(request: ChunkLinkGraphWorkerRequest): Promise<void> {
  try {
    switch (request.type) {
      case "compute": {
        const result = await computeChunkLinkGraph(request);
        const matrixBuffer = result.matrix.buffer as ArrayBuffer;
        postMessage({ type: "result", result }, [matrixBuffer]);
        return;
      }
    }
  } catch (error) {
    const normalized = normalizeError(error);
    postMessage({
      type: "error",
      error: normalized,
    });
  }
}

async function computeChunkLinkGraph(
  request: ChunkLinkGraphWorkerComputeRequest,
): Promise<ChunkLinkGraphWorkerResult> {
  const {
    vectorStoreConfig,
    flatEmbeddings,
    dimension,
    lineCount,
    blockSize,
    topCandidates,
    topPercent,
    upsertBatchSize,
    tempCollectionName,
  } = request.params;

  validateParameters({
    flatEmbeddings,
    dimension,
    lineCount,
    blockSize,
    topCandidates,
    topPercent,
    upsertBatchSize,
  });

  const provider = new VectorStoreClientProvider();
  provider.register("chunk-link-graph", vectorStoreConfig);
  const client = provider.getClient("chunk-link-graph");
  const collectionName = tempCollectionName ?? `chunk-link-graph-${Date.now()}-${crypto.randomUUID()}`;
  let collectionCreated = false;

  try {
    await client.ensureCollection({
      name: collectionName,
      dimension,
      distance: vectorStoreConfig.distance,
    });
    collectionCreated = true;

    await upsertEmbeddings({
      client,
      collectionName,
      flatEmbeddings,
      dimension,
      lineCount,
      upsertBatchSize,
    });

    const candidateCapacity = lineCount * topCandidates;
    const sourceRows = new Int32Array(candidateCapacity);
    const targetRows = new Int32Array(candidateCapacity);
    const scores = new Float32Array(candidateCapacity);

    const retrievedCandidateCount = await collectTopCandidates({
      client,
      collectionName,
      flatEmbeddings,
      dimension,
      lineCount,
      topCandidates,
      sourceRows,
      targetRows,
      scores,
    });

    const crossBlockCandidateCount = filterCrossBlockEdges({
      sourceRows,
      targetRows,
      scores,
      edgeCount: retrievedCandidateCount,
      blockSize,
    });

    const blockCount = Math.ceil(lineCount / blockSize);
    const matrix = new Int32Array(blockCount * blockCount);
    if (crossBlockCandidateCount === 0) {
      emitProgress("matrix", "块间连接矩阵计算进度", 1, 1);
      return {
        lineCount,
        blockSize,
        blockCount,
        topCandidates,
        topPercent,
        thresholdScore: null,
        candidateEdgeCount: retrievedCandidateCount,
        crossBlockCandidateCount,
        strongEdgeCount: 0,
        bidirectionalEdgeCount: 0,
        matrix,
      };
    }

    const strongEdges = selectStrongEdges({
      sourceRows,
      targetRows,
      scores,
      edgeCount: crossBlockCandidateCount,
      topPercent,
    });

    const bidirectionalEdgeCount = buildMatrixFromBidirectionalEdges({
      strongSourceRows: strongEdges.sourceRows,
      strongTargetRows: strongEdges.targetRows,
      strongEdgeCount: strongEdges.edgeCount,
      blockSize,
      blockCount,
      matrix,
    });

    return {
      lineCount,
      blockSize,
      blockCount,
      topCandidates,
      topPercent,
      thresholdScore: strongEdges.thresholdScore,
      candidateEdgeCount: retrievedCandidateCount,
      crossBlockCandidateCount,
      strongEdgeCount: strongEdges.edgeCount,
      bidirectionalEdgeCount,
      matrix,
    };
  } finally {
    if (collectionCreated) {
      emitProgress("cleanup", "临时 collection 清理进度", 0, 1);
      try {
        await client.deleteCollection({
          collectionName,
        });
      } catch {
      }
      emitProgress("cleanup", "临时 collection 清理进度", 1, 1);
    }
    await provider.closeAll();
  }
}

async function upsertEmbeddings(params: {
  client: ReturnType<VectorStoreClientProvider["getClient"]>;
  collectionName: string;
  flatEmbeddings: Float32Array;
  dimension: number;
  lineCount: number;
  upsertBatchSize: number;
}): Promise<void> {
  const { client, collectionName, flatEmbeddings, dimension, lineCount, upsertBatchSize } = params;

  for (let start = 0; start < lineCount; start += upsertBatchSize) {
    const end = Math.min(lineCount, start + upsertBatchSize);
    const records = new Array(end - start);
    for (let rowIndex = start; rowIndex < end; rowIndex += 1) {
      const vectorOffset = rowIndex * dimension;
      records[rowIndex - start] = {
        id: String(rowIndex),
        vector: Array.from(flatEmbeddings.subarray(vectorOffset, vectorOffset + dimension)),
      };
    }

    await client.upsert({
      collectionName,
      records,
    });
    emitProgress("upsert", "向量写入进度", end, lineCount);
  }
}

async function collectTopCandidates(params: {
  client: ReturnType<VectorStoreClientProvider["getClient"]>;
  collectionName: string;
  flatEmbeddings: Float32Array;
  dimension: number;
  lineCount: number;
  topCandidates: number;
  sourceRows: Int32Array;
  targetRows: Int32Array;
  scores: Float32Array;
}): Promise<number> {
  const {
    client,
    collectionName,
    flatEmbeddings,
    dimension,
    lineCount,
    topCandidates,
    sourceRows,
    targetRows,
    scores,
  } = params;

  let edgeCount = 0;
  const queryTopK = Math.min(lineCount, topCandidates + 1);
  for (let rowIndex = 0; rowIndex < lineCount; rowIndex += 1) {
    const vectorOffset = rowIndex * dimension;
    const results = await client.query({
      collectionName,
      vector: Array.from(flatEmbeddings.subarray(vectorOffset, vectorOffset + dimension)),
      topK: queryTopK,
    });

    let selectedCount = 0;
    for (const result of results) {
      const targetRow = Number.parseInt(result.id, 10);
      if (!Number.isInteger(targetRow) || targetRow < 0 || targetRow >= lineCount) {
        continue;
      }
      if (targetRow === rowIndex) {
        continue;
      }

      sourceRows[edgeCount] = rowIndex;
      targetRows[edgeCount] = targetRow;
      scores[edgeCount] = result.score;
      edgeCount += 1;
      selectedCount += 1;

      if (selectedCount >= topCandidates) {
        break;
      }
    }

    emitProgress("topk", "top10 获取进度", rowIndex + 1, lineCount);
  }

  return edgeCount;
}

function filterCrossBlockEdges(params: {
  sourceRows: Int32Array;
  targetRows: Int32Array;
  scores: Float32Array;
  edgeCount: number;
  blockSize: number;
}): number {
  const { sourceRows, targetRows, scores, edgeCount, blockSize } = params;
  let writeIndex = 0;
  for (let readIndex = 0; readIndex < edgeCount; readIndex += 1) {
    if (
      Math.floor(sourceRows[readIndex]! / blockSize) ===
        Math.floor(targetRows[readIndex]! / blockSize)
    ) {
      emitPeriodicProgress("filter", "强连接过滤计算进度", readIndex + 1, edgeCount);
      continue;
    }

    sourceRows[writeIndex] = sourceRows[readIndex]!;
    targetRows[writeIndex] = targetRows[readIndex]!;
    scores[writeIndex] = scores[readIndex]!;
    writeIndex += 1;
    emitPeriodicProgress("filter", "强连接过滤计算进度", readIndex + 1, edgeCount);
  }

  return writeIndex;
}

function selectStrongEdges(params: {
  sourceRows: Int32Array;
  targetRows: Int32Array;
  scores: Float32Array;
  edgeCount: number;
  topPercent: number;
}): {
  thresholdScore: number;
  edgeCount: number;
  sourceRows: Int32Array;
  targetRows: Int32Array;
} {
  const { sourceRows, targetRows, scores, edgeCount, topPercent } = params;
  const order = new Uint32Array(edgeCount);
  for (let index = 0; index < edgeCount; index += 1) {
    order[index] = index;
  }
  order.sort((left, right) => scores[right]! - scores[left]!);

  const retainedCount = Math.max(1, Math.ceil(edgeCount * topPercent / 100));
  const thresholdScore = scores[order[retainedCount - 1]!]!;
  const strongSourceRows = new Int32Array(edgeCount);
  const strongTargetRows = new Int32Array(edgeCount);
  let strongEdgeCount = 0;

  for (let index = 0; index < edgeCount; index += 1) {
    const candidateIndex = order[index]!;
    if (scores[candidateIndex]! < thresholdScore) {
      break;
    }
    strongSourceRows[strongEdgeCount] = sourceRows[candidateIndex]!;
    strongTargetRows[strongEdgeCount] = targetRows[candidateIndex]!;
    strongEdgeCount += 1;
    emitPeriodicProgress("bidirectional", "双向强连接确认进度", strongEdgeCount, edgeCount);
  }

  return {
    thresholdScore,
    edgeCount: strongEdgeCount,
    sourceRows: strongSourceRows.subarray(0, strongEdgeCount),
    targetRows: strongTargetRows.subarray(0, strongEdgeCount),
  };
}

function buildMatrixFromBidirectionalEdges(params: {
  strongSourceRows: Int32Array;
  strongTargetRows: Int32Array;
  strongEdgeCount: number;
  blockSize: number;
  blockCount: number;
  matrix: Int32Array;
}): number {
  const {
    strongSourceRows,
    strongTargetRows,
    strongEdgeCount,
    blockSize,
    blockCount,
    matrix,
  } = params;

  const edgeSet = new Set<bigint>();
  for (let index = 0; index < strongEdgeCount; index += 1) {
    edgeSet.add(packEdgeKey(strongSourceRows[index]!, strongTargetRows[index]!));
  }

  let bidirectionalEdgeCount = 0;
  for (let index = 0; index < strongEdgeCount; index += 1) {
    const sourceRow = strongSourceRows[index]!;
    const targetRow = strongTargetRows[index]!;
    if (!edgeSet.has(packEdgeKey(targetRow, sourceRow))) {
      emitPeriodicProgress("matrix", "块间连接矩阵计算进度", index + 1, strongEdgeCount);
      continue;
    }

    const sourceBlock = Math.floor(sourceRow / blockSize);
    const targetBlock = Math.floor(targetRow / blockSize);
    if (sourceBlock !== targetBlock) {
      const matrixIndex = sourceBlock * blockCount + targetBlock;
      matrix[matrixIndex] = (matrix[matrixIndex] ?? 0) + 1;
    }
    bidirectionalEdgeCount += 1;
    emitPeriodicProgress("matrix", "块间连接矩阵计算进度", index + 1, strongEdgeCount);
  }

  return bidirectionalEdgeCount;
}

function validateParameters(params: {
  flatEmbeddings: Float32Array;
  dimension: number;
  lineCount: number;
  blockSize: number;
  topCandidates: number;
  topPercent: number;
  upsertBatchSize: number;
}): void {
  const {
    flatEmbeddings,
    dimension,
    lineCount,
    blockSize,
    topCandidates,
    topPercent,
    upsertBatchSize,
  } = params;

  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new Error("dimension 必须是正整数");
  }
  if (!Number.isInteger(lineCount) || lineCount <= 0) {
    throw new Error("lineCount 必须是正整数");
  }
  if (flatEmbeddings.length !== lineCount * dimension) {
    throw new Error("flatEmbeddings 长度与 lineCount * dimension 不一致");
  }
  if (!Number.isInteger(blockSize) || blockSize <= 0) {
    throw new Error("blockSize 必须是正整数");
  }
  if (!Number.isInteger(topCandidates) || topCandidates <= 0) {
    throw new Error("topCandidates 必须是正整数");
  }
  if (!(topPercent > 0 && topPercent <= 100)) {
    throw new Error("topPercent 必须在 0 到 100 之间");
  }
  if (!Number.isInteger(upsertBatchSize) || upsertBatchSize <= 0) {
    throw new Error("upsertBatchSize 必须是正整数");
  }
}

function emitProgress(
  phase: ChunkLinkGraphWorkerProgressEvent["phase"],
  message: string,
  processed: number,
  total: number,
): void {
  const payload: ChunkLinkGraphWorkerProgressEvent = {
    type: "progress",
    phase,
    message,
    processed,
    total,
  };
  postMessage(payload);
}

function emitPeriodicProgress(
  phase: ChunkLinkGraphWorkerProgressEvent["phase"],
  message: string,
  processed: number,
  total: number,
): void {
  if (total <= DEFAULT_PROGRESS_STEPS || processed === total) {
    emitProgress(phase, message, processed, total);
    return;
  }

  const stepSize = Math.max(1, Math.floor(total / DEFAULT_PROGRESS_STEPS));
  if (processed % stepSize === 0) {
    emitProgress(phase, message, processed, total);
  }
}

function packEdgeKey(sourceRow: number, targetRow: number): bigint {
  return (BigInt(sourceRow >>> 0) << 32n) | BigInt(targetRow >>> 0);
}

function normalizeError(error: unknown): ChunkLinkGraphWorkerResponse extends { type: "error"; error: infer T }
  ? T
  : ChunkLinkGraphWorkerErrorEvent["error"] {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: "Error",
    message: typeof error === "string" ? error : "块连接图 worker 执行失败",
  };
}