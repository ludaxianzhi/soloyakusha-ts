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
  parseOptionalPositiveIntegerField,
  parseChatRequestOptionsFromValues,
  buildTranslatorFields,
  MULTI_STAGE_STEP_LABELS,
  TRANSLATOR_WORKFLOW_OPTIONS,
  toErrorMessage,
} from './settings-translation-shared.ts';
import type { FormFieldDef, SelectItem } from '../types.ts';
import type { TranslatorWorkflowType } from './settings-translation-shared.ts';

type Mode =
  | { kind: 'loading' }
  | { kind: 'menu' }
  | { kind: 'workflow-select'; translatorName?: string }
  | { kind: 'translator-actions'; translatorName: string }
  | { kind: 'edit-translator'; workflow: TranslatorWorkflowType; translatorName?: string };

type TranslatorSummary = {
  name: string;
  entry: TranslatorEntry;
};

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
      if (mode.translatorName) {
        setMode({ kind: 'translator-actions', translatorName: mode.translatorName });
        return;
      }
      setMode({ kind: 'workflow-select' });
      return;
    }

    if (mode.kind === 'workflow-select') {
      if (mode.translatorName) {
        setMode({ kind: 'translator-actions', translatorName: mode.translatorName });
        return;
      }
      setMode({ kind: 'menu' });
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
              setMode({ kind: 'workflow-select' });
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
              setMode({
                kind: 'edit-translator',
                translatorName: mode.translatorName,
                workflow: normalizeWorkflowType(translator?.entry.type),
              });
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

  if (mode.kind === 'workflow-select') {
    const translator = mode.translatorName
      ? translators.find((t) => t.name === mode.translatorName)
      : undefined;
    const initialWorkflow = normalizeWorkflowType(translator?.entry.type);

    return (
      <SafeBox flexDirection="column" gap={1}>
        <SafeBox flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
          <Text bold color="magenta">
            {mode.translatorName ? `编辑翻译器 · ${mode.translatorName}` : '新建翻译器'}
          </Text>
          <Text>请选择工作流类型，不同工作流会使用不同配置 Schema。</Text>
        </SafeBox>
        <Select
          title="工作流类型"
          items={TRANSLATOR_WORKFLOW_OPTIONS}
          initialValue={initialWorkflow}
          onSelect={(item) => {
            setMode({
              kind: 'edit-translator',
              translatorName: mode.translatorName,
              workflow: item.value as TranslatorWorkflowType,
            });
          }}
        />
      </SafeBox>
    );
  }

  const isEdit = mode.kind === 'edit-translator' && Boolean(mode.translatorName);
  const originalTranslator = mode.kind === 'edit-translator' && mode.translatorName
    ? translators.find((t) => t.name === mode.translatorName)
    : undefined;

  const fields = buildTranslatorEntryFields({
    translatorName: originalTranslator?.name,
    entry: originalTranslator?.entry,
    llmOptions,
    workflow: mode.workflow,
  });

  return (
    <Form
      key={`${mode.kind}:${mode.translatorName ?? '__new__'}:${mode.workflow}`}
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

        const entryResult = buildTranslatorEntryFromValues(values, mode.workflow);
        if (!entryResult.ok) {
          addLog('warning', entryResult.message);
          return;
        }

        try {
          const manager = new GlobalConfigManager();
          await manager.setTranslator(translatorName, entryResult.entry);

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
        if (mode.translatorName) {
          setMode({ kind: 'translator-actions', translatorName: mode.translatorName });
          return;
        }
        setMode({ kind: 'workflow-select' });
      }}
    />
  );
}

export function buildTranslatorEntryFields(input: {
  translatorName?: string;
  entry?: TranslatorEntry;
  llmOptions: SelectItem[];
  workflow: TranslatorWorkflowType;
}): FormFieldDef[] {
  const processorConfig = {
    workflow: input.workflow,
    modelName: input.entry?.modelName ?? input.llmOptions[0]?.value ?? '',
    slidingWindow: input.entry?.slidingWindow,
    requestOptions: input.entry?.requestOptions,
    models: input.workflow === 'multi-stage' ? input.entry?.models : undefined,
    reviewIterations: input.workflow === 'multi-stage' ? input.entry?.reviewIterations : undefined,
  };

  return [
    {
      key: 'translatorName',
      label: '翻译器名称',
      type: 'text',
      placeholder: '例如: default-gpt4o',
      description: '唯一标识，供翻译项目引用。',
      defaultValue: input.translatorName ?? '',
    },
    ...buildTranslatorFields(processorConfig, input.llmOptions, input.workflow),
  ];
}

export function buildTranslatorEntryFromValues(
  values: Record<string, string>,
  workflowType: TranslatorWorkflowType,
):
  | { ok: true; entry: TranslatorEntry }
  | { ok: false; message: string } {
  if (!values.modelName) {
    return { ok: false, message: '请选择翻译器使用的 LLM 配置' };
  }

  const isMultiStage = workflowType === 'multi-stage';

  const overlapChars = parseOptionalPositiveIntegerField(
    values.overlapChars,
    '滑窗重叠',
  );
  if (!overlapChars.ok) {
    return overlapChars;
  }

  const reviewIterations = isMultiStage
    ? parseOptionalPositiveIntegerField(values.reviewIterations, '评审迭代次数')
    : { ok: true as const, value: undefined };
  if (!reviewIterations.ok) {
    return reviewIterations;
  }

  const requestOptions = parseChatRequestOptionsFromValues(values);
  if (!requestOptions.ok) {
    return requestOptions;
  }

  const models: Record<string, string> = {};
  if (isMultiStage) {
    for (const step of MULTI_STAGE_STEP_LABELS) {
      const val = values[`model_${step.key}`]?.trim();
      if (val && val !== values.modelName) {
        models[step.key] = val;
      }
    }
  }

  return {
    ok: true,
    entry: {
      type: workflowType === 'default' ? undefined : workflowType,
      modelName: values.modelName,
      slidingWindow: overlapChars.value !== undefined
        ? { overlapChars: overlapChars.value }
        : undefined,
      requestOptions: requestOptions.value,
      models: Object.keys(models).length > 0 ? models : undefined,
      reviewIterations: reviewIterations.value,
    },
  };
}

function normalizeWorkflowType(type: string | undefined): TranslatorWorkflowType {
  return type === 'multi-stage' ? 'multi-stage' : 'default';
}
