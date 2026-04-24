// @ts-expect-error Bun import attributes resolve this worker module to a file URL string.
import workerEntry from "./chunk-link-graph-worker.ts" with { type: "file" };
import { NOOP_LOGGER, type Logger } from "../project/logger.ts";
import type {
  ChunkLinkGraphWorkerProgressEvent,
  ChunkLinkGraphWorkerResponse,
  ChunkLinkGraphWorkerResult,
} from "./chunk-link-graph-protocol.ts";
import type { VectorStoreConfig } from "./types.ts";

type WorkerFactory = () => Worker;

export type ChunkLinkGraphComputeParams = {
  vectorStoreConfig: VectorStoreConfig;
  embeddings: ReadonlyArray<ReadonlyArray<number> | Float32Array>;
  blockSize: number;
  topCandidates?: number;
  topPercent?: number;
  upsertBatchSize?: number;
  tempCollectionName?: string;
};

export type ChunkLinkGraphResult = ChunkLinkGraphWorkerResult;

export class ChunkLinkGraphCalculator {
  private readonly logger: Logger;
  private readonly workerFactory: WorkerFactory;

  constructor(options: {
    logger?: Logger;
    workerFactory?: WorkerFactory;
  } = {}) {
    this.logger = options.logger ?? NOOP_LOGGER;
    this.workerFactory = options.workerFactory ?? (() => new Worker(workerEntry, { type: "module" }));
  }

  async compute(params: ChunkLinkGraphComputeParams): Promise<ChunkLinkGraphResult> {
    const prepared = flattenEmbeddings(params.embeddings);
    const worker = this.workerFactory();

    return await new Promise<ChunkLinkGraphResult>((resolve, reject) => {
      const cleanup = () => {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        worker.terminate();
      };

      const onMessage = (event: MessageEvent<ChunkLinkGraphWorkerResponse>) => {
        const payload = event.data;
        if (payload.type === "progress") {
          this.logProgress(payload);
          return;
        }

        cleanup();
        if (payload.type === "result") {
          resolve(payload.result);
          return;
        }

        reject(rehydrateWorkerError(payload.error));
      };

      const onError = (event: ErrorEvent) => {
        cleanup();
        reject(event.error instanceof Error ? event.error : new Error(event.message));
      };

      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.postMessage({
        type: "compute",
        params: {
          vectorStoreConfig: params.vectorStoreConfig,
          flatEmbeddings: prepared.flatEmbeddings,
          dimension: prepared.dimension,
          lineCount: prepared.lineCount,
          blockSize: params.blockSize,
          topCandidates: params.topCandidates ?? 10,
          topPercent: params.topPercent ?? 25,
          upsertBatchSize: params.upsertBatchSize ?? 256,
          tempCollectionName: params.tempCollectionName,
        },
      }, [prepared.flatEmbeddings.buffer]);
    });
  }

  private logProgress(progress: ChunkLinkGraphWorkerProgressEvent): void {
    this.logger.info?.(progress.message, {
      phase: progress.phase,
      processed: progress.processed,
      total: progress.total,
      ratio: progress.total === 0 ? 1 : progress.processed / progress.total,
    });
  }
}

export async function computeChunkLinkGraph(
  params: ChunkLinkGraphComputeParams,
  options: {
    logger?: Logger;
    workerFactory?: WorkerFactory;
  } = {},
): Promise<ChunkLinkGraphResult> {
  const calculator = new ChunkLinkGraphCalculator(options);
  return await calculator.compute(params);
}

function flattenEmbeddings(
  embeddings: ReadonlyArray<ReadonlyArray<number> | Float32Array>,
): {
  flatEmbeddings: Float32Array;
  dimension: number;
  lineCount: number;
} {
  const firstEmbedding = embeddings[0];
  if (!firstEmbedding) {
    throw new Error("embeddings 不能为空");
  }

  const dimension = firstEmbedding.length;
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new Error("向量维度必须是正整数");
  }

  const flatEmbeddings = new Float32Array(embeddings.length * dimension);
  for (let index = 0; index < embeddings.length; index += 1) {
    const embedding = embeddings[index];
    if (!embedding || embedding.length !== dimension) {
      throw new Error(`第 ${index} 行向量维度不一致`);
    }

    flatEmbeddings.set(embedding, index * dimension);
  }

  return {
    flatEmbeddings,
    dimension,
    lineCount: embeddings.length,
  };
}

function rehydrateWorkerError(error: {
  name: string;
  message: string;
  stack?: string;
}): Error {
  const created = new Error(error.message);
  created.name = error.name;
  created.stack = error.stack;
  return created;
}