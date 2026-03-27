import { useEffect, useState } from 'react';
import { Text, useInput } from 'ink';
import type { FormFieldDef } from '../types.ts';
import { Panel } from './panel.tsx';
import { Keycap } from './keycap.tsx';
import { useMouse } from '../context/mouse.tsx';
import { SafeBox } from './safe-box.tsx';

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

  useEffect(() => {
    return subscribe(event => {
      if (event.action === 'scroll-up') {
        if (editing) {
          const field = fields[activeIndex];
          if (field?.type !== 'select' || !field.options?.length) {
            return;
          }

          const cur = field.options.findIndex(option => option.value === values[field.key]);
          const next = (cur - 1 + field.options.length) % field.options.length;
          setValues(prev => ({ ...prev, [field.key]: field.options![next]!.value }));
          return;
        }

        setActiveIndex(prev => (prev - 1 + total) % total);
      } else if (event.action === 'scroll-down') {
        if (editing) {
          const field = fields[activeIndex];
          if (field?.type !== 'select' || !field.options?.length) {
            return;
          }

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

        if (activeIndex === submitIdx) onSubmit(values);
        else if (activeIndex === cancelIdx) onCancel();
        else setEditing(true);
      } else if (event.action === 'right') {
        if (editing) {
          setEditing(false);
        } else {
          onCancel();
        }
      }
    });
  }, [activeIndex, editing, fields, onCancel, onSubmit, subscribe, total, values]);

  return (
    <Panel title={title} subtitle="Tabless form flow with keyboard-first interaction and mouse-assisted scrolling.">
      <SafeBox flexDirection="column">
        {fields.map((field, i) => {
          const focused = i === activeIndex;
          const isEditing = focused && editing;
          const val = values[field.key] ?? '';

          return (
            <SafeBox
              key={field.key}
              flexDirection="column"
              borderStyle="round"
              borderColor={focused ? 'cyan' : 'gray'}
              paddingX={1}
              marginBottom={1}
            >
              <SafeBox justifyContent="space-between">
                <Text color={focused ? 'cyan' : undefined} bold>
                  {focused ? '❯ ' : '  '}
                  {field.label}
                </Text>
                <Text dimColor>{field.type === 'text' ? 'TEXT' : 'SELECT'}</Text>
              </SafeBox>

              {field.description ? (
                <Text dimColor wrap="wrap">
                  {field.description}
                </Text>
              ) : null}

              {field.type === 'text' ? (
                <SafeBox marginTop={1}>
                  <Text dimColor={!val}>{val || field.placeholder || '(空)'}</Text>
                  {isEditing ? <Text color="cyan">█</Text> : null}
                </SafeBox>
              ) : (
                <SafeBox marginTop={1}>
                  <Text>
                    {isEditing ? '◄ ' : ''}
                    {field.options?.find(o => o.value === val)?.label ?? val}
                    {isEditing ? ' ►' : ''}
                  </Text>
                </SafeBox>
              )}
            </SafeBox>
          );
        })}

        <SafeBox gap={2} marginBottom={1}>
          <Text color={activeIndex === submitIdx ? 'green' : undefined} bold={activeIndex === submitIdx}>
            {activeIndex === submitIdx ? '❯ ' : '  '}[{submitLabel}]
          </Text>
          <Text
            color={activeIndex === cancelIdx ? 'yellow' : undefined}
            bold={activeIndex === cancelIdx}
          >
            {activeIndex === cancelIdx ? '❯ ' : '  '}[取消]
          </Text>
        </SafeBox>

        <SafeBox gap={1}>
          <Keycap label="Enter" />
          <Text dimColor>{editing ? '完成当前字段编辑' : '进入字段或确认动作'}</Text>
        </SafeBox>
        <SafeBox gap={1}>
          <Keycap label="Wheel" />
          <Text dimColor>在字段与选项间滚动</Text>
        </SafeBox>
        <SafeBox gap={1}>
          <Keycap label="Right Click" />
          <Text dimColor>{editing ? '退出编辑' : '取消并返回'}</Text>
        </SafeBox>
      </SafeBox>
    </Panel>
  );
}
