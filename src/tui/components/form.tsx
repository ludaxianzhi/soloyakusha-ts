import { useEffect, useMemo, useState } from 'react';
import { Text, useInput } from 'ink';
import type { AutocompleteItem, FormFieldDef } from '../types.ts';
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

type RenderRow = {
  key: string;
  focusableIndex?: number;
  node: React.ReactNode;
};

type AutocompleteQuery = {
  fieldKey: string;
  input: string;
  values: Record<string, string>;
};

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
    for (const field of fields) {
      init[field.key] =
        field.defaultValue ??
        ((field.type === 'select' ? field.options?.[0]?.value : '') ?? '');
    }
    return init;
  });
  const [autocompleteRevision, setAutocompleteRevision] = useState(0);
  const [autocompleteQuery, setAutocompleteQuery] = useState<AutocompleteQuery | null>(null);
  const [autocompleteLoading, setAutocompleteLoading] = useState(false);
  const [autocompleteItems, setAutocompleteItems] = useState<AutocompleteItem[]>([]);
  const [autocompleteSelectedIndex, setAutocompleteSelectedIndex] = useState(-1);

  const submitIdx = fields.length;
  const cancelIdx = fields.length + 1;
  const total = fields.length + 2;
  const activeField = activeIndex < fields.length ? fields[activeIndex] : undefined;
  const activeAutocomplete =
    editing && activeField?.type === 'autocomplete' ? activeField.autocomplete : undefined;

  useEffect(() => {
    if (!activeAutocomplete || !activeField) {
      setAutocompleteItems([]);
      setAutocompleteSelectedIndex(-1);
      setAutocompleteLoading(false);
      return;
    }

    const currentInput = autocompleteQuery?.fieldKey === activeField.key
      ? autocompleteQuery.input
      : values[activeField.key] ?? '';
    const queryValues = autocompleteQuery?.fieldKey === activeField.key
      ? autocompleteQuery.values
      : values;
    if (!activeAutocomplete.showWhenEmpty && currentInput.trim().length === 0) {
      setAutocompleteItems([]);
      setAutocompleteSelectedIndex(-1);
      setAutocompleteLoading(false);
      return;
    }

    let cancelled = false;
    setAutocompleteLoading(true);
    void Promise.resolve(activeAutocomplete.getSuggestions(currentInput, queryValues))
      .then((items) => {
        if (cancelled) {
          return;
        }
        const maxItems = Math.max(1, activeAutocomplete.maxItems ?? 5);
        setAutocompleteItems(items.slice(0, maxItems));
        setAutocompleteSelectedIndex(-1);
      })
      .catch(() => {
        if (!cancelled) {
          setAutocompleteItems([]);
          setAutocompleteSelectedIndex(-1);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAutocompleteLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeAutocomplete, activeField, autocompleteQuery, autocompleteRevision, editing, values]);

  const renderRows = useMemo<RenderRow[]>(() => {
    const rows: RenderRow[] = [];

    for (let i = 0; i < fields.length; i += 1) {
      const field = fields[i]!;
      const focused = i === activeIndex;
      const isEditing = focused && editing;
      const value = values[field.key] ?? '';
      const displayValue =
        field.type === 'select'
          ? isEditing
            ? `◄ ${field.options?.find((option) => option.value === value)?.label ?? value} ►`
            : field.options?.find((option) => option.value === value)?.label ?? value
          : field.type === 'textarea'
            ? isEditing
              ? `${formatMultilineValue(value)}█`
              : formatMultilineValue(value) || field.placeholder || '(空)'
          : isEditing
            ? `${value}█`
            : value || field.placeholder || '(空)';

      rows.push({
        key: `field:${field.key}`,
        focusableIndex: i,
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
                dimColor={!focused && !value}
              >
                {displayValue}
              </Text>
              {`  `}
              <Text
                backgroundColor={focused ? 'white' : undefined}
                color={focused ? 'black' : 'gray'}
                dimColor={!focused}
              >
                {field.type === 'text'
                  ? '[文本]'
                  : field.type === 'textarea'
                    ? '[多行]'
                  : field.type === 'select'
                    ? '[选择]'
                    : '[Tab补全]'}
              </Text>
            </Text>
          </SafeBox>
        ),
      });

      if (focused && isEditing && field.type === 'autocomplete') {
        if (autocompleteLoading) {
          rows.push({
            key: `${field.key}:loading`,
            node: <Text dimColor>{'   … 正在补全'}</Text>,
          });
        } else {
          for (let suggestionIndex = 0; suggestionIndex < autocompleteItems.length; suggestionIndex += 1) {
            const suggestion = autocompleteItems[suggestionIndex]!;
            const selected = suggestionIndex === autocompleteSelectedIndex;
            rows.push({
              key: `${field.key}:suggestion:${suggestion.value}:${suggestionIndex}`,
              node: (
                <SafeBox key={`${field.key}:${suggestion.value}:${suggestionIndex}`} justifyContent="space-between">
                  <Text
                    backgroundColor={selected ? 'cyan' : undefined}
                    color={selected ? 'black' : 'gray'}
                    wrap="truncate-end"
                  >
                    {`   ${selected ? '❯' : ' '} ${suggestion.label}`}
                  </Text>
                  {suggestion.meta ? (
                    <Text
                      backgroundColor={selected ? 'cyan' : undefined}
                      color={selected ? 'black' : 'gray'}
                    >
                      {` ${suggestion.meta} `}
                    </Text>
                  ) : null}
                </SafeBox>
              ),
            });
          }
        }
      }
    }

    rows.push({
      key: '__submit',
      focusableIndex: submitIdx,
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

    return rows;
  }, [
    activeIndex,
    autocompleteItems,
    autocompleteLoading,
    autocompleteSelectedIndex,
    cancelIdx,
    editing,
    fields,
    submitIdx,
    submitLabel,
    values,
  ]);

  const activeRowIndex = renderRows.findIndex((row) => row.focusableIndex === activeIndex);
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    const focusRow = activeRowIndex >= 0 ? activeRowIndex : 0;
    let requiredLastVisibleRow = focusRow;
    if (activeAutocomplete && autocompleteItems.length > 0) {
      requiredLastVisibleRow = Math.min(
        renderRows.length - 1,
        focusRow + autocompleteItems.length,
      );
    }

    if (focusRow < scrollOffset) {
      setScrollOffset(focusRow);
    } else if (requiredLastVisibleRow >= scrollOffset + visibleRows) {
      setScrollOffset(requiredLastVisibleRow - visibleRows + 1);
    }
  }, [activeAutocomplete, activeRowIndex, autocompleteItems.length, renderRows.length, scrollOffset, visibleRows]);

  useInput((input, key) => {
    if (editing) {
      const field = fields[activeIndex];
      if (!field) {
        return;
      }

      const isTab = input === '\t' || key.tab === true;
      if (field.type === 'autocomplete') {
        if (isTab) {
          if (autocompleteItems.length === 0) {
            return;
          }
          const nextIndex = (autocompleteSelectedIndex + 1 + autocompleteItems.length) % autocompleteItems.length;
          const nextItem = autocompleteItems[nextIndex]!;
          setAutocompleteSelectedIndex(nextIndex);
          setValues((prev) => ({ ...prev, [field.key]: nextItem.value }));
          return;
        }

        if (key.return || key.escape) {
          setEditing(false);
          return;
        }

        if (key.backspace || key.delete) {
          const nextValues = { ...values, [field.key]: (values[field.key] ?? '').slice(0, -1) };
          setValues(nextValues);
          setAutocompleteQuery({
            fieldKey: field.key,
            input: nextValues[field.key] ?? '',
            values: nextValues,
          });
          setAutocompleteRevision((prev) => prev + 1);
          return;
        }

        if (input && !key.ctrl && !key.meta && !key.escape) {
          const nextValues = { ...values, [field.key]: (values[field.key] ?? '') + input };
          setValues(nextValues);
          setAutocompleteQuery({
            fieldKey: field.key,
            input: nextValues[field.key] ?? '',
            values: nextValues,
          });
          setAutocompleteRevision((prev) => prev + 1);
        }
        return;
      }

      if (field.type === 'textarea') {
        if (key.escape) {
          setEditing(false);
          return;
        }

        if (key.backspace || key.delete) {
          setValues((prev) => ({ ...prev, [field.key]: (prev[field.key] ?? '').slice(0, -1) }));
        } else if (key.return) {
          setValues((prev) => ({ ...prev, [field.key]: `${prev[field.key] ?? ''}\n` }));
        } else if (input && !key.ctrl && !key.meta && !key.escape) {
          setValues((prev) => ({ ...prev, [field.key]: (prev[field.key] ?? '') + input }));
        }
        return;
      }

      if (key.return || (key.escape && field.type === 'text')) {
        setEditing(false);
        return;
      }

      if (field.type === 'text') {
        if (key.backspace || key.delete) {
          setValues((prev) => ({ ...prev, [field.key]: (prev[field.key] ?? '').slice(0, -1) }));
        } else if (input && !key.ctrl && !key.meta && !key.escape) {
          setValues((prev) => ({ ...prev, [field.key]: (prev[field.key] ?? '') + input }));
        }
        return;
      }

      if (field.options && field.options.length > 0) {
        const currentIndex = field.options.findIndex((option) => option.value === values[field.key]);
        if (key.leftArrow || key.upArrow) {
          const next = (currentIndex - 1 + field.options.length) % field.options.length;
          setValues((prev) => ({ ...prev, [field.key]: field.options![next]!.value }));
        } else if (key.rightArrow || key.downArrow) {
          const next = (currentIndex + 1) % field.options.length;
          setValues((prev) => ({ ...prev, [field.key]: field.options![next]!.value }));
        } else if (key.return || key.escape) {
          setEditing(false);
        }
      }
      return;
    }

    if (key.upArrow) {
      setActiveIndex((prev) => (prev - 1 + total) % total);
    } else if (key.downArrow) {
      setActiveIndex((prev) => (prev + 1) % total);
    } else if (key.return) {
      if (activeIndex === submitIdx) {
        void onSubmit(values);
      } else if (activeIndex === cancelIdx) {
        void onCancel();
      } else {
        setEditing(true);
        if (fields[activeIndex]?.type === 'autocomplete') {
          setAutocompleteQuery({
            fieldKey: fields[activeIndex]!.key,
            input: values[fields[activeIndex]!.key] ?? '',
            values: { ...values },
          });
        }
        setAutocompleteRevision((prev) => prev + 1);
      }
    } else if (key.escape) {
      void onCancel();
    }
  });

  useEffect(() => {
    return subscribe((event) => {
      if (event.action === 'scroll-up') {
        if (editing) {
          const field = fields[activeIndex];
          if (field?.type !== 'select' || !field.options?.length) {
            return;
          }
          const currentIndex = field.options.findIndex((option) => option.value === values[field.key]);
          const next = (currentIndex - 1 + field.options.length) % field.options.length;
          setValues((prev) => ({ ...prev, [field.key]: field.options![next]!.value }));
          return;
        }
        setActiveIndex((prev) => (prev - 1 + total) % total);
      } else if (event.action === 'scroll-down') {
        if (editing) {
          const field = fields[activeIndex];
          if (field?.type !== 'select' || !field.options?.length) {
            return;
          }
          const currentIndex = field.options.findIndex((option) => option.value === values[field.key]);
          const next = (currentIndex + 1) % field.options.length;
          setValues((prev) => ({ ...prev, [field.key]: field.options![next]!.value }));
          return;
        }
        setActiveIndex((prev) => (prev + 1) % total);
      } else if (event.action === 'left') {
        if (editing) {
          setEditing(false);
          return;
        }
        if (activeIndex === submitIdx) {
          void onSubmit(values);
        } else if (activeIndex === cancelIdx) {
          void onCancel();
        } else {
          setEditing(true);
          if (fields[activeIndex]?.type === 'autocomplete') {
            setAutocompleteQuery({
              fieldKey: fields[activeIndex]!.key,
              input: values[fields[activeIndex]!.key] ?? '',
              values: { ...values },
            });
          }
          setAutocompleteRevision((prev) => prev + 1);
        }
      } else if (event.action === 'right') {
        if (editing) {
          setEditing(false);
        } else {
          void onCancel();
        }
      }
    });
  }, [activeIndex, cancelIdx, editing, fields, onCancel, onSubmit, submitIdx, subscribe, total, values]);

  const visibleItems = renderRows.slice(scrollOffset, scrollOffset + visibleRows);
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset + visibleRows < renderRows.length;

  return (
    <SafeBox flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">{title}</Text>
      {hasScrollUp ? <Text dimColor>  ▲ 更多 ({scrollOffset})</Text> : null}
      {visibleItems.map((row) => row.node)}
      {editing && activeField?.type === 'autocomplete' ? (
        <Text dimColor>  Tab 切换补全，Enter 确认，继续输入后刷新候选</Text>
      ) : null}
      {editing && activeField?.type === 'textarea' ? (
        <Text dimColor>  Enter 换行，Esc 完成编辑</Text>
      ) : null}
      {hasScrollDown ? <Text dimColor>  ▼ 更多 ({renderRows.length - scrollOffset - visibleRows})</Text> : null}
    </SafeBox>
  );
}

function formatMultilineValue(value: string): string {
  return value.replace(/\n/g, ' ⏎ ');
}
