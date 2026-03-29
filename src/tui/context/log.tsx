import { createContext, useContext, useState, useCallback, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import type { LogEntry } from '../types.ts';

export interface LogCounts {
  total: number;
  info: number;
  warning: number;
  error: number;
  success: number;
}

interface LogContextValue {
  logs: LogEntry[];
  logCounts: LogCounts;
  addLog: (level: LogEntry['level'], message: string) => void;
  getFilteredLogs: (levels: ReadonlyArray<LogEntry['level']>) => LogEntry[];
  clearLogs: () => void;
}

const LogContext = createContext<LogContextValue | null>(null);

export function LogProvider({ children }: { children: ReactNode }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const nextId = useRef(1);

  const addLog = useCallback((level: LogEntry['level'], message: string) => {
    const entry: LogEntry = {
      id: nextId.current++,
      level,
      message,
      timestamp: new Date(),
    };
    setLogs(prev => [...prev, entry]);
  }, []);

  const logCounts = useMemo<LogCounts>(() => {
    const counts: LogCounts = {
      total: logs.length,
      info: 0,
      warning: 0,
      error: 0,
      success: 0,
    };
    for (const entry of logs) {
      counts[entry.level] += 1;
    }
    return counts;
  }, [logs]);

  const getFilteredLogs = useCallback(
    (levels: ReadonlyArray<LogEntry['level']>) => {
      const levelSet = new Set(levels);
      return logs.filter((entry) => levelSet.has(entry.level));
    },
    [logs],
  );

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  return (
    <LogContext value={{ logs, logCounts, addLog, getFilteredLogs, clearLogs }}>
      {children}
    </LogContext>
  );
}

export function useLog() {
  const ctx = useContext(LogContext);
  if (!ctx) throw new Error('useLog must be used within LogProvider');
  return ctx;
}
