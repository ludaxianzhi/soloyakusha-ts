/**
 * 使用 SQLite 持久化 LLM 请求历史，便于按来源、时间和元信息筛选查询。
 *
 * @module llm/history
 */

import { Database } from "bun:sqlite";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  CompletionLogEntry,
  ErrorLogEntry,
  LlmRequestHistoryEntry,
  RequestHistoryLogger,
} from "./types.ts";

export class FileRequestHistoryLogger implements RequestHistoryLogger {
  private readonly databasePath: string;
  private readonly source: string;

  constructor(logDir = "logs", logName = "llm_requests") {
    this.databasePath = getHistoryDatabasePath(logDir);
    this.source = logName;
  }

  async logCompletion(entry: CompletionLogEntry): Promise<void> {
    await this.writeEntry({
      source: this.source,
      version: 1,
      requestId: entry.requestId,
      timestamp: new Date().toISOString(),
      type: "completion",
      prompt: entry.prompt,
      response: entry.response,
      requestConfig: entry.requestConfig,
      meta: entry.meta,
      statistics: entry.statistics,
      modelName: entry.modelName,
      durationSeconds: entry.durationSeconds,
      reasoning: entry.reasoning,
    });
  }

  async logError(entry: ErrorLogEntry): Promise<void> {
    await this.writeEntry({
      source: this.source,
      version: 1,
      requestId: entry.requestId,
      timestamp: new Date().toISOString(),
      type: "error",
      prompt: entry.prompt,
      errorMessage: entry.errorMessage,
      responseBody: entry.responseBody,
      requestConfig: entry.requestConfig,
      meta: entry.meta,
      modelName: entry.modelName,
      durationSeconds: entry.durationSeconds,
    });
  }

  async readRecentEntries(limit = 100): Promise<LlmRequestHistoryEntry[]> {
    return readHistoryEntriesFromDatabase(this.databasePath, {
      limit,
      source: this.source,
    });
  }

  async getLogFileSize(): Promise<number> {
    try {
      return (await stat(this.databasePath)).size;
    } catch (error) {
      if (isMissingFileError(error)) {
        return 0;
      }
      throw error;
    }
  }

  async getBackupFileSize(): Promise<number> {
    return 0;
  }

