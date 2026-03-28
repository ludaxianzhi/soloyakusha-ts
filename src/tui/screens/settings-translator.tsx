import { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, useInput } from 'ink';
import { GlobalConfigManager } from '../../config/manager.ts';
import type { TranslatorEntry } from '../../config/types.ts';
import { Form } from '../components/form.tsx';
import { Select } from '../components/select.tsx';
import { SafeBox } from '../components/safe-box.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import {
  buildLlmOptions,
  parseInteger,
  parseOptionalInteger,
  toErrorMessage,
} from './settings-translation-shared.ts';
import type { FormFieldDef, SelectItem } from '../types.ts';

type Mode =
  | { kind: 'loading' }
  | { kind: 'menu' }
  | { kind: 'create' }
  | { kind: 'translator-actions'; translatorName: string }
  | { kind: 'edit-translator'; translatorName: string };

type TranslatorSummary = {
  name: string;
  entry: TranslatorEntry;
};

const WORKFLOW_OPTIONS: SelectItem[] = [
  { label: 'default', value: 'default', description: '单步翻译（默认）' },
  { label: 'multi-stage', value: 'multi-stage', description: '多步骤文学翻译：分析→翻译→润色→[编辑+校对→修改]×N' },
];

/** multi-stage 工作流的六个步骤标识与标签。 */
const MULTI_STAGE_STEP_LABELS: { key: string; label: string; description: string }[] = [
  { key: 'analyzer',    label: 'LLM1 · 分析器',   description: '分析场景、视角、风格和翻译难点' },
  { key: 'translator',  label: 'LLM2 · 翻译器',   description: '初步翻译' },
  { key: 'polisher',    label: 'LLM3 · 润色师',   description: '润色译文使其更自然' },
  { key: 'editor',      label: 'LLM4 · 中文编辑', description: '指出表达问题并提供改进建议' },
  { key: 'proofreader', label: 'LLM5 · 校对专家', description: '校对理解错误（尊重文学性）' },
  { key: 'reviser',     label: 'LLM6 · 修改器',   description: '综合编辑和校对意见修改译文' },
];

