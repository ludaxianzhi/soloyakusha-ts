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

export interface LogDigest {
  total: number;
  latestId: number;
}

export interface LogPage {
  items: LogEntry[];
  total: number;
  latestId: number;
  nextBeforeId?: number;
}

export interface LogSession {
  runId: string;
  startedAt: string;
}

export type BusEventType =
  | 'snapshot'
  | 'log'
  | 'scanProgress'
  | 'proofreadProgress'
  | 'plotProgress'
  | 'chaptersChanged'
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
  private readonly logSession: LogSession = {
    runId: `webui-${Date.now()}-${process.pid}`,
    startedAt: new Date().toISOString(),
  };

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

  getLogDigest(): LogDigest {
    return {
      total: this.logs.length,
      latestId: this.logs[this.logs.length - 1]?.id ?? 0,
    };
  }

  getLogPage(options: { limit?: number; beforeId?: number } = {}): LogPage {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const beforeId = options.beforeId;
    const filtered = beforeId
      ? this.logs.filter((entry) => entry.id < beforeId)
      : this.logs;
    const items = filtered.slice(-limit).reverse();
    const oldestEntry = items[items.length - 1];
    return {
      items,
      ...this.getLogDigest(),
      nextBeforeId: items.length === limit ? oldestEntry?.id : undefined,
    };
  }

  getLogSession(): LogSession {
    return { ...this.logSession };
  }

  formatLogExport(format: 'json' | 'text' = 'text'): {
    content: string;
    contentType: string;
    fileName: string;
  } {
    if (format === 'json') {
      return {
        content: JSON.stringify(
          {
            session: this.getLogSession(),
            items: this.getLogs(),
          },
          null,
          2,
        ),
        contentType: 'application/json; charset=utf-8',
        fileName: `runtime-logs-${this.logSession.runId}.json`,
      };
    }

    const content = [
      `Run ID: ${this.logSession.runId}`,
      `Started At: ${this.logSession.startedAt}`,
      '',
      ...this.logs.map(
        (entry) =>
          `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`,
      ),
    ].join('\n');
    return {
      content,
      contentType: 'text/plain; charset=utf-8',
      fileName: `runtime-logs-${this.logSession.runId}.txt`,
    };
  }

  clearLogs(): void {
    this.logs = [];
    this.logIdCounter = 0;
  }
}
