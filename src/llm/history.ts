/**
 * 实现基于文件的请求历史记录器，用于落盘保存补全与错误日志。
 *
 * 本模块提供 {@link FileRequestHistoryLogger} 类，用于：
 * - 记录每次 LLM 请求的 prompt、response 和统计信息
 * - 记录失败请求的错误信息
 * - 日志文件自动轮转（超过 10MB 时备份）
 *
 * 日志格式为分隔线标注的文本格式，便于人工阅读和问题排查。
 *
 * @module llm/history
 */

import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  CompletionLogEntry,
  ErrorLogEntry,
  RequestHistoryLogger,
} from "./types.ts";

/**
 * 基于文件的请求历史记录器，负责追加入盘与日志轮转。
 *
 * 日志文件格式：
 * - 补全日志：包含 REQUEST_ID、TIMESTAMP、MODEL、CONFIG、PROMPT、RESPONSE、STATS
 * - 错误日志：包含 REQUEST_ID、TIMESTAMP、ERROR、RESPONSE BODY（如有）
 *
 * 日志轮转：
 * - 当日志文件超过 MAX_FILE_SIZE（10MB）时
 * - 将当前文件重命名为 .txt.bak
 * - 新日志写入空文件
 */
export class FileRequestHistoryLogger implements RequestHistoryLogger {
  static readonly MAX_FILE_SIZE = 10 * 1024 * 1024;

  private readonly logFilePath: string;
  private readonly backupFilePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(logDir = "logs", logName = "llm_requests") {
    this.logFilePath = join(logDir, `${logName}.txt`);
    this.backupFilePath = join(logDir, `${logName}.txt.bak`);
  }

  async logCompletion(entry: CompletionLogEntry): Promise<void> {
    const timestamp = formatTimestamp();
    const lines: string[] = [
      "=".repeat(80),
      `REQUEST_ID: ${entry.requestId}`,
      `TIMESTAMP:  ${timestamp}`,
      "TYPE:       COMPLETION",
      "-".repeat(80),
    ];

    if (entry.modelName) {
      lines.push(`MODEL:      ${entry.modelName}`);
    }
    if (entry.durationSeconds !== undefined) {
      lines.push(`DURATION:   ${entry.durationSeconds.toFixed(3)}s`);
    }

    if (entry.requestConfig) {
      lines.push("CONFIG:");
      if (entry.requestConfig.systemPrompt) {
        lines.push(`  System Prompt: ${entry.requestConfig.systemPrompt}`);
      }
      lines.push(`  Temperature:   ${entry.requestConfig.temperature ?? ""}`);
      lines.push(`  Max Tokens:    ${entry.requestConfig.maxTokens ?? ""}`);
      lines.push(`  Top P:         ${entry.requestConfig.topP ?? ""}`);
      if (entry.requestConfig.extraBody) {
        lines.push(
          `  Extra Body:    ${JSON.stringify(entry.requestConfig.extraBody)}`,
        );
      }
      lines.push("-".repeat(80));
    }

    lines.push("PROMPT:", entry.prompt, "-".repeat(80), "RESPONSE:", entry.response);
    lines.push("-".repeat(80));

    if (entry.statistics) {
      lines.push(
        `STATS: Prompt Tokens: ${entry.statistics.promptTokens} | Completion Tokens: ${entry.statistics.completionTokens} | Total Tokens: ${entry.statistics.totalTokens}`,
      );
    }

    lines.push("=".repeat(80), "");
    await this.writeEntry(lines.join("\n"));
  }

  async logError(entry: ErrorLogEntry): Promise<void> {
    const timestamp = formatTimestamp();
    const lines: string[] = [
      "!".repeat(80),
      `REQUEST_ID: ${entry.requestId}`,
      `TIMESTAMP:  ${timestamp}`,
      "TYPE:       ERROR",
      "-".repeat(80),
    ];

    if (entry.modelName) {
      lines.push(`MODEL:      ${entry.modelName}`);
    }
    if (entry.durationSeconds !== undefined) {
      lines.push(`DURATION:   ${entry.durationSeconds.toFixed(3)}s`);
    }

    if (entry.requestConfig) {
      lines.push("CONFIG:");
      if (entry.requestConfig.systemPrompt) {
        lines.push(`  System Prompt: ${entry.requestConfig.systemPrompt}`);
      }
      lines.push(`  Temperature:   ${entry.requestConfig.temperature ?? ""}`);
      lines.push(`  Max Tokens:    ${entry.requestConfig.maxTokens ?? ""}`);
      lines.push(`  Top P:         ${entry.requestConfig.topP ?? ""}`);
      lines.push("-".repeat(80));
    }

    lines.push("PROMPT:", entry.prompt, "-".repeat(80), "ERROR:", entry.errorMessage);
    if (entry.responseBody) {
      lines.push("-".repeat(80), "RESPONSE BODY:", entry.responseBody);
    }

    lines.push("!".repeat(80), "");
    await this.writeEntry(lines.join("\n"));
  }

  async readRecentLogs(limit = 4096): Promise<string> {
    try {
      return await readFile(this.logFilePath, "utf8").then((content) =>
        content.slice(-limit),
      );
    } catch (error) {
      if (isMissingFileError(error)) {
        return "";
      }
      throw error;
    }
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

  private async writeEntry(content: string): Promise<void> {
    const task = async () => {
      await mkdir(dirname(this.logFilePath), { recursive: true });
      await this.rotateIfNeeded();
      await appendFile(this.logFilePath, `${content}\n`, "utf8");
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

function formatTimestamp(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
