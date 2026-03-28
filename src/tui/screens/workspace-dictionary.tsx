import { useMemo, useState } from 'react';
import { Text, useInput } from 'ink';
import {
  GLOSSARY_TERM_CATEGORIES,
  type ResolvedGlossaryTerm,
} from '../../glossary/glossary.ts';
import { Form } from '../components/form.tsx';
import { Select } from '../components/select.tsx';
import { SafeBox } from '../components/safe-box.tsx';
import { useLog } from '../context/log.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useProject } from '../context/project.tsx';
import type { FormFieldDef, SelectItem } from '../types.ts';

type DictionaryAction =
  | '__add__'
  | '__import__'
  | '__export__'
  | '__back__'
  | string;
type GlossaryMode = 'import' | 'export' | null;

export function WorkspaceDictionaryScreen() {
  const { goBack } = useNavigation();
  const { addLog } = useLog();
  const {
    project,
    updateDictionaryTerm,
    importGlossary,
    exportGlossary,
    isBusy,
  } = useProject();
  const glossary = project?.getGlossary();
  const terms = glossary?.getAllTerms() ?? [];
  const [editingTerm, setEditingTerm] = useState<ResolvedGlossaryTerm | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [glossaryMode, setGlossaryMode] = useState<GlossaryMode>(null);

  useInput((_input, key) => {
    if (key.escape && !editingTerm && !isCreating && !glossaryMode) {
      goBack();
    }
  });

  if (glossaryMode) {
    const isImport = glossaryMode === 'import';
    const fields: FormFieldDef[] = [
      {
        key: 'filePath',
        label: isImport ? '术语表文件路径' : '导出文件路径',
        type: 'text',
        placeholder: isImport ? 'glossary.csv' : 'export\\glossary.csv',
        description: isImport
          ? '支持导入 CSV / JSON / YAML 等术语表文件。'
          : '导出术语表到指定文件。',
        defaultValue: isImport
          ? ''
          : project?.getWorkspaceFileManifest().glossaryPath ?? 'export\\glossary.csv',
      },
    ];

    return (
      <Form
        title={isImport ? '导入术语表' : '导出术语表'}
        fields={fields}
        submitLabel={isImport ? '导入' : '导出'}
        onSubmit={async (values) => {
          const filePath = values.filePath?.trim();
          if (!filePath) {
            addLog('warning', isImport ? '请输入术语表文件路径' : '请输入导出文件路径');
            return;
          }

          if (isImport) {
            await importGlossary(filePath);
          } else {
            await exportGlossary(filePath);
          }
          setGlossaryMode(null);
        }}
        onCancel={() => setGlossaryMode(null)}
      />
    );
  }

  const selectedTerm = editingTerm;
  if (selectedTerm || isCreating) {
    const fields: FormFieldDef[] = [
      {
        key: 'term',
        label: '术语',
        type: 'text',
        placeholder: '输入术语...',
        description: '术语原文。',
        defaultValue: selectedTerm?.term ?? '',
      },
      {
        key: 'translation',
        label: '译文',
        type: 'text',
        placeholder: '输入译文...',
        description: '术语的目标语言翻译。',
        defaultValue: selectedTerm?.translation ?? '',
      },
      {
        key: 'status',
        label: '状态',
        type: 'select',
        description: '术语当前是否已完成翻译。',
        defaultValue: selectedTerm?.status ?? 'untranslated',
        options: [
          { label: 'translated', value: 'translated' },
          { label: 'untranslated', value: 'untranslated' },
        ],
      },
      {
        key: 'category',
        label: '类别',
        type: 'select',
        description: '术语类别。',
        defaultValue: selectedTerm?.category ?? '',
        options: [
          { label: '(无)', value: '' },
          ...GLOSSARY_TERM_CATEGORIES.map((category) => ({
            label: category,
            value: category,
          })),
        ],
      },
      {
        key: 'description',
        label: '说明',
        type: 'text',
        placeholder: '输入说明...',
        description: '可选备注和上下文说明。',
        defaultValue: selectedTerm?.description ?? '',
      },
    ];

    return (
      <Form
        title={isCreating ? '新增字典条目' : `编辑字典条目 · ${selectedTerm?.term ?? ''}`}
        fields={fields}
        submitLabel="保存条目"
        onSubmit={async (values) => {
          await updateDictionaryTerm({
            originalTerm: selectedTerm?.term,
            term: values.term ?? '',
            translation: values.translation ?? '',
            description: values.description ?? '',
            category: values.category ?? '',
            status:
              values.status === 'translated' || values.status === 'untranslated'
                ? values.status
                : undefined,
          });
          setEditingTerm(null);
          setIsCreating(false);
        }}
        onCancel={() => {
          setEditingTerm(null);
          setIsCreating(false);
        }}
      />
    );
  }

  const items: SelectItem<DictionaryAction>[] = [
    {
      label: '📥 导入术语表',
      value: '__import__',
      description: '从外部文件导入项目术语表。',
      meta: 'import',
    },
    ...(glossary
      ? [
          {
            label: '📤 导出术语表',
            value: '__export__' as DictionaryAction,
            description: '将当前项目术语表导出到文件。',
            meta: 'export',
          },
          {
            label: '➕ 新增术语',
            value: '__add__' as DictionaryAction,
            description: '手动新增一个字典条目。',
            meta: 'new',
          },
          ...terms.map((term) => ({
            label: `${term.term}${term.translation ? ` → ${term.translation}` : ''}`,
            value: term.term,
            description:
              term.description ??
              `状态：${term.status} · 出现次数 ${term.totalOccurrenceCount}/${term.textBlockOccurrenceCount}`,
            meta: term.status,
          })),
        ]
      : []),
    {
      label: '↩️ 返回',
      value: '__back__',
      description: '回到项目主页。',
      meta: 'esc',
    },
  ];

  return (
    <SafeBox flexDirection="column" gap={1}>
      <SafeBox flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text bold color="yellow">项目字典</Text>
        {!glossary ? (
          <Text dimColor>当前项目还没有字典，请先在项目主页执行“开始扫描字典”。</Text>
        ) : (
          <Text>
            总条目：{terms.length}
            {' · '}已翻译 {terms.filter((term) => term.status === 'translated').length}
            {' · '}未翻译 {terms.filter((term) => term.status === 'untranslated').length}
          </Text>
        )}
      </SafeBox>

      <Select
        title="字典条目"
        items={items}
        isActive={!isBusy}
        onSelect={(item) => {
          if (item.value === '__back__') {
            goBack();
            return;
          }
          if (item.value === '__import__') {
            setGlossaryMode('import');
            return;
          }
          if (item.value === '__export__') {
            setGlossaryMode('export');
            return;
          }
          if (item.value === '__add__') {
            if (!glossary) {
              addLog('warning', '请先导入术语表或执行术语扫描，再新增术语');
              return;
            }
            setIsCreating(true);
            return;
          }

          const nextTerm = terms.find((term) => term.term === item.value);
          if (nextTerm) {
            setEditingTerm(nextTerm);
          }
        }}
      />
    </SafeBox>
  );
}
