import { useEffect, useState } from 'react';
import type {
  LogEntry,
  PlotSummaryProgress,
  ProofreadProgress,
  ScanDictionaryProgress,
  TranslationProjectSnapshot,
} from './types.ts';

type EventHandlers = {
  onSnapshot?: (snapshot: TranslationProjectSnapshot | null) => void;
  onLog?: (entry: LogEntry) => void;
  onScanProgress?: (progress: ScanDictionaryProgress | null) => void;
  onProofreadProgress?: (progress: ProofreadProgress | null) => void;
  onPlotProgress?: (progress: PlotSummaryProgress | null) => void;
};

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

export function useEventStream(handlers: EventHandlers) {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new window.EventSource(`${API_BASE}/api/events?includeLogs=0`);

    source.addEventListener('open', () => setConnected(true));
    source.addEventListener('error', () => setConnected(false));
    source.addEventListener('snapshot', (event) => {
      handlers.onSnapshot?.(
        JSON.parse((event as MessageEvent<string>).data) as
          | TranslationProjectSnapshot
          | null,
      );
    });
    source.addEventListener('log', (event) => {
      handlers.onLog?.(
        JSON.parse((event as MessageEvent<string>).data) as LogEntry,
      );
    });
    source.addEventListener('scanProgress', (event) => {
      handlers.onScanProgress?.(
        JSON.parse((event as MessageEvent<string>).data) as
          | ScanDictionaryProgress
          | null,
      );
    });
    source.addEventListener('proofreadProgress', (event) => {
      handlers.onProofreadProgress?.(
        JSON.parse((event as MessageEvent<string>).data) as
          | ProofreadProgress
          | null,
      );
    });
    source.addEventListener('plotProgress', (event) => {
      handlers.onPlotProgress?.(
        JSON.parse((event as MessageEvent<string>).data) as
          | PlotSummaryProgress
          | null,
      );
    });

    return () => {
      source.close();
    };
  }, [handlers]);

  return { connected };
}
