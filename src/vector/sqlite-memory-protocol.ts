import type { JsonObject } from "../llm/types.ts";
import type {
  VectorCollectionConfig,
  VectorDistanceMetric,
  VectorStoreCollectionDeleteParams,
  VectorStoreDeleteParams,
  VectorStoreQueryParams,
  VectorStoreUpsertParams,
} from "./types.ts";

export const SQLITE_MEMORY_MAX_DIMENSION = 256;
export const SQLITE_MEMORY_MAX_RECORDS = 50_000;

export type SqliteMemoryInitRequest = {
  id: number;
  type: "init";
  databasePath: string;
};

export type SqliteMemoryProbeRequest = {
  id: number;
  type: "probe";
};

export type SqliteMemoryEnsureCollectionRequest = {
  id: number;
  type: "ensureCollection";
  collection: VectorCollectionConfig;
};

export type SqliteMemoryRecordTransfer = {
  id: string;
  vector: Float32Array;
  payload?: JsonObject;
  document?: string;
};

export type SqliteMemoryUpsertRequest = {
  id: number;
  type: "upsert";
  params: Omit<VectorStoreUpsertParams, "records"> & {
    records: SqliteMemoryRecordTransfer[];
  };
};

export type SqliteMemoryQueryRequest = {
  id: number;
  type: "query";
  params: Omit<VectorStoreQueryParams, "vector"> & {
    vector: Float32Array;
  };
};

export type SqliteMemoryDeleteRequest = {
  id: number;
  type: "delete";
  params: VectorStoreDeleteParams;
};

export type SqliteMemoryDeleteCollectionRequest = {
  id: number;
  type: "deleteCollection";
  params: VectorStoreCollectionDeleteParams;
};

export type SqliteMemoryCloseRequest = {
  id: number;
  type: "close";
};

export type SqliteMemoryWorkerRequest =
  | SqliteMemoryInitRequest
  | SqliteMemoryProbeRequest
  | SqliteMemoryEnsureCollectionRequest
  | SqliteMemoryUpsertRequest
  | SqliteMemoryQueryRequest
  | SqliteMemoryDeleteRequest
  | SqliteMemoryDeleteCollectionRequest
  | SqliteMemoryCloseRequest;

export type SqliteMemoryResultVector = Float32Array;

export type SqliteMemoryQueryResult = {
  id: string;
  score: number;
  rawScore?: number;
  payload?: JsonObject;
  document?: string;
  vector?: SqliteMemoryResultVector;
};

export type SqliteMemoryWorkerResponse =
  | {
    id: number;
    ok: true;
    result?: undefined;
  }
  | {
    id: number;
    ok: true;
    result: SqliteMemoryQueryResult[];
  }
  | {
    id: number;
    ok: false;
    error: {
      name: string;
      message: string;
      stack?: string;
    };
  };

export type LoadedCollectionRow = {
  name: string;
  dimension: number;
  distance: VectorDistanceMetric;
  metadata_json: string | null;
  options_json: string | null;
};

export type LoadedPointRow = {
  point_id: string;
  vector_blob: Uint8Array | ArrayBuffer | ArrayBufferView;
  payload_json: string | null;
  document_text: string | null;
  norm_squared: number;
};