  private async writeEntry(entry: LlmRequestHistoryEntry): Promise<void> {
    await enqueueDatabaseWrite(this.databasePath, async () => {
      await mkdir(dirname(this.databasePath), { recursive: true });
      const db = openHistoryDatabase(this.databasePath);
      try {
        db.query(
          `
            INSERT INTO llm_request_history (
              source,
              version,
              request_id,
              timestamp,
              type,
              prompt,
              response,
              error_message,
              response_body,
              request_config_json,
              meta_label,
              meta_feature,
              meta_operation,
              meta_component,
              meta_workflow,
              meta_stage,
              meta_json,
              statistics_json,
              model_name,
              duration_seconds,
              reasoning
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        ).run(
          entry.source ?? this.source,
          entry.version,
          entry.requestId,
          entry.timestamp,
          entry.type,
          entry.prompt,
          entry.response ?? null,
          entry.errorMessage ?? null,
          entry.responseBody ?? null,
          stringifyNullableJson(entry.requestConfig),
          entry.meta?.label ?? null,
          entry.meta?.feature ?? null,
          entry.meta?.operation ?? null,
          entry.meta?.component ?? null,
          entry.meta?.workflow ?? null,
          entry.meta?.stage ?? null,
          stringifyNullableJson(entry.meta),
          stringifyNullableJson(entry.statistics),
          entry.modelName ?? null,
          entry.durationSeconds ?? null,
          entry.reasoning ?? null,
        );
      } finally {
        db.close(false);
      }
    });
  }
}

export async function readHistoryEntriesFromLogDir(
  logDir: string,
  limit = 200,
): Promise<LlmRequestHistoryEntry[]> {
  return readHistoryEntriesFromDatabase(getHistoryDatabasePath(logDir), { limit });
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

const DATABASE_WRITE_QUEUES = new Map<string, Promise<void>>();

type HistoryReadOptions = {
  limit: number;
  source?: string;
};

async function readHistoryEntriesFromDatabase(
  databasePath: string,
  options: HistoryReadOptions,
): Promise<LlmRequestHistoryEntry[]> {
  try {
    await stat(databasePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }

  const db = openHistoryDatabase(databasePath);
  try {
    const rows = options.source
      ? (db
          .query(
            `
              SELECT
                source,
                version,
                request_id,
                timestamp,
                type,
                prompt,
                response,
                error_message,
                response_body,
                request_config_json,
                meta_json,
                statistics_json,
                model_name,
                duration_seconds,
                reasoning
              FROM llm_request_history
              WHERE source = ?
              ORDER BY timestamp DESC, id DESC
              LIMIT ?
            `,
          )
          .all(options.source, options.limit) as HistoryRow[])
      : (db
          .query(
            `
              SELECT
                source,
                version,
                request_id,
                timestamp,
                type,
                prompt,
                response,
                error_message,
                response_body,
                request_config_json,
                meta_json,
                statistics_json,
                model_name,
                duration_seconds,
                reasoning
              FROM llm_request_history
              ORDER BY timestamp DESC, id DESC
              LIMIT ?
            `,
          )
          .all(options.limit) as HistoryRow[]);
    return rows.map(mapHistoryRow);
  } finally {
    db.close(false);
  }
}

async function enqueueDatabaseWrite(
  databasePath: string,
  task: () => Promise<void>,
): Promise<void> {
  const previous = DATABASE_WRITE_QUEUES.get(databasePath) ?? Promise.resolve();
  const next = previous.then(task, task);
  DATABASE_WRITE_QUEUES.set(databasePath, next);

  try {
    await next;
  } finally {
    if (DATABASE_WRITE_QUEUES.get(databasePath) === next) {
      DATABASE_WRITE_QUEUES.delete(databasePath);
    }
  }
}

function openHistoryDatabase(databasePath: string): Database {
  const db = new Database(databasePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_request_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      version INTEGER NOT NULL,
      request_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('completion', 'error')),
      prompt TEXT NOT NULL,
      response TEXT,
      error_message TEXT,
      response_body TEXT,
      request_config_json TEXT,
      meta_label TEXT,
      meta_feature TEXT,
      meta_operation TEXT,
      meta_component TEXT,
      meta_workflow TEXT,
      meta_stage TEXT,
      meta_json TEXT,
      statistics_json TEXT,
      model_name TEXT,
      duration_seconds REAL,
      reasoning TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_llm_request_history_timestamp
      ON llm_request_history(timestamp DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_llm_request_history_source_timestamp
      ON llm_request_history(source, timestamp DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_llm_request_history_meta_label
      ON llm_request_history(meta_label);
  `);
  return db;
}

function getHistoryDatabasePath(logDir: string): string {
  return join(logDir, "llm-request-history.sqlite");
}

type HistoryRow = {
  source: string;
  version: number;
  request_id: string;
  timestamp: string;
  type: "completion" | "error";
  prompt: string;
  response: string | null;
  error_message: string | null;
  response_body: string | null;
  request_config_json: string | null;
  meta_json: string | null;
  statistics_json: string | null;
  model_name: string | null;
  duration_seconds: number | null;
  reasoning: string | null;
};

function mapHistoryRow(row: HistoryRow): LlmRequestHistoryEntry {
  return {
    version: row.version === 1 ? 1 : 1,
    requestId: row.request_id,
    timestamp: row.timestamp,
    type: row.type === "error" ? "error" : "completion",
    source: row.source,
    prompt: row.prompt,
    response: row.response ?? undefined,
    errorMessage: row.error_message ?? undefined,
    responseBody: row.response_body ?? undefined,
    requestConfig: parseJsonColumn(row.request_config_json),
    meta: parseJsonColumn(row.meta_json),
    statistics: parseJsonColumn(row.statistics_json),
    modelName: row.model_name ?? undefined,
    durationSeconds: row.duration_seconds ?? undefined,
    reasoning: row.reasoning ?? undefined,
  };
}

function stringifyNullableJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJsonColumn<T>(value: string | null): T | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}
