import { Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useMouse } from '../context/mouse.tsx';
import { SafeBox } from './safe-box.tsx';

interface ScrollableTextBoxProps {
  title: string;
  lines: string[];
  borderColor?: 'cyan' | 'magenta' | 'green' | 'yellow' | 'blue' | 'gray' | 'white';
  titleColor?: 'cyan' | 'magenta' | 'green' | 'yellow' | 'blue' | 'gray' | 'white';
  visibleRows?: number;
  isActive?: boolean;
  emptyText?: string;
  footerHint?: string;
  linePrefixWidth?: number;
  scrollOffset?: number;
  onScrollOffsetChange?: (offset: number) => void;
}

export function ScrollableTextBox({
  title,
  lines,
  borderColor = 'cyan',
  titleColor = 'cyan',
  visibleRows = 10,
  isActive = true,
  emptyText = '(空)',
  footerHint,
  linePrefixWidth = 0,
  scrollOffset: controlledScrollOffset,
  onScrollOffsetChange,
}: ScrollableTextBoxProps) {
  const { subscribe } = useMouse();
  const normalizedLines = useMemo(() => (lines.length > 0 ? lines : [emptyText]), [emptyText, lines]);
  const [internalScrollOffset, setInternalScrollOffset] = useState(0);
  const maxOffset = Math.max(0, normalizedLines.length - visibleRows);
  const scrollOffset = controlledScrollOffset !== undefined
    ? Math.max(0, Math.min(maxOffset, controlledScrollOffset))
    : internalScrollOffset;

  const setScrollOffset = (nextOffset: number | ((prev: number) => number)) => {
    const resolved =
      typeof nextOffset === 'function'
        ? nextOffset(scrollOffset)
        : nextOffset;
    const clamped = Math.max(0, Math.min(maxOffset, resolved));
    if (controlledScrollOffset === undefined) {
      setInternalScrollOffset(clamped);
    }
    onScrollOffsetChange?.(clamped);
  };

  useEffect(() => {
    setScrollOffset((prev) => Math.min(prev, maxOffset));
  }, [maxOffset]);

  useInput(
    (_input, key) => {
      if (!isActive) {
        return;
      }

      if (key.upArrow) {
        setScrollOffset((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setScrollOffset((prev) => Math.min(maxOffset, prev + 1));
      }
    },
    { isActive },
  );

  useEffect(() => {
    if (!isActive) {
      return undefined;
    }

    return subscribe((event) => {
      if (event.action === 'scroll-up') {
        setScrollOffset((prev) => Math.max(0, prev - 1));
      } else if (event.action === 'scroll-down') {
        setScrollOffset((prev) => Math.min(maxOffset, prev + 1));
      }
    });
  }, [isActive, maxOffset, subscribe]);

  const visibleLines = normalizedLines.slice(scrollOffset, scrollOffset + visibleRows);
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset < maxOffset;

  return (
    <SafeBox flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1}>
      <Text bold color={titleColor}>{title}</Text>
      {hasScrollUp ? <Text dimColor>  ▲ 更多 ({scrollOffset})</Text> : null}
      {visibleLines.map((line, index) => {
        const lineNumber = scrollOffset + index + 1;
        const prefix = linePrefixWidth > 0 ? `${String(lineNumber).padStart(linePrefixWidth)} │ ` : '';
        return (
          <Text key={`${lineNumber}:${line}`} wrap="truncate-end" dimColor={!line.trim()}>
            {prefix}
            {line || ' '}
          </Text>
        );
      })}
      {footerHint ? <Text dimColor>{footerHint}</Text> : null}
      {hasScrollDown ? (
        <Text dimColor>  ▼ 更多 ({normalizedLines.length - scrollOffset - visibleRows})</Text>
      ) : null}
    </SafeBox>
  );
}
