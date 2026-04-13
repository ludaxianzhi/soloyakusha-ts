import { Database } from 'bun:sqlite';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GlobalConfigManager } from '../../config/manager.ts';
import type { CompletionLogEntry, ErrorLogEntry } from '../../llm/types.ts';
import type { RequestHistoryWorkspaceContext } from './request-history-service.ts';

export interface UsageStatsSummary {
  translatedCharacters: number;
  translatedBlocks: number;
  modelCalls: number;
  failedModelCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface UsageStatsDailyPoint {
  date: string;
  translatedCharacters: number;
  translatedBlocks: number;
  modelCalls: number;
  failedModelCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface UsageStatsSnapshot {
  summary: UsageStatsSummary;
  dailyPoints: UsageStatsDailyPoint[];
}

type UsageStatsServiceOptions = {
  manager?: GlobalConfigManager;
  logDir?: string;
};

type LlmRequestRecord = {
  entry: CompletionLogEntry | ErrorLogEntry;
  succeeded: boolean;
  workspaceContext?: RequestHistoryWorkspaceContext;
};

type TranslationBlockRecord = {
  sourceText: string;
  translatedText: string;
  chapterId?: number;
  fragmentIndex?: number;
  stepId?: string;
  processorName?: string;
  workspaceContext?: RequestHistoryWorkspaceContext;
};

export class UsageStatsService {
  private readonly manager: GlobalConfigManager;
  private readonly logDir?: string;

  constructor(options: UsageStatsServiceOptions = {}) {
    this.manager = options.manager ?? new GlobalConfigManager();
    this.logDir = options.logDir;
  }

  getLogDir(): string {
    return this.logDir ?? join(dirname(this.manager.getFilePath()), 'activity');
  }

  async recordLlmRequest(input: LlmRequestRecord): Promise<void> {
    const statistics = 'statistics' in input.entry ? input.entry.statistics : undefined;
    await enqueueWrite(this.getDatabasePath(), async (db) => {
      db.query(
        `
          INSERT INTO usage_events (
            timestamp,
            kind,
            project_name,
            workspace_dir,
            source,
            feature,
            operation,
            workflow,
            stage,
            processor_name,
            model_name,
            source_characters,
            translated_characters,
            block_count,
            prompt_tokens,
            completion_tokens,
            total_tokens,
            succeeded,
            metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        new Date().toISOString(),
        'llm_request',
        input.workspaceContext?.projectName ?? null,
        input.workspaceContext?.workspaceDir ?? null,
        input.entry.meta?.label ?? null,
        input.entry.meta?.feature ?? null,
        input.entry.meta?.operation ?? null,
        input.entry.meta?.workflow ?? null,
        input.entry.meta?.stage ?? null,
        readStringContextValue(input.entry.meta?.context, 'processorName'),
        input.entry.modelName ?? null,
        readNumericContextValue(input.entry.meta?.context),
        0,
        0,
        statistics?.promptTokens ?? 0,
        statistics?.completionTokens ?? 0,
        statistics?.totalTokens ?? 0,
        input.succeeded ? 1 : 0,
        JSON.stringify({
          meta: input.entry.meta ?? undefined,
          requestConfig: input.entry.requestConfig ?? undefined,
          modelName: input.entry.modelName ?? undefined,
          durationSeconds: input.entry.durationSeconds ?? undefined,
        }),
      );
    });
  }

  async recordTranslationBlock(input: TranslationBlockRecord): Promise<void> {
    await enqueueWrite(this.getDatabasePath(), async (db) => {
      db.query(
        `
          INSERT INTO usage_events (
            timestamp,
            kind,
            project_name,
            workspace_dir,
            source,
            feature,
            operation,
            workflow,
            stage,
            processor_name,
            chapter_id,
            fragment_index,
            step_id,
            model_name,
            source_characters,
            translated_characters,
            block_count,
            prompt_tokens,
            completion_tokens,
            total_tokens,
            succeeded,
            metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        new Date().toISOString(),
        'translation_block',
        input.workspaceContext?.projectName ?? null,
        input.workspaceContext?.workspaceDir ?? null,
        'translation',
        'translation',
        'block-complete',
        input.processorName ?? null,
        input.stepId ?? null,
        input.processorName ?? null,
        input.chapterId ?? null,
        input.fragmentIndex ?? null,
        input.stepId ?? null,
        null,
        input.sourceText.length,
        input.translatedText.length,
        1,
        0,
        0,
        0,
        1,
        JSON.stringify({
          sourceTextLength: input.sourceText.length,
          translatedTextLength: input.translatedText.length,
          chapterId: input.chapterId,
          fragmentIndex: input.fragmentIndex,
          stepId: input.stepId,
          processorName: input.processorName,
        }),
      );
    });
  }

  async getSnapshot(days = 30): Promise<UsageStatsSnapshot> {
    const databasePath = this.getDatabasePath();
    try {
      await stat(databasePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        return {
          summary: emptySummary(),
          dailyPoints: [],
        };
      }
      throw error;
    }

    const db = openUsageDatabase(databasePath);
    try {
      const summary = db
        .query(
          `
            SELECT
              COALESCE(SUM(CASE WHEN kind = 'translation_block' THEN source_characters ELSE 0 END), 0) AS translated_characters,
              COALESCE(SUM(CASE WHEN kind = 'translation_block' THEN block_count ELSE 0 END), 0) AS translated_blocks,
              COALESCE(SUM(CASE WHEN kind = 'llm_request' THEN 1 ELSE 0 END), 0) AS model_calls,
              COALESCE(SUM(CASE WHEN kind = 'llm_request' AND succeeded = 0 THEN 1 ELSE 0 END), 0) AS failed_model_calls,
              COALESCE(SUM(CASE WHEN kind = 'llm_request' THEN prompt_tokens ELSE 0 END), 0) AS prompt_tokens,
              COALESCE(SUM(CASE WHEN kind = 'llm_request' THEN completion_tokens ELSE 0 END), 0) AS completion_tokens,
              COALESCE(SUM(CASE WHEN kind = 'llm_request' THEN total_tokens ELSE 0 END), 0) AS total_tokens
            FROM usage_events
          `,
        )
        .get() as UsageStatsSummaryRow | null;

      const rows = db
        .query(
          `
            SELECT
              substr(timestamp, 1, 10) AS date,
              COALESCE(SUM(CASE WHEN kind = 'translation_block' THEN source_characters ELSE 0 END), 0) AS translated_characters,
              COALESCE(SUM(CASE WHEN kind = 'translation_block' THEN block_count ELSE 0 END), 0) AS translated_blocks,
              COALESCE(SUM(CASE WHEN kind = 'llm_request' THEN 1 ELSE 0 END), 0) AS model_calls,
              COALESCE(SUM(CASE WHEN kind = 'llm_request' AND succeeded = 0 THEN 1 ELSE 0 END), 0) AS failed_model_calls,
              COALESCE(SUM(CASE WHEN kind = 'llm_request' THEN prompt_tokens ELSE 0 END), 0) AS prompt_tokens,
              COALESCE(SUM(CASE WHEN kind = 'llm_request' THEN completion_tokens ELSE 0 END), 0) AS completion_tokens,
              COALESCE(SUM(CASE WHEN kind = 'llm_request' THEN total_tokens ELSE 0 END), 0) AS total_tokens
            FROM usage_events
            GROUP BY substr(timestamp, 1, 10)
            ORDER BY substr(timestamp, 1, 10) DESC
            LIMIT ?
          `,
        )
        .all(days) as UsageStatsDailyRow[];

      return {
        summary: normalizeSummary(summary),
        dailyPoints: rows.reverse().map((row) => normalizeDailyRow(row)),
      };
    } finally {
      db.close(false);
    }
  }

  private getDatabasePath(): string {
    return join(this.getLogDir(), 'usage-stats.sqlite');
  }
}

function enqueueWrite(
  databasePath: string,
  task: (db: Database) => Promise<void>,
): Promise<void> {
  const previous = DATABASE_WRITE_QUEUES.get(databasePath) ?? Promise.resolve();
  const next = previous.then(async () => {
    await mkdir(dirname(databasePath), { recursive: true });
    const db = openUsageDatabase(databasePath);
    try {
      await task(db);
    } finally {
      db.close(false);
    }
  }, async () => {
    await mkdir(dirname(databasePath), { recursive: true });
    const db = openUsageDatabase(databasePath);
    try {
      await task(db);
    } finally {
      db.close(false);
    }
  });
  DATABASE_WRITE_QUEUES.set(databasePath, next);

  return next.finally(() => {
    if (DATABASE_WRITE_QUEUES.get(databasePath) === next) {
      DATABASE_WRITE_QUEUES.delete(databasePath);
    }
  });
}

function openUsageDatabase(databasePath: string): Database {
  const db = new Database(databasePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('llm_request', 'translation_block')),
      project_name TEXT,
      workspace_dir TEXT,
      source TEXT,
      feature TEXT,
      operation TEXT,
      workflow TEXT,
      stage TEXT,
      processor_name TEXT,
      chapter_id INTEGER,
      fragment_index INTEGER,
      step_id TEXT,
      model_name TEXT,
      source_characters INTEGER NOT NULL DEFAULT 0,
      translated_characters INTEGER NOT NULL DEFAULT 0,
      block_count INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      succeeded INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_timestamp
      ON usage_events(timestamp DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_events_kind_timestamp
      ON usage_events(kind, timestamp DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_events_project_timestamp
      ON usage_events(project_name, timestamp DESC, id DESC);
  `);
  return db;
}

function normalizeSummary(row: UsageStatsSummaryRow | null): UsageStatsSummary {
  return {
    translatedCharacters: row?.translated_characters ?? 0,
    translatedBlocks: row?.translated_blocks ?? 0,
    modelCalls: row?.model_calls ?? 0,
    failedModelCalls: row?.failed_model_calls ?? 0,
    promptTokens: row?.prompt_tokens ?? 0,
    completionTokens: row?.completion_tokens ?? 0,
    totalTokens: row?.total_tokens ?? 0,
  };
}

function normalizeDailyRow(row: UsageStatsDailyRow): UsageStatsDailyPoint {
  return {
    date: row.date,
    translatedCharacters: row.translated_characters,
    translatedBlocks: row.translated_blocks,
    modelCalls: row.model_calls,
    failedModelCalls: row.failed_model_calls,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
  };
}

function emptySummary(): UsageStatsSummary {
  return {
    translatedCharacters: 0,
    translatedBlocks: 0,
    modelCalls: 0,
    failedModelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
}

function readNumericContextValue(context: Record<string, unknown> | undefined): number {
  if (!context) {
    return 0;
  }
  const candidates = [
    context.sourceTextLength,
    context.selectedSourceTextLength,
    context.sourceCharacters,
    context.sourceChars,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return Math.floor(candidate);
    }
  }
  return 0;
}

function readStringContextValue(
  context: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = context?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

type UsageStatsSummaryRow = {
  translated_characters: number;
  translated_blocks: number;
  model_calls: number;
  failed_model_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

type UsageStatsDailyRow = UsageStatsSummaryRow & {
  date: string;
};

const DATABASE_WRITE_QUEUES = new Map<string, Promise<void>>();
