import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { PropsWithChildren } from 'react';

export type MouseAction =
  | 'left'
  | 'middle'
  | 'right'
  | 'release'
  | 'move'
  | 'scroll-up'
  | 'scroll-down';

export interface MouseEvent {
  action: MouseAction;
  x: number;
  y: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

type MouseListener = (event: MouseEvent) => void;

interface MouseContextValue {
  enabled: boolean;
  lastEvent: MouseEvent | null;
  subscribe: (listener: MouseListener) => () => void;
}

const MouseContext = createContext<MouseContextValue | null>(null);

function decodeMouseEvent(code: number, x: number, y: number, suffix: 'm' | 'M'): MouseEvent {
  const shift = (code & 4) !== 0;
  const alt = (code & 8) !== 0;
  const ctrl = (code & 16) !== 0;
  const motion = (code & 32) !== 0;

  let action: MouseAction = 'move';

  if (code >= 64) {
    action = code === 64 ? 'scroll-up' : 'scroll-down';
  } else if (suffix === 'm') {
    action = 'release';
  } else if (motion) {
    action = 'move';
  } else {
    const button = code & 0b11;
    action = button === 0 ? 'left' : button === 1 ? 'middle' : 'right';
  }

  return { action, x, y, shift, alt, ctrl };
}

export function MouseProvider({ children }: PropsWithChildren) {
  const listenersRef = useRef(new Set<MouseListener>());
  const [enabled, setEnabled] = useState(false);
  const [lastEvent, setLastEvent] = useState<MouseEvent | null>(null);

  useEffect(() => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return;
    }

    const handleData = (chunk: string | Buffer) => {
      const value = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const pattern = /\x1b\[<(\d+);(\d+);(\d+)([mM])/g;

      for (const match of value.matchAll(pattern)) {
        const code = Number(match[1]);
        const x = Number(match[2]);
        const y = Number(match[3]);
        const suffix = match[4] as 'm' | 'M';
        const event = decodeMouseEvent(code, x, y, suffix);
        setLastEvent(event);

        for (const listener of listenersRef.current) {
          listener(event);
        }
      }
    };

    process.stdout.write('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
    process.stdin.on('data', handleData);
    setEnabled(true);

    return () => {
      process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1006l');
      process.stdin.off('data', handleData);
      setEnabled(false);
    };
  }, []);

  const value = useMemo<MouseContextValue>(
    () => ({
      enabled,
      lastEvent,
      subscribe(listener) {
        listenersRef.current.add(listener);
        return () => {
          listenersRef.current.delete(listener);
        };
      },
    }),
    [enabled, lastEvent],
  );

  return <MouseContext value={value}>{children}</MouseContext>;
}

export function useMouse() {
  const context = useContext(MouseContext);
  if (!context) {
    throw new Error('useMouse must be used within MouseProvider');
  }

  return context;
}
