import { useEffect, useState } from 'react';
import { Text, useInput } from 'ink';
import type { SelectItem } from '../types.ts';
import { useMouse } from '../context/mouse.tsx';
import { SafeBox } from './safe-box.tsx';

interface SelectProps<T extends string = string> {
  items: SelectItem<T>[];
  onSelect: (item: SelectItem<T>) => void;
  isActive?: boolean;
  title?: string;
  description?: string;
  visibleRows?: number;
  initialValue?: T;
}

export function Select<T extends string = string>({
  items,
  onSelect,
  isActive = true,
  title,
  visibleRows = 12,
  initialValue,
}: SelectProps<T>) {
  const [focusIndex, setFocusIndex] = useState(() => {
    if (!initialValue) {
      return 0;
    }

    const initialIndex = items.findIndex((item) => item.value === initialValue);
    return initialIndex >= 0 ? initialIndex : 0;
  });
  const { subscribe } = useMouse();

  // Scrolling
  const [scrollOffset, setScrollOffset] = useState(0);
  // Only sync focus when initialValue itself changes, not when items reference changes.
  // Resetting on every new items reference caused focus to jump to 0 every polling cycle.
  useEffect(() => {
    if (initialValue === undefined) return;
    const nextIndex = items.findIndex((item) => item.value === initialValue);
    setFocusIndex(nextIndex >= 0 ? nextIndex : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialValue]);

  // Clamp focus within bounds when the items list shrinks.
  useEffect(() => {
    if (items.length === 0) return;
    setFocusIndex((prev) => Math.min(prev, items.length - 1));
  }, [items.length]);

  useEffect(() => {
    if (focusIndex < scrollOffset) {
      setScrollOffset(focusIndex);
    } else if (focusIndex >= scrollOffset + visibleRows) {
      setScrollOffset(focusIndex - visibleRows + 1);
    }
  }, [focusIndex, scrollOffset, visibleRows]);

  useInput(
    (_input, key) => {
      if (key.upArrow) {
        setFocusIndex(prev => (prev - 1 + items.length) % items.length);
      } else if (key.downArrow) {
        setFocusIndex(prev => (prev + 1) % items.length);
      } else if (key.return) {
        const item = items[focusIndex];
        if (item) onSelect(item);
      }
    },
    { isActive },
  );

  useEffect(() => {
    if (!isActive) {
      return undefined;
    }

    return subscribe(event => {
      if (event.action === 'scroll-up') {
        setFocusIndex(prev => (prev - 1 + items.length) % items.length);
      } else if (event.action === 'scroll-down') {
        setFocusIndex(prev => (prev + 1) % items.length);
      } else if (event.action === 'left') {
        const item = items[focusIndex];
        if (item) {
          onSelect(item);
        }
      }
    });
  }, [focusIndex, isActive, items, onSelect, subscribe]);

  const visibleItems = items.slice(scrollOffset, scrollOffset + visibleRows);
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset + visibleRows < items.length;

  return (
    <SafeBox flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {title ? <Text bold color="cyan">{title}</Text> : null}
      {hasScrollUp ? <Text dimColor>  ▲ 更多 ({scrollOffset})</Text> : null}
      {visibleItems.map((item, vi) => {
        const realIndex = scrollOffset + vi;
        const focused = realIndex === focusIndex;
        return (
          <SafeBox key={item.value} justifyContent="space-between">
            <Text
              backgroundColor={focused ? 'white' : undefined}
              color={focused ? 'black' : undefined}
              bold={focused}
              wrap="truncate-end"
            >
              {` ${item.label} `}
            </Text>
            {item.meta ? (
              <Text
                backgroundColor={focused ? 'white' : undefined}
                color={focused ? 'black' : 'gray'}
              >
                {` ${item.meta} `}
              </Text>
            ) : null}
          </SafeBox>
        );
      })}
      {hasScrollDown ? <Text dimColor>  ▼ 更多 ({items.length - scrollOffset - visibleRows})</Text> : null}
    </SafeBox>
  );
}
