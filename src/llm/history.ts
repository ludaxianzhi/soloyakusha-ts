/**
 * 实现基于文件的请求历史记录器，用于落盘保存结构化请求日志。
 *
 * 本模块提供 {@link FileRequestHistoryLogger} 类，用于：
 * - 记录每次 LLM 请求的 prompt、response 和统计信息
 * - 记录失败请求的错误信息
 * - 日志文件自动轮转（超过 10MB 时备份）
 *
 * 日志格式为 JSON Lines（JSONL），便于结构化读取与前端详情展示。
 *
 * @module llm/history
 */

import {
  appendFile,
  readdir,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  CompletionLogEntry,
  ErrorLogEntry,
  LlmRequestHistoryEntry,
  RequestHistoryLogger,
} from "./types.ts";

/**
 * 基于文件的请求历史记录器，负责追加入盘与日志轮转。
 *
 * 日志轮转：
 * - 当日志文件超过 MAX_FILE_SIZE（10MB）时
 * - 将当前文件重命名为 .jsonl.bak
 * - 新日志写入空文件
 */
export class FileRequestHistoryLogger implements RequestHistoryLogger {
  static readonly MAX_FILE_SIZE = 10 * 1024 * 1024;

  private readonly logFilePath: string;
  private readonly backupFilePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(logDir = "logs", logName = "llm_requests") {
    this.logFilePath = join(logDir, `${logName}.jsonl`);
    this.backupFilePath = join(logDir, `${logName}.jsonl.bak`);
  }

  async logCompletion(entry: CompletionLogEntry): Promise<void> {
    await this.writeEntry({
      version: 1,
      requestId: entry.requestId,
      timestamp: new Date().toISOString(),
      type: "completion",
      prompt: entry.prompt,
      response: entry.response,
      requestConfig: entry.requestConfig,
      statistics: entry.statistics,
      modelName: entry.modelName,
      durationSeconds: entry.durationSeconds,
    });
  }

  async logError(entry: ErrorLogEntry): Promise<void> {
    await this.writeEntry({
      version: 1,
      requestId: entry.requestId,
      timestamp: new Date().toISOString(),
      type: "error",
      prompt: entry.prompt,
      errorMessage: entry.errorMessage,
      responseBody: entry.responseBody,
      requestConfig: entry.requestConfig,
      modelName: entry.modelName,
      durationSeconds: entry.durationSeconds,
    });
  }

  async readRecentEntries(limit = 100): Promise<LlmRequestHistoryEntry[]> {
    const entries = await readHistoryEntriesFromFiles([
      this.backupFilePath,
      this.logFilePath,
    ]);
    return entries.slice(-limit);
  }

  async getLogFileSize(): Promise<number> {
    try {
      return (await stat(this.logFilePath)).size;
    } catch (error) {
      if (isMissingFileError(error)) {
        return 0;
      }
      throw error;
    }
  }

  async getBackupFileSize(): Promise<number> {
    try {
      return (await stat(this.backupFilePath)).size;
    } catch (error) {
      if (isMissingFileError(error)) {
        return 0;
      }
      throw error;
    }
  }

  private async writeEntry(entry: LlmRequestHistoryEntry): Promise<void> {
    const task = async () => {
      await mkdir(dirname(this.logFilePath), { recursive: true });
      await this.rotateIfNeeded();
      await appendFile(this.logFilePath, `${JSON.stringify(entry)}\n`, "utf8");
    };

    this.writeQueue = this.writeQueue.then(task, task);
    await this.writeQueue;
  }

  private async rotateIfNeeded(): Promise<void> {
    let fileSize = 0;
    try {
      fileSize = (await stat(this.logFilePath)).size;
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }

    if (fileSize < FileRequestHistoryLogger.MAX_FILE_SIZE) {
      return;
    }

    await rm(this.backupFilePath, { force: true });
    await rename(this.logFilePath, this.backupFilePath);
  }
}

export async function readHistoryEntriesFromLogDir(
  logDir: string,
  limit = 200,
): Promise<LlmRequestHistoryEntry[]> {
  try {
    const fileNames = await readdir(logDir);
    const logFiles = fileNames
      .filter(
        (fileName) =>
          fileName.endsWith(".jsonl") || fileName.endsWith(".jsonl.bak"),
      )
      .map((fileName) => join(logDir, fileName));
    const entries = await readHistoryEntriesFromFiles(logFiles);
    return entries
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, limit);
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
}

export async function readHistoryEntriesFromFiles(
  filePaths: string[],
): Promise<LlmRequestHistoryEntry[]> {
  const entries = await Promise.all(
    filePaths.map(async (filePath) => {
      try {
        const content = await readFile(filePath, "utf8");
        return content
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            try {
              return parseHistoryEntry(line, inferHistorySource(filePath));
            } catch {
              return null;
            }
          })
          .filter((entry): entry is LlmRequestHistoryEntry => entry !== null);
      } catch (error) {
        if (isMissingFileError(error)) {
          return [];
        }
        throw error;
      }
    }),
  );
  return entries.flat();
}

function parseHistoryEntry(
  line: string,
  source: string,
): LlmRequestHistoryEntry {
  const parsed = JSON.parse(line) as Partial<LlmRequestHistoryEntry>;
  return {
    version: 1,
    requestId: String(parsed.requestId ?? ""),
    timestamp: String(parsed.timestamp ?? new Date(0).toISOString()),
    type: parsed.type === "error" ? "error" : "completion",
    source,
    prompt: String(parsed.prompt ?? ""),
    response: typeof parsed.response === "string" ? parsed.response : undefined,
    errorMessage:
      typeof parsed.errorMessage === "string" ? parsed.errorMessage : undefined,
    responseBody:
      typeof parsed.responseBody === "string" ? parsed.responseBody : undefined,
    requestConfig: parsed.requestConfig,
    statistics: parsed.statistics,
    modelName: typeof parsed.modelName === "string" ? parsed.modelName : undefined,
    durationSeconds:
      typeof parsed.durationSeconds === "number"
        ? parsed.durationSeconds
        : undefined,
  };
}

function inferHistorySource(filePath: string): string {
  return basename(filePath).replace(/\.jsonl(?:\.bak)?$/, "");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