export function SettingsTranslatorScreen() {
  const { goBack } = useNavigation();
  const { addLog } = useLog();
  const [mode, setMode] = useState<Mode>({ kind: 'loading' });
  const [translators, setTranslators] = useState<TranslatorSummary[]>([]);
  const [profileNames, setProfileNames] = useState<string[]>([]);
  const [defaultProfileName, setDefaultProfileName] = useState<string>('');

  const reload = useCallback(async () => {
    const manager = new GlobalConfigManager();
    const [names, profileNameList, defaultProfile] = await Promise.all([
      manager.listTranslatorNames(),
      manager.listLlmProfileNames(),
      manager.getDefaultLlmProfileName(),
    ]);
    const loadedTranslators = await Promise.all(
      names.map(async (name) => ({
        name,
        entry: (await manager.getTranslator(name))!,
      })),
    );
    setTranslators(loadedTranslators);
    setProfileNames(profileNameList);
    setDefaultProfileName(defaultProfile ?? '');
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await reload();
        setMode({ kind: 'menu' });
      } catch (error) {
        addLog('error', `读取翻译器配置失败：${toErrorMessage(error)}`);
        setMode({ kind: 'menu' });
      }
    })();
  }, [addLog, reload]);

  useInput((_input, key) => {
    if (!key.escape) return;

    if (mode.kind === 'menu' || mode.kind === 'loading') {
      goBack();
      return;
    }

    if (mode.kind === 'translator-actions') {
      setMode({ kind: 'menu' });
      return;
    }

    if (mode.kind === 'edit-translator') {
      setMode({ kind: 'translator-actions', translatorName: mode.translatorName });
      return;
    }

    setMode({ kind: 'menu' });
  });

  const llmOptions = useMemo(
    () => buildLlmOptions(profileNames, defaultProfileName),
    [defaultProfileName, profileNames],
  );

  const menuItems = useMemo<SelectItem<string>[]>(() => [
    ...translators.map((t) => ({
      label: t.name,
      value: `translator:${t.name}`,
      meta: t.entry.modelName,
      description: `类型: ${t.entry.type ?? 'default'}`,
    })),
    { label: '➕ 新建翻译器', value: '__new__', meta: 'new' },
    { label: '↩️ 返回', value: '__back__', meta: 'esc' },
  ], [translators]);

  if (mode.kind === 'loading') {
    return (
      <SafeBox flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
        <Text bold color="magenta">翻译器目录</Text>
        <Text dimColor>正在加载配置...</Text>
      </SafeBox>
    );
  }

  if (mode.kind === 'menu') {
    return (
      <SafeBox flexDirection="column" gap={1}>
        <SafeBox flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
          <Text bold color="magenta">翻译器目录</Text>
          <Text>
            已配置翻译器：<Text color="green">{translators.length}</Text>
          </Text>
        </SafeBox>
        <Select
          title="翻译器列表"
          items={menuItems}
          onSelect={(item) => {
            if (item.value === '__back__') {
              goBack();
              return;
            }
            if (item.value === '__new__') {
              setMode({ kind: 'create' });
              return;
            }
            const name = item.value.slice('translator:'.length);
            setMode({ kind: 'translator-actions', translatorName: name });
          }}
        />
      </SafeBox>
    );
  }

  if (mode.kind === 'translator-actions') {
    const translator = translators.find((t) => t.name === mode.translatorName);
    const actionItems: SelectItem<string>[] = [
      { label: '✏️ 编辑翻译器', value: '__edit__', meta: 'edit' },
      { label: '🗑️ 删除翻译器', value: '__delete__', meta: 'del' },
      { label: '↩️ 返回', value: '__back__', meta: 'esc' },
    ];

    return (
      <SafeBox flexDirection="column" gap={1}>
        <SafeBox flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
          <Text bold color="magenta">翻译器 · {mode.translatorName}</Text>
          <Text>
            类型：{translator?.entry.type ?? 'default'}
            {' · '}LLM：{translator?.entry.modelName ?? '(未知)'}
          </Text>
        </SafeBox>
        <Select
          title="操作"
          items={actionItems}
          onSelect={(item) => {
            if (item.value === '__back__') {
              setMode({ kind: 'menu' });
              return;
            }
            if (item.value === '__edit__') {
              setMode({ kind: 'edit-translator', translatorName: mode.translatorName });
              return;
            }
            void (async () => {
              try {
                const manager = new GlobalConfigManager();
                await manager.removeTranslator(mode.translatorName);
                await reload();
                addLog('success', `已删除翻译器：${mode.translatorName}`);
                setMode({ kind: 'menu' });
              } catch (error) {
                addLog('error', `删除翻译器失败：${toErrorMessage(error)}`);
              }
            })();
          }}
        />
      </SafeBox>
    );
  }

  const isEdit = mode.kind === 'edit-translator';
  const originalTranslator = isEdit
    ? translators.find((t) => t.name === mode.translatorName)
    : undefined;

  const fields = buildTranslatorEntryFields({
    translatorName: originalTranslator?.name,
    entry: originalTranslator?.entry,
    llmOptions,
  });

  return (
    <Form
      title={isEdit ? `编辑翻译器 · ${mode.translatorName}` : '新建翻译器'}
      fields={fields}
      submitLabel="保存翻译器"
      onSubmit={async (values) => {
        const translatorName = values.translatorName?.trim() ?? '';
        if (!translatorName) {
          addLog('warning', '翻译器名称不能为空');
          return;
        }

        if (
          translators.some((t) => t.name === translatorName) &&
          translatorName !== originalTranslator?.name
        ) {
          addLog('warning', `已存在同名翻译器：${translatorName}`);
          return;
        }

        if (!values.modelName) {
          addLog('warning', '请选择翻译器使用的 LLM 配置');
          return;
        }

        const workflowType = values.type?.trim() || undefined;
        const isMultiStage = workflowType === 'multi-stage';

        const models: Record<string, string> = {};
        if (isMultiStage) {
          for (const step of MULTI_STAGE_STEP_LABELS) {
            const val = values[`model_${step.key}`]?.trim();
            if (val && val !== values.modelName) {
              models[step.key] = val;
            }
          }
        }

        const entry: TranslatorEntry = {
          type: workflowType,
          modelName: values.modelName,
          slidingWindow: values.overlapChars
            ? { overlapChars: parseInteger(values.overlapChars, 0) }
            : undefined,
          models: Object.keys(models).length > 0 ? models : undefined,
          reviewIterations: isMultiStage
            ? parseOptionalInteger(values.reviewIterations)
            : undefined,
        };

        try {
          const manager = new GlobalConfigManager();
          await manager.setTranslator(translatorName, entry);

          if (isEdit && originalTranslator && originalTranslator.name !== translatorName) {
            await manager.removeTranslator(originalTranslator.name);
          }

          await reload();
          addLog('success', `翻译器已保存：${translatorName}`);
          setMode({ kind: 'menu' });
        } catch (error) {
          addLog('error', `保存翻译器失败：${toErrorMessage(error)}`);
        }
      }}
      onCancel={() => {
        if (isEdit) {
          setMode({ kind: 'translator-actions', translatorName: mode.translatorName });
          return;
        }
        setMode({ kind: 'menu' });
      }}
    />
  );
}

