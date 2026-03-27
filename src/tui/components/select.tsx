import { useEffect, useState } from 'react';
import { Text, useInput } from 'ink';
import type { SelectItem } from '../types.ts';
import { Panel } from './panel.tsx';
import { useMouse } from '../context/mouse.tsx';
import { SafeBox } from './safe-box.tsx';

interface SelectProps<T extends string = string> {
  items: SelectItem<T>[];
  onSelect: (item: SelectItem<T>) => void;
  isActive?: boolean;
  title?: string;
  description?: string;
}

export function Select<T extends string = string>({
  items,
  onSelect,
  isActive = true,
  title,
  description,
}: SelectProps<T>) {
  const [focusIndex, setFocusIndex] = useState(0);
  const { subscribe } = useMouse();

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

  return (
    <Panel
      title={title ?? '选择'}
      subtitle={description ?? '使用方向键或滚轮切换，Enter / 左键确认。'}
      tone="cyan"
    >
      <SafeBox flexDirection="column">
        {items.map((item, index) => {
          const focused = index === focusIndex;
          return (
            <SafeBox
              key={item.value}
              flexDirection="column"
              borderStyle="round"
              borderColor={focused ? 'cyan' : 'gray'}
              paddingX={1}
              marginBottom={1}
            >
              <SafeBox justifyContent="space-between">
                <Text color={focused ? 'cyan' : undefined} bold={focused}>
                  {focused ? '❯ ' : '  '}
                  {item.label}
                </Text>
                {item.meta ? <Text dimColor>{item.meta}</Text> : null}
              </SafeBox>
              {item.description ? (
                <Text dimColor wrap="wrap">
                  {item.description}
                </Text>
              ) : null}
            </SafeBox>
          );
        })}
      </SafeBox>
    </Panel>
  );
}
