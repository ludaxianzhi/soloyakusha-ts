import { useEffect, useState } from 'react';
import type {
  LogEntry,
  PlotSummaryProgress,
  ProofreadProgress,
  ScanDictionaryProgress,
  TranslationProjectSnapshot,
  WorkspaceEventEnvelope,
} from './types.ts';

type EventHandlers = {
  onSnapshot?: (snapshot: TranslationProjectSnapshot | null) => void;
  onLog?: (entry: LogEntry) => void;
  onScanProgress?: (progress: ScanDictionaryProgress | null) => void;
  onProofreadProgress?: (progress: ProofreadProgress | null) => void;
  onPlotProgress?: (progress: PlotSummaryProgress | null) => void;
  onChaptersChanged?: (revision: number) => void;
};

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

type UseEventStreamOptions = {
  workspaceId?: string;
  includeWorkspace?: boolean;
  includeLogs?: boolean;
};

export function useEventStream(
  handlers: EventHandlers,
  options: UseEventStreamOptions = {},
) {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const query = new URLSearchParams();
    query.set('includeLogs', options.includeLogs ? '1' : '0');
    if (options.workspaceId) {
      query.set('workspaceId', options.workspaceId);
    }
    if (options.includeWorkspace) {
      query.set('includeWorkspace', '1');
    }

    const source = new window.EventSource(`${API_BASE}/api/events?${query.toString()}`);

    const parseEvent = <T,>(event: Event): T => {
      const raw = JSON.parse((event as MessageEvent<string>).data) as
        | T
        | WorkspaceEventEnvelope<T>;
      if (options.includeWorkspace && raw && typeof raw === 'object' && 'data' in raw) {
        return (raw as WorkspaceEventEnvelope<T>).data;
      }
      return raw as T;
    };

    source.addEventListener('open', () => setConnected(true));
    source.addEventListener('error', () => setConnected(false));
    source.addEventListener('snapshot', (event) => {
      handlers.onSnapshot?.(parseEvent<TranslationProjectSnapshot | null>(event));
    });
    source.addEventListener('log', (event) => {
      handlers.onLog?.(parseEvent<LogEntry>(event));
    });
    source.addEventListener('scanProgress', (event) => {
      handlers.onScanProgress?.(parseEvent<ScanDictionaryProgress | null>(event));
    });
    source.addEventListener('proofreadProgress', (event) => {
      handlers.onProofreadProgress?.(parseEvent<ProofreadProgress | null>(event));
    });
    source.addEventListener('plotProgress', (event) => {
      handlers.onPlotProgress?.(parseEvent<PlotSummaryProgress | null>(event));
    });
    source.addEventListener('chaptersChanged', (event) => {
      handlers.onChaptersChanged?.(parseEvent<number>(event));
    });

    return () => {
      source.close();
    };
  }, [handlers, options.includeLogs, options.includeWorkspace, options.workspaceId]);

  return { connected };
}
