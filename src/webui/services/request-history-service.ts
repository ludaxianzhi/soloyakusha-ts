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
import type { UsageStatsService } from './usage-stats-service.ts';

export interface RequestHistoryWorkspaceContext {
  projectName?: string;
  workspaceDir?: string;
}

type RequestHistoryServiceOptions = {
  manager?: GlobalConfigManager;
  logDir?: string;
  usageStatsService?: UsageStatsService;
};

export class RequestHistoryService {
  private readonly manager: GlobalConfigManager;
  private readonly logDir?: string;
  private readonly usageStatsService?: UsageStatsService;

  constructor(options: RequestHistoryServiceOptions = {}) {
    this.manager = options.manager ?? new GlobalConfigManager();
    this.logDir = options.logDir;
    this.usageStatsService = options.usageStatsService;
  }

  getLogDir(): string {
    return this.logDir ?? join(dirname(this.manager.getFilePath()), 'activity');
  }

  createLogger(
    source: string,
    workspaceContext?: RequestHistoryWorkspaceContext,
  ): RequestHistoryLogger {
    const logger = new FileRequestHistoryLogger(this.getLogDir(), source);
    return {
      logCompletion: async (entry) => {
        const nextEntry = attachWorkspaceContext(entry, workspaceContext);
        await logger.logCompletion(nextEntry);
        const recordPromise = this.usageStatsService?.recordLlmRequest({
            entry: nextEntry,
            succeeded: true,
            workspaceContext,
          });
        if (recordPromise) {
          void recordPromise.catch((error) => {
            console.error('记录使用统计失败:', error);
          });
        }
      },
      logError: async (entry) => {
        const nextEntry = attachWorkspaceContext(entry, workspaceContext);
        await logger.logError(nextEntry);
        const recordPromise = this.usageStatsService?.recordLlmRequest({
            entry: nextEntry,
            succeeded: false,
            workspaceContext,
          });
        if (recordPromise) {
          void recordPromise.catch((error) => {
            console.error('记录使用统计失败:', error);
          });
        }
      },
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
  workspaceContext?: RequestHistoryWorkspaceContext,
): T {
  const nextContext = {
    ...(entry.meta?.context ?? {}),
    ...(workspaceContext?.projectName ? { projectName: workspaceContext.projectName } : {}),
    ...(workspaceContext?.workspaceDir ? { workspaceDir: workspaceContext.workspaceDir } : {}),
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