function buildTranslatorEntryFields(input: {
  translatorName?: string;
  entry?: TranslatorEntry;
  llmOptions: SelectItem[];
}): FormFieldDef[] {
  const workflowType = input.entry?.type ?? 'default';
  const isMultiStage = workflowType === 'multi-stage';

  const baseFields: FormFieldDef[] = [
    {
      key: 'translatorName',
      label: '翻译器名称',
      type: 'text',
      placeholder: '例如: default-gpt4o',
      description: '唯一标识，供翻译项目引用。',
      defaultValue: input.translatorName ?? '',
    },
    {
      key: 'type',
      label: '工作流类型',
      type: 'select',
      options: WORKFLOW_OPTIONS,
      defaultValue: workflowType,
    },
    {
      key: 'modelName',
      label: isMultiStage ? 'LLM 配置（默认，各步骤未指定时使用）' : 'LLM 配置',
      type: 'select',
      options: input.llmOptions,
      defaultValue: input.entry?.modelName ?? input.llmOptions[0]?.value ?? '',
    },
    {
      key: 'overlapChars',
      label: '滑窗重叠',
      type: 'select',
      options: [
        { label: '(默认)', value: '' },
        { label: '8', value: '8' },
        { label: '12', value: '12' },
        { label: '16', value: '16' },
        { label: '24', value: '24' },
      ],
      defaultValue: input.entry?.slidingWindow?.overlapChars
        ? String(input.entry.slidingWindow.overlapChars)
        : '',
    },
  ];

  if (!isMultiStage) {
    return baseFields;
  }

  // multi-stage 专用字段
  const multiStageFields: FormFieldDef[] = MULTI_STAGE_STEP_LABELS.map((step) => ({
    key: `model_${step.key}`,
    label: step.label,
    type: 'select' as const,
    options: [
      { label: '(使用默认 LLM)', value: '' },
      ...input.llmOptions,
    ],
    defaultValue: input.entry?.models?.[step.key] ?? '',
    description: step.description,
  }));

  const reviewIterationsField: FormFieldDef = {
    key: 'reviewIterations',
    label: '评审迭代次数',
    type: 'select',
    options: [
      { label: '(默认 2 次)', value: '' },
      { label: '1 次', value: '1' },
      { label: '2 次', value: '2' },
      { label: '3 次', value: '3' },
      { label: '4 次', value: '4' },
    ],
    defaultValue: input.entry?.reviewIterations !== undefined
      ? String(input.entry.reviewIterations)
      : '',
    description: '大步骤二（编辑+校对→修改）的重复次数。',
  };

  return [...baseFields, ...multiStageFields, reviewIterationsField];
}
