import { useEffect, useState } from 'react';
import { Text, useInput } from 'ink';
import { Panel } from './panel.tsx';
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
}

export function ReorderList({
  title,
  description,
  items,
  onChange,
  onConfirm,
  onCancel,
  isActive = true,
}: ReorderListProps) {
  const [focusIndex, setFocusIndex] = useState(0);
  const { subscribe } = useMouse();

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
        if (focusIndex === 0) {
          return;
        }
        const next = [...items];
        [next[focusIndex - 1], next[focusIndex]] = [
          next[focusIndex]!,
          next[focusIndex - 1]!,
        ];
        onChange(next);
        setFocusIndex(focusIndex - 1);
      } else if (key.rightArrow) {
        if (focusIndex >= items.length - 1) {
          return;
        }
        const next = [...items];
        [next[focusIndex], next[focusIndex + 1]] = [
          next[focusIndex + 1]!,
          next[focusIndex]!,
        ];
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
    if (!isActive) {
      return undefined;
    }

    return subscribe((event) => {
      if (items.length === 0) {
        return;
      }

      if (event.action === 'scroll-up') {
        setFocusIndex((prev) => (prev - 1 + items.length) % items.length);
      } else if (event.action === 'scroll-down') {
        setFocusIndex((prev) => (prev + 1) % items.length);
      } else if (event.action === 'left') {
        if (focusIndex > 0) {
          const next = [...items];
          [next[focusIndex - 1], next[focusIndex]] = [
            next[focusIndex]!,
            next[focusIndex - 1]!,
          ];
          onChange(next);
          setFocusIndex(focusIndex - 1);
        }
      } else if (event.action === 'right') {
        if (focusIndex < items.length - 1) {
          const next = [...items];
          [next[focusIndex], next[focusIndex + 1]] = [
            next[focusIndex + 1]!,
            next[focusIndex]!,
          ];
          onChange(next);
          setFocusIndex(focusIndex + 1);
        }
      }
    });
  }, [focusIndex, isActive, items, onChange, subscribe]);

  return (
    <Panel
      title={title}
      subtitle={description ?? '↑↓ 选择条目，←→ 调整顺序，Enter 确认。'}
      tone="magenta"
    >
      {items.length === 0 ? (
        <Text dimColor>当前没有可排序的章节条目。</Text>
      ) : (
        <SafeBox flexDirection="column">
          {items.map((item, index) => {
            const focused = index === focusIndex;
            return (
              <SafeBox
                key={item.id}
                flexDirection="column"
                borderStyle="round"
                borderColor={focused ? 'magenta' : 'gray'}
                paddingX={1}
                marginBottom={1}
              >
                <SafeBox justifyContent="space-between">
                  <Text color={focused ? 'magenta' : undefined} bold={focused}>
                    {focused ? '❯ ' : '  '}
                    {index + 1}. {item.label}
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

          <SafeBox flexDirection="column">
            <Text dimColor>操作逻辑类似老式 BIOS 启动顺序设置：</Text>
            <Text dimColor>上/下键负责切换选择，左/右键负责调整该项顺序。</Text>
          </SafeBox>
        </SafeBox>
      )}
    </Panel>
  );
}
