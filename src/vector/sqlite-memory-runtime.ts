import ddot from "@stdlib/blas-base-ddot";
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { JsonObject, JsonValue } from "../llm/types.ts";
import type {
  VectorCollectionConfig,
  VectorCollectionInfo,
  VectorDistanceMetric,
} from "./types.ts";
import {
  SQLITE_MEMORY_MAX_DIMENSION,
  SQLITE_MEMORY_MAX_RECORDS,
  type LoadedCollectionRow,
  type LoadedPointRow,
  type SqliteMemoryQueryResult,
  type SqliteMemoryRecordTransfer,
  type SqliteMemoryWorkerRequest,
  type SqliteMemoryWorkerResponse,
} from "./sqlite-memory-protocol.ts";

type CachedRecord = {
  id: string;
  vector: Float32Array;
  payload?: JsonObject;
  document?: string;
  normSquared: number;
};

type CachedCollection = {
  name: string;
  dimension: number;
  distance: VectorDistanceMetric;
  metadata?: JsonObject;
  options?: JsonObject;
  records: CachedRecord[];
  indexById: Map<string, number>;
};

export function createSqliteMemoryWorkerRuntime(
  emit: (response: SqliteMemoryWorkerResponse, transfer?: Transferable[]) => void,
): { handleRequest: (request: SqliteMemoryWorkerRequest) => Promise<void> } {
  let databasePath: string | undefined;
  let database: Database | undefined;
  const collections = new Map<string, CachedCollection>();

  async function handleRequest(request: SqliteMemoryWorkerRequest): Promise<void> {
    try {
      switch (request.type) {
        case "init":
          await initializeDatabase(request.databasePath);
          return postSuccess(request.id);
        case "probe":
          requireDatabase().query("SELECT 1").get();
          return postSuccess(request.id);
        case "listCollections":
          return postSuccess(request.id, await listCollections());
        case "ensureCollection": {
          const collection = await ensureCollectionLoaded(request.collection);
          validateCollectionBounds(collection.dimension, collection.records.length);
          return postSuccess(request.id);
        }
        case "deleteCollection": {
          await deleteCollection(request.params.collectionName);
          return postSuccess(request.id);
        }
        case "upsert": {
          const collection = await loadExistingCollection(request.params.collectionName);
          await upsertIntoCollection(collection, request.params.records);
          return postSuccess(request.id);
        }
        case "query": {
          const collection = await loadExistingCollection(request.params.collectionName);
          const results = queryCollection(
            collection,
            request.params.vector,
            request.params.topK,
            request.params.filter,
            request.params.includeVectors ?? false,
          );
          return postSuccess(request.id, results, collectTransferables(results));
        }
        case "delete": {
          const collection = await loadExistingCollection(request.params.collectionName);
          await deleteFromCollection(collection, request.params.ids, request.params.filter);
          return postSuccess(request.id);
        }
        case "close":
          closeDatabase();
          return postSuccess(request.id);
      }
    } catch (error) {
      postError(request.id, error);
    }
  }

  async function initializeDatabase(path: string): Promise<void> {
    if (database) {
      if (databasePath !== path) {
        throw new Error(`sqlite-memory worker 已绑定到其他数据库: ${databasePath}`);
      }
      return;
    }

    await mkdir(dirname(path), { recursive: true });
    databasePath = path;
    database = new Database(path, { create: true });
    database.exec(`
      CREATE TABLE IF NOT EXISTS vector_collections (
        name TEXT PRIMARY KEY,
        dimension INTEGER NOT NULL,
        distance TEXT NOT NULL,
        metadata_json TEXT,
        options_json TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS vector_points (
        collection_name TEXT NOT NULL,
        point_id TEXT NOT NULL,
        vector_blob BLOB NOT NULL,
        payload_json TEXT,
        document_text TEXT,
        norm_squared REAL NOT NULL,
        PRIMARY KEY (collection_name, point_id),
        FOREIGN KEY (collection_name) REFERENCES vector_collections(name) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_vector_points_collection_name
        ON vector_points(collection_name);
    `);
  }

  async function ensureCollectionLoaded(config: VectorCollectionConfig): Promise<CachedCollection> {
    validateCollectionBounds(config.dimension, 0);
    const db = requireDatabase();
    const existing = db.query(
      `SELECT name, dimension, distance, metadata_json, options_json
         FROM vector_collections
        WHERE name = ?1`,
    ).get(config.name) as LoadedCollectionRow | null;

    if (!existing) {
      db.query(
        `INSERT INTO vector_collections (
           name,
           dimension,
           distance,
           metadata_json,
           options_json,
           updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, unixepoch())`,
      ).run(
        config.name,
        config.dimension,
        config.distance ?? "cosine",
        stringifyJson(config.metadata),
        stringifyJson(config.options),
      );
    } else {
      validateCollectionConfig(existing, config);
    }

    return await loadExistingCollection(config.name);
  }

  async function loadExistingCollection(name: string): Promise<CachedCollection> {
    const cached = collections.get(name);
    if (cached) {
      return cached;
    }

    const db = requireDatabase();
    const row = db.query(
      `SELECT name, dimension, distance, metadata_json, options_json
         FROM vector_collections
        WHERE name = ?1`,
    ).get(name) as LoadedCollectionRow | null;
    if (!row) {
      throw new Error(`未找到向量集合: ${name}`);
    }

    const pointRows = db.query(
      `SELECT point_id, vector_blob, payload_json, document_text, norm_squared
         FROM vector_points
        WHERE collection_name = ?1`,
    ).all(name) as LoadedPointRow[];

    const records = pointRows.map((pointRow) => ({
      id: pointRow.point_id,
      vector: decodeVectorBlob(pointRow.vector_blob, row.dimension),
      payload: parseJsonObject(pointRow.payload_json),
      document: pointRow.document_text ?? undefined,
      normSquared: pointRow.norm_squared,
    }));
    const collection: CachedCollection = {
      name: row.name,
      dimension: row.dimension,
      distance: row.distance,
      metadata: parseJsonObject(row.metadata_json),
      options: parseJsonObject(row.options_json),
      records,
      indexById: buildIndexById(records),
    };
    validateCollectionBounds(collection.dimension, collection.records.length);
    collections.set(name, collection);
    return collection;
  }

  async function deleteCollection(name: string): Promise<void> {
    const db = requireDatabase();
    db.query(
      `DELETE FROM vector_collections
        WHERE name = ?1`,
    ).run(name);
    collections.delete(name);
  }

  async function upsertIntoCollection(
    collection: CachedCollection,
    records: SqliteMemoryRecordTransfer[],
  ): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const normalized = records.map((record) => normalizeRecord(record, collection.dimension));
    const futureCount = collection.records.length + countNewIds(collection, normalized);
    validateCollectionBounds(collection.dimension, futureCount);

    const db = requireDatabase();
    const transaction = db.transaction((rows: CachedRecord[]) => {
      const statement = db.query(
        `INSERT INTO vector_points (
           collection_name,
           point_id,
           vector_blob,
           payload_json,
           document_text,
           norm_squared
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(collection_name, point_id)
         DO UPDATE SET
           vector_blob = excluded.vector_blob,
           payload_json = excluded.payload_json,
           document_text = excluded.document_text,
           norm_squared = excluded.norm_squared`,
      );
      for (const record of rows) {
        statement.run(
          collection.name,
          record.id,
          encodeVectorBlob(record.vector),
          stringifyJson(record.payload),
          record.document ?? null,
          record.normSquared,
        );
      }
      db.query(
        `UPDATE vector_collections
            SET updated_at = unixepoch()
          WHERE name = ?1`,
      ).run(collection.name);
    });
    transaction(normalized);

    for (const record of normalized) {
      const existingIndex = collection.indexById.get(record.id);
      if (existingIndex === undefined) {
        collection.indexById.set(record.id, collection.records.length);
        collection.records.push(record);
        continue;
      }

      collection.records[existingIndex] = record;
    }
  }

  function queryCollection(
    collection: CachedCollection,
    queryVector: Float32Array,
    topK: number,
    filter: JsonObject | undefined,
    includeVectors: boolean,
  ): SqliteMemoryQueryResult[] {
    if (topK <= 0) {
      return [];
    }

    if (queryVector.length !== collection.dimension) {
      throw new Error(
        `查询向量维度不匹配: 期望 ${collection.dimension}, 实际 ${queryVector.length}`,
      );
    }

    const queryNormSquared = computeNormSquared(queryVector);
    const best: Array<{ record: CachedRecord; score: number; rawScore: number }> = [];
    for (const record of collection.records) {
      if (!matchesFilter(record.payload, filter)) {
        continue;
      }

      const { score, rawScore } = scoreRecord(
        collection.distance,
        queryVector,
        queryNormSquared,
        record,
      );
      insertTopResult(best, { record, score, rawScore }, topK);
    }

    return best.map(({ record, score, rawScore }) => ({
      id: record.id,
      score,
      rawScore,
      payload: record.payload ? { ...record.payload } : undefined,
      document: record.document,
      vector: includeVectors ? record.vector.slice() : undefined,
    }));
  }

  async function deleteFromCollection(
    collection: CachedCollection,
    ids: string[] | undefined,
    filter: JsonObject | undefined,
  ): Promise<void> {
    const targetIds = ids && ids.length > 0
      ? ids
      : filter
        ? collection.records.filter((record) => matchesFilter(record.payload, filter)).map((record) => record.id)
        : [];
    if (targetIds.length === 0) {
      if (!filter && (!ids || ids.length === 0)) {
        throw new Error("sqlite-memory 删除操作必须提供 ids 或 filter");
      }
      return;
    }

    const db = requireDatabase();
    const transaction = db.transaction((pointIds: string[]) => {
      const statement = db.query(
        `DELETE FROM vector_points
          WHERE collection_name = ?1
            AND point_id = ?2`,
      );
      for (const pointId of pointIds) {
        statement.run(collection.name, pointId);
      }
      db.query(
        `UPDATE vector_collections
            SET updated_at = unixepoch()
          WHERE name = ?1`,
      ).run(collection.name);
    });
    transaction(targetIds);

    const idSet = new Set(targetIds);
    collection.records = collection.records.filter((record) => !idSet.has(record.id));
    collection.indexById = buildIndexById(collection.records);
  }

  function normalizeRecord(record: SqliteMemoryRecordTransfer, dimension: number): CachedRecord {
    const vector = record.vector instanceof Float32Array
      ? record.vector
      : Float32Array.from(record.vector);
    if (vector.length !== dimension) {
      throw new Error(`向量维度不匹配: 期望 ${dimension}, 实际 ${vector.length}`);
    }

    return {
      id: record.id,
      vector,
      payload: record.payload ? { ...record.payload } : undefined,
      document: record.document,
      normSquared: computeNormSquared(vector),
    };
  }

  function validateCollectionConfig(
    existing: LoadedCollectionRow,
    incoming: VectorCollectionConfig,
  ): void {
    if (existing.dimension !== incoming.dimension) {
      throw new Error(
        `向量集合 ${incoming.name} 维度不匹配: 已存在 ${existing.dimension}, 请求 ${incoming.dimension}`,
      );
    }
    const resolvedDistance = incoming.distance ?? "cosine";
    if (existing.distance !== resolvedDistance) {
      throw new Error(
        `向量集合 ${incoming.name} 距离类型不匹配: 已存在 ${existing.distance}, 请求 ${resolvedDistance}`,
      );
    }
  }

  function validateCollectionBounds(dimension: number, recordCount: number): void {
    if (!Number.isInteger(dimension) || dimension <= 0 || dimension > SQLITE_MEMORY_MAX_DIMENSION) {
      throw new Error(
        `sqlite-memory 仅支持 1-${SQLITE_MEMORY_MAX_DIMENSION} 维向量，当前为 ${dimension}`,
      );
    }
    if (recordCount > SQLITE_MEMORY_MAX_RECORDS) {
      throw new Error(
        `sqlite-memory 单集合最多支持 ${SQLITE_MEMORY_MAX_RECORDS} 条记录，当前将达到 ${recordCount}`,
      );
    }
  }

  function countNewIds(collection: CachedCollection, records: CachedRecord[]): number {
    let count = 0;
    const seen = new Set<string>();
    for (const record of records) {
      if (seen.has(record.id)) {
        continue;
      }
      seen.add(record.id);
      if (!collection.indexById.has(record.id)) {
        count += 1;
      }
    }
    return count;
  }

  function computeNormSquared(vector: Float32Array): number {
    return dotProduct(vector, vector);
  }

  function scoreRecord(
    distance: VectorDistanceMetric,
    queryVector: Float32Array,
    queryNormSquared: number,
    record: CachedRecord,
  ): { score: number; rawScore: number } {
    switch (distance) {
      case "dot": {
        const dot = dotProduct(queryVector, record.vector);
        return { score: dot, rawScore: dot };
      }
      case "cosine": {
        const dot = dotProduct(queryVector, record.vector);
        const denominator = Math.sqrt(queryNormSquared * record.normSquared);
        const cosine = denominator === 0 ? 0 : dot / denominator;
        return { score: cosine, rawScore: cosine };
      }
      case "euclid": {
        const dot = dotProduct(queryVector, record.vector);
        const distanceValue = Math.sqrt(Math.max(0, queryNormSquared + record.normSquared - 2 * dot));
        return {
          score: 1 / (1 + distanceValue),
          rawScore: distanceValue,
        };
      }
      case "manhattan": {
        let distanceValue = 0;
        for (let index = 0; index < queryVector.length; index++) {
          distanceValue += Math.abs((queryVector[index] as number) - (record.vector[index] as number));
        }
        return {
          score: 1 / (1 + distanceValue),
          rawScore: distanceValue,
        };
      }
    }
  }

  function dotProduct(left: Float32Array, right: Float32Array): number {
    return ddot(
      left.length,
      left as unknown as Float64Array,
      1,
      right as unknown as Float64Array,
      1,
    );
  }

  function matchesFilter(payload: JsonObject | undefined, filter: JsonObject | undefined): boolean {
    if (!filter) {
      return true;
    }
    if (!payload) {
      return false;
    }

    for (const [key, expected] of Object.entries(filter)) {
      validateFilterValue(key, expected);
      if (payload[key] !== expected) {
        return false;
      }
    }
    return true;
  }

  function validateFilterValue(key: string, value: JsonValue): void {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return;
    }
    throw new Error(`sqlite-memory filter 暂不支持复杂值: ${key}`);
  }

  function insertTopResult(
    best: Array<{ record: CachedRecord; score: number; rawScore: number }>,
    candidate: { record: CachedRecord; score: number; rawScore: number },
    topK: number,
  ): void {
    if (best.length === 0) {
      best.push(candidate);
      return;
    }

    if (best.length < topK || candidate.score > (best[best.length - 1]?.score ?? Number.NEGATIVE_INFINITY)) {
      best.push(candidate);
      let index = best.length - 1;
      while (index > 0 && (best[index - 1]?.score ?? Number.NEGATIVE_INFINITY) < (best[index]?.score ?? Number.NEGATIVE_INFINITY)) {
        const current = best[index] as { record: CachedRecord; score: number; rawScore: number };
        best[index] = best[index - 1] as { record: CachedRecord; score: number; rawScore: number };
        best[index - 1] = current;
        index -= 1;
      }
      if (best.length > topK) {
        best.length = topK;
      }
    }
  }

  function buildIndexById(records: CachedRecord[]): Map<string, number> {
    const indexById = new Map<string, number>();
    for (const [index, record] of records.entries()) {
      indexById.set(record.id, index);
    }
    return indexById;
  }

  function encodeVectorBlob(vector: Float32Array): Uint8Array {
    return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
  }

  function decodeVectorBlob(blob: Uint8Array | ArrayBuffer | ArrayBufferView, dimension: number): Float32Array {
    const bytes = toUint8Array(blob);
    if (bytes.byteLength !== dimension * Float32Array.BYTES_PER_ELEMENT) {
      throw new Error(
        `数据库中的向量长度与集合维度不匹配: 期望 ${dimension * Float32Array.BYTES_PER_ELEMENT} 字节, 实际 ${bytes.byteLength} 字节`,
      );
    }

    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }

  function toUint8Array(blob: Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array {
    if (blob instanceof Uint8Array) {
      return blob;
    }
    if (blob instanceof ArrayBuffer) {
      return new Uint8Array(blob);
    }
    if (ArrayBuffer.isView(blob)) {
      return new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
    }
    throw new Error("无法解析 SQLite BLOB 向量数据");
  }

  function stringifyJson(value: JsonObject | undefined): string | null {
    return value ? JSON.stringify(value) : null;
  }

  function parseJsonObject(json: string | null): JsonObject | undefined {
    if (!json) {
      return undefined;
    }

    return JSON.parse(json) as JsonObject;
  }

  function collectTransferables(results: SqliteMemoryQueryResult[]): Transferable[] {
    return results.flatMap((result) => result.vector ? [result.vector.buffer as Transferable] : []);
  }

  function requireDatabase(): Database {
    if (!database) {
      throw new Error("sqlite-memory worker 尚未初始化");
    }
    return database;
  }

  function closeDatabase(): void {
    collections.clear();
    if (!database) {
      return;
    }

    database.close();
    database = undefined;
    databasePath = undefined;
  }

  function postSuccess(
    id: number,
    result?: SqliteMemoryQueryResult[] | VectorCollectionInfo[],
    transfer: Transferable[] = [],
  ): void {
    const response: SqliteMemoryWorkerResponse = result
      ? { id, ok: true, result }
      : { id, ok: true };
    emit(response, transfer);
  }

  function postError(id: number, error: unknown): void {
    const normalized = error instanceof Error
      ? error
      : new Error(typeof error === "string" ? error : "sqlite-memory worker 未知错误");
    const response: SqliteMemoryWorkerResponse = {
      id,
      ok: false,
      error: {
        name: normalized.name,
        message: normalized.message,
        stack: normalized.stack,
      },
    };
    emit(response);
  }

  async function listCollections(): Promise<VectorCollectionInfo[]> {
    const db = requireDatabase();
    const rows = db.query(
      `SELECT name, dimension, distance, metadata_json, options_json
         FROM vector_collections
        ORDER BY name ASC`,
    ).all() as LoadedCollectionRow[];

    return rows.map((row) => ({
      name: row.name,
      dimension: row.dimension,
      distance: row.distance,
      metadata: parseJsonObject(row.metadata_json),
      options: parseJsonObject(row.options_json),
    } satisfies VectorCollectionInfo));
  }

  return { handleRequest };
}