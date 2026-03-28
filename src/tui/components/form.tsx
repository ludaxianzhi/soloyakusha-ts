import { useEffect, useState } from 'react';
import { Text, useInput } from 'ink';
import type { FormFieldDef } from '../types.ts';
import { useMouse } from '../context/mouse.tsx';
import { SafeBox } from './safe-box.tsx';

interface FormProps {
  title: string;
  fields: FormFieldDef[];
  onSubmit: (values: Record<string, string>) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
  submitLabel?: string;
  visibleRows?: number;
}

export function Form({
  title,
  fields,
  onSubmit,
  onCancel,
  submitLabel = '确认',
  visibleRows = 12,
}: FormProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const { subscribe } = useMouse();
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of fields) {
      init[f.key] =
        f.defaultValue ?? (f.type === 'select' ? (f.options?.[0]?.value ?? '') : '');
    }
    return init;
  });

  const submitIdx = fields.length;
  const cancelIdx = fields.length + 1;
  const total = fields.length + 2;

  // Scrolling: compute visible window
  const [scrollOffset, setScrollOffset] = useState(0);
  useEffect(() => {
    if (activeIndex < scrollOffset) {
      setScrollOffset(activeIndex);
    } else if (activeIndex >= scrollOffset + visibleRows) {
      setScrollOffset(activeIndex - visibleRows + 1);
    }
  }, [activeIndex, scrollOffset, visibleRows]);

  useInput((input, key) => {
    // ── Editing mode ──
    if (editing) {
      const field = fields[activeIndex];
      if (!field) return;

      if (key.return || (key.escape && field.type === 'text')) {
        setEditing(false);
        return;
      }

      if (field.type === 'text') {
        if (key.backspace || key.delete) {
          setValues(p => ({ ...p, [field.key]: (p[field.key] ?? '').slice(0, -1) }));
        } else if (input && !key.ctrl && !key.meta && !key.escape) {
          setValues(p => ({ ...p, [field.key]: (p[field.key] ?? '') + input }));
        }
        return;
      }

      // select type
      if (field.options && field.options.length > 0) {
        const cur = field.options.findIndex(o => o.value === values[field.key]);
        if (key.leftArrow || key.upArrow) {
          const next = (cur - 1 + field.options.length) % field.options.length;
          setValues(p => ({ ...p, [field.key]: field.options![next]!.value }));
        } else if (key.rightArrow || key.downArrow) {
          const next = (cur + 1) % field.options.length;
          setValues(p => ({ ...p, [field.key]: field.options![next]!.value }));
        } else if (key.return || key.escape) {
          setEditing(false);
        }
      }
      return;
    }

    // ── Navigation mode ──
      if (key.upArrow) setActiveIndex(p => (p - 1 + total) % total);
      else if (key.downArrow) setActiveIndex(p => (p + 1) % total);
      else if (key.return) {
        if (activeIndex === submitIdx) void onSubmit(values);
        else if (activeIndex === cancelIdx) void onCancel();
        else setEditing(true);
      } else if (key.escape) void onCancel();
  });

  useEffect(() => {
    return subscribe(event => {
      if (event.action === 'scroll-up') {
        if (editing) {
          const field = fields[activeIndex];
          if (field?.type !== 'select' || !field.options?.length) return;
          const cur = field.options.findIndex(option => option.value === values[field.key]);
          const next = (cur - 1 + field.options.length) % field.options.length;
          setValues(prev => ({ ...prev, [field.key]: field.options![next]!.value }));
          return;
        }
        setActiveIndex(prev => (prev - 1 + total) % total);
      } else if (event.action === 'scroll-down') {
        if (editing) {
          const field = fields[activeIndex];
          if (field?.type !== 'select' || !field.options?.length) return;
          const cur = field.options.findIndex(option => option.value === values[field.key]);
          const next = (cur + 1) % field.options.length;
          setValues(prev => ({ ...prev, [field.key]: field.options![next]!.value }));
          return;
        }
        setActiveIndex(prev => (prev + 1) % total);
      } else if (event.action === 'left') {
        if (editing) {
          setEditing(false);
          return;
        }
        if (activeIndex === submitIdx) void onSubmit(values);
        else if (activeIndex === cancelIdx) void onCancel();
        else setEditing(true);
      } else if (event.action === 'right') {
        if (editing) {
          setEditing(false);
        } else {
          void onCancel();
        }
      }
    });
  }, [activeIndex, editing, fields, onCancel, onSubmit, subscribe, total, values]);

  // Build all rows (fields + buttons)
  const allRows: { index: number; node: React.ReactNode }[] = [];

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    const focused = i === activeIndex;
    const isEditing = focused && editing;
    const val = values[field.key] ?? '';
    const displayVal = field.type === 'select'
      ? (isEditing ? `◄ ${field.options?.find(o => o.value === val)?.label ?? val} ►` : field.options?.find(o => o.value === val)?.label ?? val)
      : (isEditing ? `${val}█` : val || field.placeholder || '(空)');

    allRows.push({
      index: i,
      node: (
        <SafeBox key={field.key}>
          <Text
            backgroundColor={focused ? 'white' : undefined}
            color={focused ? 'black' : undefined}
            bold={focused}
            wrap="truncate-end"
          >
            {` ${field.label}  `}
            <Text
              backgroundColor={focused ? 'white' : undefined}
              color={focused ? (isEditing ? 'blue' : 'black') : 'gray'}
              dimColor={!focused && !val}
            >
              {displayVal}
            </Text>
            {`  `}
            <Text
              backgroundColor={focused ? 'white' : undefined}
              color={focused ? 'black' : 'gray'}
              dimColor={!focused}
            >
              {field.type === 'text' ? '[文本]' : '[选择]'}
            </Text>
          </Text>
        </SafeBox>
      ),
    });
  }

  // Submit button
  allRows.push({
    index: submitIdx,
    node: (
      <SafeBox key="__submit">
        <Text
          backgroundColor={activeIndex === submitIdx ? 'green' : undefined}
          color={activeIndex === submitIdx ? 'white' : 'green'}
          bold={activeIndex === submitIdx}
        >
          {` ✔ ${submitLabel} `}
        </Text>
        <Text> </Text>
        <Text
          backgroundColor={activeIndex === cancelIdx ? 'yellow' : undefined}
          color={activeIndex === cancelIdx ? 'black' : 'yellow'}
          bold={activeIndex === cancelIdx}
        >
          {` ✘ 取消 `}
        </Text>
      </SafeBox>
    ),
  });

  // Visible window
  const visibleItems = allRows.slice(scrollOffset, scrollOffset + visibleRows);
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset + visibleRows < allRows.length;

  return (
    <SafeBox flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">{title}</Text>
      {hasScrollUp ? <Text dimColor>  ▲ 更多 ({scrollOffset})</Text> : null}
      {visibleItems.map(row => row.node)}
      {hasScrollDown ? <Text dimColor>  ▼ 更多 ({allRows.length - scrollOffset - visibleRows})</Text> : null}
    </SafeBox>
  );
}
