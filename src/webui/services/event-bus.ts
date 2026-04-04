/**
 * SSE 事件总线：管理服务端推送事件与日志。
 */

export type LogLevel = 'error' | 'warning' | 'info' | 'success';

export interface LogEntry {
  id: number;
  level: LogLevel;
  message: string;
  timestamp: string;
}

export type BusEventType =
  | 'snapshot'
  | 'log'
  | 'scanProgress'
  | 'plotProgress'
  | 'status';

export interface BusEvent {
  type: BusEventType;
  data: unknown;
}

type Listener = (event: BusEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();
  private logs: LogEntry[] = [];
  private logIdCounter = 0;

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

  addLog(level: LogLevel, message: string): LogEntry {
    const entry: LogEntry = {
      id: ++this.logIdCounter,
      level,
      message,
      timestamp: new Date().toISOString(),
    };
    this.logs.push(entry);
    if (this.logs.length > 500) {
      this.logs = this.logs.slice(-300);
    }
    this.emit({ type: 'log', data: entry });
    return entry;
  }

  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  clearLogs(): void {
    this.logs = [];
    this.logIdCounter = 0;
  }
}
