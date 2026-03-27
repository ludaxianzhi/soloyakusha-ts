import { useEffect, useState } from 'react';
import { Text, useInput } from 'ink';
import { Panel } from './panel.tsx';
import { Keycap } from './keycap.tsx';
import { useMouse } from '../context/mouse.tsx';
import { SafeBox } from './safe-box.tsx';

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
  const { subscribe } = useMouse();

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

  useEffect(() => {
    return subscribe(event => {
      if (event.action === 'scroll-up') {
        if (grabbed && focusIndex > 0) {
          setItems(prev => {
            const next = [...prev];
            [next[focusIndex - 1], next[focusIndex]] = [next[focusIndex]!, next[focusIndex - 1]!];
            return next;
          });
          setFocusIndex(prev => prev - 1);
          return;
        }

        setFocusIndex(prev => (prev - 1 + total) % total);
      } else if (event.action === 'scroll-down') {
        if (grabbed && focusIndex < items.length - 1) {
          setItems(prev => {
            const next = [...prev];
            [next[focusIndex], next[focusIndex + 1]] = [next[focusIndex + 1]!, next[focusIndex]!];
            return next;
          });
          setFocusIndex(prev => prev + 1);
          return;
        }

        setFocusIndex(prev => (prev + 1) % total);
      } else if (event.action === 'left') {
        if (focusIndex < items.length) setGrabbed(prev => !prev);
        else if (focusIndex === saveIdx) onSave(items);
        else onCancel();
      } else if (event.action === 'right') {
        if (grabbed) {
          setGrabbed(false);
          setItems(initial);
        } else {
          onCancel();
        }
      }
    });
  }, [focusIndex, grabbed, initial, items, onCancel, onSave, saveIdx, subscribe, total]);

  return (
    <Panel
      title={title}
      subtitle="Enter / 左键抓取项目；方向键或滚轮移动；再次确认即可放下。"
      tone="magenta"
    >
      <SafeBox flexDirection="column">
        {items.map((item, i) => {
          const focused = i === focusIndex;
          const isGrabbed = focused && grabbed;
          return (
            <SafeBox
              key={item.id}
              borderStyle="round"
              borderColor={isGrabbed ? 'yellow' : focused ? 'cyan' : 'gray'}
              paddingX={1}
              marginBottom={1}
            >
              <Text
                color={isGrabbed ? 'yellow' : focused ? 'cyan' : undefined}
                bold={focused}
              >
                {isGrabbed ? '≡ ' : focused ? '❯ ' : '  '}
                {item.label}
                {isGrabbed ? '  ↕' : ''}
              </Text>
            </SafeBox>
          );
        })}

        <SafeBox gap={2} marginBottom={1}>
          <Text color={focusIndex === saveIdx ? 'green' : undefined} bold={focusIndex === saveIdx}>
            {focusIndex === saveIdx ? '❯ ' : '  '}[保存]
          </Text>
          <Text
            color={focusIndex === cancelIdx ? 'yellow' : undefined}
            bold={focusIndex === cancelIdx}
          >
            {focusIndex === cancelIdx ? '❯ ' : '  '}[取消]
          </Text>
        </SafeBox>

        <SafeBox gap={1}>
          <Keycap label="Space" />
          <Text dimColor>抓取 / 放下</Text>
        </SafeBox>
      </SafeBox>
    </Panel>
  );
}
