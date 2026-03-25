import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface SortableItem {
  id: string;
  label: string;
}

interface SortableListProps {
  title: string;
  items: SortableItem[];
  onSave: (items: SortableItem[]) => void;
  onCancel: () => void;
}

export function SortableList({ title, items: initial, onSave, onCancel }: SortableListProps) {
  const [items, setItems] = useState(initial);
  const [focusIndex, setFocusIndex] = useState(0);
  const [grabbed, setGrabbed] = useState(false);

  const saveIdx = items.length;
  const cancelIdx = items.length + 1;
  const total = items.length + 2;

  useInput((input, key) => {
    // ── Grabbed mode: move the selected item ──
    if (grabbed) {
      if (key.upArrow && focusIndex > 0) {
        setItems(prev => {
          const next = [...prev];
          [next[focusIndex - 1], next[focusIndex]] = [next[focusIndex]!, next[focusIndex - 1]!];
          return next;
        });
        setFocusIndex(p => p - 1);
      } else if (key.downArrow && focusIndex < items.length - 1) {
        setItems(prev => {
          const next = [...prev];
          [next[focusIndex], next[focusIndex + 1]] = [next[focusIndex + 1]!, next[focusIndex]!];
          return next;
        });
        setFocusIndex(p => p + 1);
      } else if (key.return || input === ' ') {
        setGrabbed(false);
      } else if (key.escape) {
        setGrabbed(false);
        setItems(initial); // revert
      }
      return;
    }

    // ── Normal navigation ──
    if (key.upArrow) setFocusIndex(p => (p - 1 + total) % total);
    else if (key.downArrow) setFocusIndex(p => (p + 1) % total);
    else if (key.return || input === ' ') {
      if (focusIndex < items.length) setGrabbed(true);
      else if (focusIndex === saveIdx) onSave(items);
      else onCancel();
    } else if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {title}
      </Text>
      <Text dimColor>{'─'.repeat(36)}</Text>
      <Text dimColor>Enter/Space 选中项目，方向键移动，再次 Enter 放下</Text>
      <Text> </Text>

      {items.map((item, i) => {
        const focused = i === focusIndex;
        const isGrabbed = focused && grabbed;
        return (
          <Box key={item.id}>
            <Text
              color={isGrabbed ? 'yellow' : focused ? 'cyan' : undefined}
              bold={focused}
            >
              {isGrabbed ? '≡ ' : focused ? '❯ ' : '  '}
              {item.label}
              {isGrabbed ? '  ↕' : ''}
            </Text>
          </Box>
        );
      })}

      <Text> </Text>
      <Box gap={2}>
        <Text color={focusIndex === saveIdx ? 'green' : undefined} bold={focusIndex === saveIdx}>
          {focusIndex === saveIdx ? '❯ ' : '  '}[保存]
        </Text>
        <Text
          color={focusIndex === cancelIdx ? 'yellow' : undefined}
          bold={focusIndex === cancelIdx}
        >
          {focusIndex === cancelIdx ? '❯ ' : '  '}[取消]
        </Text>
      </Box>
    </Box>
  );
}
