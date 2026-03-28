import { useEffect, useMemo, useState } from 'react';
import { useInput } from 'ink';
import { useMouse } from '../context/mouse.tsx';
import { ScrollableTextBox } from './scrollable-text-box.tsx';

interface MultilineTextEditorProps {
  title: string;
  value: string;
  placeholder?: string;
  visibleRows?: number;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function MultilineTextEditor({
  title,
  value,
  placeholder,
  visibleRows = 12,
  onChange,
  onConfirm,
  onCancel,
}: MultilineTextEditorProps) {
  const { subscribe } = useMouse();
  const [scrollOffset, setScrollOffset] = useState(0);

  const lines = useMemo(() => {
    const source = value.length > 0 ? value : '';
    const baseLines = source.split('\n');
    if (baseLines.length === 0) {
      return [''];
    }

    return baseLines.map((line, index) =>
      index === baseLines.length - 1 ? `${line}█` : line,
    );
  }, [value]);

  const displayLines = useMemo(
    () =>
      value.length > 0
        ? lines.map(renderEditorLine)
        : [`${placeholder ?? '(空)'}█`],
    [lines, placeholder, value.length],
  );

  const maxOffset = Math.max(0, displayLines.length - visibleRows);

  useEffect(() => {
    setScrollOffset(Math.max(0, displayLines.length - visibleRows));
  }, [displayLines.length, visibleRows]);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return && key.shift) {
      onChange(`${value}\n`);
      return;
    }

    if (key.upArrow) {
      setScrollOffset((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow) {
      setScrollOffset((prev) => Math.min(maxOffset, prev + 1));
      return;
    }

    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }

    if (key.tab) {
      onChange(`${value}\t`);
      return;
    }

    if (key.ctrl && input === 'n') {
      onChange(`${value}\n`);
      return;
    }

    if (key.return) {
      onConfirm();
      return;
    }

    if (key.ctrl || key.meta) {
      return;
    }

    if (input) {
      onChange(value + input);
    }
  });

  useEffect(() => {
    return subscribe((event) => {
      if (event.action === 'scroll-up') {
        setScrollOffset((prev) => Math.max(0, prev - 1));
      } else if (event.action === 'scroll-down') {
        setScrollOffset((prev) => Math.min(maxOffset, prev + 1));
      }
    });
  }, [maxOffset, subscribe]);

  return (
    <ScrollableTextBox
      title={title}
      lines={displayLines}
      visibleRows={visibleRows}
      isActive={false}
      borderColor="cyan"
      titleColor="cyan"
      linePrefixWidth={2}
      scrollOffset={scrollOffset}
      onScrollOffsetChange={setScrollOffset}
      footerHint="  Enter 确认 · Ctrl+N 换行 · Shift+Enter(若终端支持)换行 · Tab 输入制表符 · Esc 取消"
    />
  );
}

function renderEditorLine(line: string): string {
  return line.replace(/\t/g, '    ');
}
