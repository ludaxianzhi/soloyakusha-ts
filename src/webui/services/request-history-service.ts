import { dirname, join } from 'node:path';
import { GlobalConfigManager } from '../../config/manager.ts';
import {
  FileRequestHistoryLogger,
  clearHistoryFromLogDir,
  deleteHistoryEntryFromLogDir,
  readAllHistoryDetailsFromLogDir,
  readHistoryDetailFromLogDir,
  readHistoryDigestFromLogDir,
  readHistoryPageFromLogDir,
  type LlmRequestHistoryDetail,
  type LlmRequestHistoryDigest,
  type LlmRequestHistoryPage,
} from '../../llm/history.ts';
import type {
  CompletionLogEntry,
  ErrorLogEntry,
  RequestHistoryLogger,
} from '../../llm/types.ts';

export interface RequestHistoryWorkspaceContext {
  projectName?: string;
  workspaceDir?: string;
}

type RequestHistoryServiceOptions = {
  manager?: GlobalConfigManager;
  logDir?: string;
};

export class RequestHistoryService {
  private readonly manager: GlobalConfigManager;
  private readonly logDir?: string;

  constructor(options: RequestHistoryServiceOptions = {}) {
    this.manager = options.manager ?? new GlobalConfigManager();
    this.logDir = options.logDir;
  }

  getLogDir(): string {
    return this.logDir ?? join(dirname(this.manager.getFilePath()), 'activity');
  }

  createLogger(
    source: string,
    workspaceContext?: RequestHistoryWorkspaceContext,
  ): RequestHistoryLogger {
    const logger = new FileRequestHistoryLogger(this.getLogDir(), source);
    if (!workspaceContext?.projectName && !workspaceContext?.workspaceDir) {
      return logger;
    }

    return {
      logCompletion: (entry) =>
        logger.logCompletion(attachWorkspaceContext(entry, workspaceContext)),
      logError: (entry) =>
        logger.logError(attachWorkspaceContext(entry, workspaceContext)),
    };
  }

  async getDigest(): Promise<LlmRequestHistoryDigest> {
    return readHistoryDigestFromLogDir(this.getLogDir());
  }

  async getPage(options: { limit?: number; beforeId?: number }): Promise<LlmRequestHistoryPage> {
    return readHistoryPageFromLogDir(this.getLogDir(), options);
  }

  async getDetail(id: number): Promise<LlmRequestHistoryDetail | null> {
    return readHistoryDetailFromLogDir(this.getLogDir(), id);
  }

  async deleteEntry(id: number): Promise<boolean> {
    return deleteHistoryEntryFromLogDir(this.getLogDir(), id);
  }

  async clear(): Promise<number> {
    return clearHistoryFromLogDir(this.getLogDir());
  }

  async exportPrettyJson(): Promise<string> {
    const items = await readAllHistoryDetailsFromLogDir(this.getLogDir());
    return JSON.stringify(items, null, 2);
  }
}

function attachWorkspaceContext<T extends CompletionLogEntry | ErrorLogEntry>(
  entry: T,
  workspaceContext: RequestHistoryWorkspaceContext,
): T {
  const nextContext = {
    ...(entry.meta?.context ?? {}),
    ...(workspaceContext.projectName ? { projectName: workspaceContext.projectName } : {}),
    ...(workspaceContext.workspaceDir ? { workspaceDir: workspaceContext.workspaceDir } : {}),
  };
  return {
    ...entry,
    meta: entry.meta
      ? {
          ...entry.meta,
          context: nextContext,
        }
      : undefined,
  };
}
