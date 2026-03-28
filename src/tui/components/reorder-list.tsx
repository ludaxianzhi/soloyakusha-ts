import { useEffect, useState } from 'react';
import { Text, useInput } from 'ink';
import { SafeBox } from './safe-box.tsx';
import { useMouse } from '../context/mouse.tsx';

export interface ReorderItem {
  id: string;
  label: string;
  description?: string;
  meta?: string;
}

interface ReorderListProps {
  title: string;
  description?: string;
  items: ReorderItem[];
  onChange: (items: ReorderItem[]) => void;
  onConfirm: () => void;
  onCancel: () => void;
  isActive?: boolean;
  visibleRows?: number;
}

export function ReorderList({
  title,
  items,
  onChange,
  onConfirm,
  onCancel,
  isActive = true,
  visibleRows = 12,
}: ReorderListProps) {
  const [focusIndex, setFocusIndex] = useState(0);
  const { subscribe } = useMouse();

  // Scrolling
  const [scrollOffset, setScrollOffset] = useState(0);
  useEffect(() => {
    if (focusIndex < scrollOffset) {
      setScrollOffset(focusIndex);
    } else if (focusIndex >= scrollOffset + visibleRows) {
      setScrollOffset(focusIndex - visibleRows + 1);
    }
  }, [focusIndex, scrollOffset, visibleRows]);

  useEffect(() => {
    if (focusIndex >= items.length) {
      setFocusIndex(Math.max(0, items.length - 1));
    }
  }, [focusIndex, items.length]);

  useInput(
    (_input, key) => {
      if (!isActive || items.length === 0) {
        if (key.escape) {
          onCancel();
        }
        return;
      }

      if (key.upArrow) {
        setFocusIndex((prev) => (prev - 1 + items.length) % items.length);
      } else if (key.downArrow) {
        setFocusIndex((prev) => (prev + 1) % items.length);
      } else if (key.leftArrow) {
        if (focusIndex === 0) return;
        const next = [...items];
        [next[focusIndex - 1], next[focusIndex]] = [next[focusIndex]!, next[focusIndex - 1]!];
        onChange(next);
        setFocusIndex(focusIndex - 1);
      } else if (key.rightArrow) {
        if (focusIndex >= items.length - 1) return;
        const next = [...items];
        [next[focusIndex], next[focusIndex + 1]] = [next[focusIndex + 1]!, next[focusIndex]!];
        onChange(next);
        setFocusIndex(focusIndex + 1);
      } else if (key.return) {
        onConfirm();
      } else if (key.escape) {
        onCancel();
      }
    },
    { isActive },
  );

  useEffect(() => {
    if (!isActive) return undefined;

    return subscribe((event) => {
      if (items.length === 0) return;

      if (event.action === 'scroll-up') {
        setFocusIndex((prev) => (prev - 1 + items.length) % items.length);
      } else if (event.action === 'scroll-down') {
        setFocusIndex((prev) => (prev + 1) % items.length);
      } else if (event.action === 'left') {
        if (focusIndex > 0) {
          const next = [...items];
          [next[focusIndex - 1], next[focusIndex]] = [next[focusIndex]!, next[focusIndex - 1]!];
          onChange(next);
          setFocusIndex(focusIndex - 1);
        }
      } else if (event.action === 'right') {
        if (focusIndex < items.length - 1) {
          const next = [...items];
          [next[focusIndex], next[focusIndex + 1]] = [next[focusIndex + 1]!, next[focusIndex]!];
          onChange(next);
          setFocusIndex(focusIndex + 1);
        }
      }
    });
  }, [focusIndex, isActive, items, onChange, subscribe]);

  const visibleItems = items.slice(scrollOffset, scrollOffset + visibleRows);
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset + visibleRows < items.length;

  return (
    <SafeBox flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">{title}</Text>
      <Text dimColor>↑↓ 选择，←→ 调整顺序，Enter 确认</Text>
      {items.length === 0 ? (
        <Text dimColor>当前没有可排序的条目。</Text>
      ) : (
        <SafeBox flexDirection="column">
          {hasScrollUp ? <Text dimColor>  ▲ 更多 ({scrollOffset})</Text> : null}
          {visibleItems.map((item, vi) => {
            const realIndex = scrollOffset + vi;
            const focused = realIndex === focusIndex;
            return (
              <SafeBox key={item.id} justifyContent="space-between">
                <Text
                  backgroundColor={focused ? 'magenta' : undefined}
                  color={focused ? 'white' : undefined}
                  bold={focused}
                  wrap="truncate-end"
                >
                  {` ${realIndex + 1}. ${item.label} `}
                </Text>
                {item.meta ? (
                  <Text
                    backgroundColor={focused ? 'magenta' : undefined}
                    color={focused ? 'white' : 'gray'}
                  >
                    {` ${item.meta} `}
                  </Text>
                ) : null}
              </SafeBox>
            );
          })}
          {hasScrollDown ? <Text dimColor>  ▼ 更多 ({items.length - scrollOffset - visibleRows})</Text> : null}
        </SafeBox>
      )}
    </SafeBox>
  );
}
