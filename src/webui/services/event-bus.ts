/**
 * SSE 事件总线：管理服务端推送事件。
 * 日志管理通过 LogService 独立处理。
 */

import type { LogService, LogLevel } from './log-service.ts';

export type BusEventType =
  | 'snapshot'
  | 'log'
  | 'scanProgress'
  | 'transcribeProgress'
  | 'proofreadProgress'
  | 'plotProgress'
  | 'chaptersChanged'
  | 'status';

export interface BusEvent {
  type: BusEventType;
  workspaceId: string | null;
  data: unknown;
}

type Listener = (event: BusEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();
  private logService: LogService | null = null;

  /** 注入 LogService 实例，用于委托日志存储 */
  setLogService(service: LogService): void {
    this.logService = service;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: BusEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore listener errors
      }
    }
  }

  addLog(
    level: LogLevel,
    message: string,
    workspaceId: string | null = null,
    metadata?: Record<string, unknown>,
  ): void {
    if (this.logService) {
      this.logService.addLog(level, message, workspaceId, metadata);
    }
    this.emit({ type: 'log', workspaceId, data: { level, message, workspaceId, metadata } });
  }
}
