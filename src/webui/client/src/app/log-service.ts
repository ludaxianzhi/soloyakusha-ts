/**
 * 前端日志服务：封装运行日志的 API 调用与 SSE 实时流处理。
 * 与后端 LogService 对应，提供统一的日志访问接口。
 */

import type { LogDigest, LogEntry, LogPage, LogSession } from './types.ts';
import { api } from './api.ts';

export type LogStreamHandler = (entry: LogEntry) => void;

const MAX_LOG_COUNT = 500;

export function createLogService() {
  let logs: LogEntry[] = [];
  let handlers = new Set<LogStreamHandler>();

  return {
    /** 获取日志摘要 */
    getSummary(): Promise<LogDigest> {
      return api.getLogsSummary();
    },

    /** 获取日志分页（用于首次加载历史） */
    getPage(params?: { limit?: number; beforeId?: number }): Promise<LogPage> {
      return api.getLogs(params);
    },

    /** 获取日志会话信息 */
    getSession(): Promise<LogSession> {
      return api.getLogSession();
    },

    /** 清空日志 */
    clear(): Promise<void> {
      logs = [];
      return api.clearLogs() as Promise<unknown> as Promise<void>;
    },

    /** 导出日志 */
    download(format: 'json' | 'text' = 'text'): Promise<Blob> {
      return api.downloadLogs(format);
    },

    /** 当前内存中的日志列表（仅首次加载 + 实时追加） */
    getLogs(): LogEntry[] {
      return [...logs];
    },

    /** 追加单条日志（由 SSE 回调调用） */
    appendLog(entry: LogEntry): void {
      logs.push(entry);
      if (logs.length > MAX_LOG_COUNT) {
        logs = logs.slice(-Math.floor(MAX_LOG_COUNT * 0.6));
      }
      for (const handler of handlers) {
        try {
          handler(entry);
        } catch {
          // 忽略处理器错误
        }
      }
    },

    /** 批量替换日志列表（首次加载时使用） */
    setLogs(entries: LogEntry[]): void {
      logs = entries.slice(-MAX_LOG_COUNT);
    },

    /** 订阅实时日志流 */
    subscribe(handler: LogStreamHandler): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}

export type LogServiceClient = ReturnType<typeof createLogService>;
