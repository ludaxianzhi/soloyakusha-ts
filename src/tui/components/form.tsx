import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { FormFieldDef } from '../types.ts';

interface FormProps {
  title: string;
  fields: FormFieldDef[];
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
  submitLabel?: string;
}

export function Form({
  title,
  fields,
  onSubmit,
  onCancel,
  submitLabel = '确认',
}: FormProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [editing, setEditing] = useState(false);
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
      if (activeIndex === submitIdx) onSubmit(values);
      else if (activeIndex === cancelIdx) onCancel();
      else setEditing(true);
    } else if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {title}
      </Text>
      <Text dimColor>{'─'.repeat(36)}</Text>

      {fields.map((field, i) => {
        const focused = i === activeIndex;
        const isEditing = focused && editing;
        const val = values[field.key] ?? '';

        return (
          <Box key={field.key}>
            <Text color={focused ? 'cyan' : undefined}>{focused ? '❯ ' : '  '}</Text>
            <Text bold>{field.label}: </Text>

            {field.type === 'text' ? (
              <Box>
                <Text dimColor={!val}>{val || field.placeholder || '(空)'}</Text>
                {isEditing && <Text color="cyan">█</Text>}
              </Box>
            ) : (
              <Text>
                {isEditing ? '◄ ' : ''}
                {field.options?.find(o => o.value === val)?.label ?? val}
                {isEditing ? ' ►' : ''}
              </Text>
            )}
          </Box>
        );
      })}

      <Text> </Text>
      <Box gap={2}>
        <Text color={activeIndex === submitIdx ? 'green' : undefined} bold={activeIndex === submitIdx}>
          {activeIndex === submitIdx ? '❯ ' : '  '}[{submitLabel}]
        </Text>
        <Text
          color={activeIndex === cancelIdx ? 'yellow' : undefined}
          bold={activeIndex === cancelIdx}
        >
          {activeIndex === cancelIdx ? '❯ ' : '  '}[取消]
        </Text>
      </Box>
    </Box>
  );
}
