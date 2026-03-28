import { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, useInput } from 'ink';
import { GlobalConfigManager } from '../../config/manager.ts';
import type {
  GlossaryExtractorConfig,
  GlossaryUpdaterConfig,
  PlotSummaryConfig,
  TranslationProcessorConfig,
} from '../../project/config.ts';
import { Form } from '../components/form.tsx';
import { Select } from '../components/select.tsx';
import { SafeBox } from '../components/safe-box.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import type { FormFieldDef, SelectItem } from '../types.ts';

type Mode =
  | { kind: 'loading' }
  | { kind: 'menu' }
  | { kind: 'translator' }
  | { kind: 'glossary-extractor' }
  | { kind: 'glossary-updater' }
  | { kind: 'plot-summary' };

export function SettingsTranslatorScreen() {
  const { goBack } = useNavigation();
  const { addLog } = useLog();
  const [mode, setMode] = useState<Mode>({ kind: 'loading' });
  const [profileNames, setProfileNames] = useState<string[]>([]);
  const [defaultProfileName, setDefaultProfileName] = useState<string>('');
  const [translationProcessorConfig, setTranslationProcessorConfig] =
    useState<TranslationProcessorConfig>();
  const [glossaryExtractorConfig, setGlossaryExtractorConfig] =
    useState<GlossaryExtractorConfig>();
  const [glossaryUpdaterConfig, setGlossaryUpdaterConfig] = useState<GlossaryUpdaterConfig>();
  const [plotSummaryConfig, setPlotSummaryConfig] = useState<PlotSummaryConfig>();

  const reload = useCallback(async () => {
    const manager = new GlobalConfigManager();
    const [names, defaultName, translator, glossaryExtractor, glossaryUpdater, plotSummary] =
      await Promise.all([
        manager.listLlmProfileNames(),
        manager.getDefaultLlmProfileName(),
        manager.getTranslationProcessorConfig(),
        manager.getGlossaryExtractorConfig(),
        manager.getGlossaryUpdaterConfig(),
        manager.getPlotSummaryConfig(),
      ]);

    setProfileNames(names);
    setDefaultProfileName(defaultName ?? '');
    setTranslationProcessorConfig(translator);
    setGlossaryExtractorConfig(glossaryExtractor);
    setGlossaryUpdaterConfig(glossaryUpdater);
    setPlotSummaryConfig(plotSummary);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await reload();
      } catch (error) {
        addLog('error', `读取功能配置失败：${toErrorMessage(error)}`);
      } finally {
        setMode({ kind: 'menu' });
      }
    })();
  }, [addLog, reload]);

  useInput((_input, key) => {
    if (!key.escape) {
      return;
    }

    if (mode.kind === 'menu' || mode.kind === 'loading') {
      goBack();
      return;
    }

    setMode({ kind: 'menu' });
  });

  const llmOptions = useMemo(
    () =>
      profileNames.length > 0
        ? profileNames.map((name) => ({
            label: name === defaultProfileName ? `${name} (默认)` : name,
            value: name,
          }))
        : [{ label: '(暂无可用 LLM 配置)', value: '' }],
    [defaultProfileName, profileNames],
  );

  if (mode.kind === 'loading') {
    return (
      <SafeBox flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
        <Text bold color="magenta">翻译器配置</Text>
        <Text dimColor>正在加载配置...</Text>
      </SafeBox>
    );
  }

  if (mode.kind === 'menu') {
    const items: SelectItem<string>[] = [
      {
        label: '📝 翻译器',
        value: 'translator',
        meta: translationProcessorConfig?.modelName ?? 'unset',
      },
      {
        label: '🔍 术语提取',
        value: 'glossary-extractor',
        meta: glossaryExtractorConfig?.modelName ?? 'unset',
      },
      {
        label: '📚 字典更新',
        value: 'glossary-updater',
        meta: glossaryUpdaterConfig?.modelName ?? 'unset',
      },
      {
        label: '🧠 情节总结',
        value: 'plot-summary',
        meta: plotSummaryConfig?.modelName ?? 'unset',
      },
      {
        label: '↩️ 返回',
        value: '__back__',
        meta: 'esc',
      },
    ];

    return (
      <SafeBox flexDirection="column" gap={1}>
        <SafeBox flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
          <Text bold color="magenta">功能模块配置</Text>
          <Text>可用 LLM 预设：{profileNames.length}</Text>
          {profileNames.length === 0 ? (
            <Text color="yellow">请先在“LLM 配置”中创建至少一个命名配置。</Text>
          ) : null}
        </SafeBox>

        <Select
          title="模块列表"
          items={items}
          onSelect={(item) => {
            if (item.value === '__back__') {
              goBack();
              return;
            }
            if (item.value === 'translator') setMode({ kind: 'translator' });
            else if (item.value === 'glossary-extractor') setMode({ kind: 'glossary-extractor' });
            else if (item.value === 'glossary-updater') setMode({ kind: 'glossary-updater' });
            else if (item.value === 'plot-summary') setMode({ kind: 'plot-summary' });
          }}
        />
      </SafeBox>
    );
  }

  if (mode.kind === 'translator') {
    return (
      <Form
        title="翻译器配置"
        fields={buildTranslatorFields(translationProcessorConfig, llmOptions)}
        submitLabel="保存翻译器配置"
        onSubmit={async (values) => {
          if (!values.modelName) {
            addLog('warning', '请选择翻译器使用的 LLM 配置');
            return;
          }

          try {
            const manager = new GlobalConfigManager();
            await manager.setTranslationProcessorConfig({
              workflow: values.workflow || 'default',
              modelName: values.modelName,
              slidingWindow: values.overlapChars
                ? { overlapChars: parseInteger(values.overlapChars, 0) }
                : undefined,
              requestOptions: translationProcessorConfig?.requestOptions,
            });
            await reload();
            addLog('success', `翻译器配置已更新：${values.modelName}`);
            setMode({ kind: 'menu' });
          } catch (error) {
            addLog('error', `保存翻译器配置失败：${toErrorMessage(error)}`);
          }
        }}
        onCancel={() => setMode({ kind: 'menu' })}
      />
    );
  }

  if (mode.kind === 'glossary-extractor') {
    return (
      <Form
        title="术语提取配置"
        fields={buildGlossaryExtractorFields(glossaryExtractorConfig, llmOptions)}
        submitLabel="保存术语提取配置"
        onSubmit={async (values) => {
          if (!values.modelName) {
            addLog('warning', '请选择术语提取使用的 LLM 配置');
            return;
          }

          try {
            const manager = new GlobalConfigManager();
            await manager.setGlossaryExtractorConfig({
              modelName: values.modelName,
              maxCharsPerBatch: parseOptionalInteger(values.maxCharsPerBatch),
              requestOptions: glossaryExtractorConfig?.requestOptions,
            });
            await reload();
            addLog('success', `术语提取配置已更新：${values.modelName}`);
            setMode({ kind: 'menu' });
          } catch (error) {
            addLog('error', `保存术语提取配置失败：${toErrorMessage(error)}`);
          }
        }}
        onCancel={() => setMode({ kind: 'menu' })}
      />
    );
  }

  if (mode.kind === 'glossary-updater') {
    return (
      <Form
        title="字典更新配置"
        fields={buildGlossaryUpdaterFields(glossaryUpdaterConfig, llmOptions)}
        submitLabel="保存字典更新配置"
        onSubmit={async (values) => {
          if (!values.modelName) {
            addLog('warning', '请选择字典更新使用的 LLM 配置');
            return;
          }

          try {
            const manager = new GlobalConfigManager();
            await manager.setGlossaryUpdaterConfig({
              workflow: values.workflow || 'default',
              modelName: values.modelName,
              requestOptions: glossaryUpdaterConfig?.requestOptions,
            });
            await reload();
            addLog('success', `字典更新配置已更新：${values.modelName}`);
            setMode({ kind: 'menu' });
          } catch (error) {
            addLog('error', `保存字典更新配置失败：${toErrorMessage(error)}`);
          }
        }}
        onCancel={() => setMode({ kind: 'menu' })}
      />
    );
  }

  return (
    <Form
      title="情节总结配置"
      fields={buildPlotSummaryFields(plotSummaryConfig, llmOptions)}
      submitLabel="保存情节总结配置"
      onSubmit={async (values) => {
        if (!values.modelName) {
          addLog('warning', '请选择情节总结使用的 LLM 配置');
          return;
        }

        try {
          const manager = new GlobalConfigManager();
          await manager.setPlotSummaryConfig({
            modelName: values.modelName,
            fragmentsPerBatch: parseOptionalInteger(values.fragmentsPerBatch),
            maxContextSummaries: parseOptionalInteger(values.maxContextSummaries),
            requestOptions: plotSummaryConfig?.requestOptions,
          });
          await reload();
          addLog('success', `情节总结配置已更新：${values.modelName}`);
          setMode({ kind: 'menu' });
        } catch (error) {
          addLog('error', `保存情节总结配置失败：${toErrorMessage(error)}`);
        }
      }}
      onCancel={() => setMode({ kind: 'menu' })}
    />
  );
}

function buildTranslatorFields(
  config: TranslationProcessorConfig | undefined,
  llmOptions: SelectItem[],
): FormFieldDef[] {
  return [
    {
      key: 'modelName',
      label: 'LLM 配置',
      type: 'select',
      options: llmOptions,
      defaultValue: config?.modelName ?? llmOptions[0]?.value ?? '',
    },
    {
      key: 'workflow',
      label: '工作流',
      type: 'select',
      options: [{ label: 'default', value: 'default' }],
      defaultValue: config?.workflow ?? 'default',
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
      defaultValue: config?.slidingWindow?.overlapChars
        ? String(config.slidingWindow.overlapChars)
        : '',
    },
  ];
}

function buildGlossaryExtractorFields(
  config: GlossaryExtractorConfig | undefined,
  llmOptions: SelectItem[],
): FormFieldDef[] {
  return [
    {
      key: 'modelName',
      label: 'LLM 配置',
      type: 'select',
      options: llmOptions,
      defaultValue: config?.modelName ?? llmOptions[0]?.value ?? '',
    },
    {
      key: 'maxCharsPerBatch',
      label: '批次字符数',
      type: 'select',
      options: [
        { label: '(默认)', value: '' },
        { label: '4096', value: '4096' },
        { label: '8192', value: '8192' },
        { label: '16384', value: '16384' },
      ],
      defaultValue: config?.maxCharsPerBatch ? String(config.maxCharsPerBatch) : '',
    },
  ];
}

function buildGlossaryUpdaterFields(
  config: GlossaryUpdaterConfig | undefined,
  llmOptions: SelectItem[],
): FormFieldDef[] {
  return [
    {
      key: 'modelName',
      label: 'LLM 配置',
      type: 'select',
      options: llmOptions,
      defaultValue: config?.modelName ?? llmOptions[0]?.value ?? '',
    },
    {
      key: 'workflow',
      label: '工作流',
      type: 'select',
      options: [{ label: 'default', value: 'default' }],
      defaultValue: config?.workflow ?? 'default',
    },
  ];
}

function buildPlotSummaryFields(
  config: PlotSummaryConfig | undefined,
  llmOptions: SelectItem[],
): FormFieldDef[] {
  return [
    {
      key: 'modelName',
      label: 'LLM 配置',
      type: 'select',
      options: llmOptions,
      defaultValue: config?.modelName ?? llmOptions[0]?.value ?? '',
    },
    {
      key: 'fragmentsPerBatch',
      label: '每批片段数',
      type: 'select',
      options: [
        { label: '(默认)', value: '' },
        { label: '3', value: '3' },
        { label: '5', value: '5' },
        { label: '8', value: '8' },
      ],
      defaultValue: config?.fragmentsPerBatch ? String(config.fragmentsPerBatch) : '',
    },
    {
      key: 'maxContextSummaries',
      label: '上下文总结数',
      type: 'select',
      options: [
        { label: '(默认)', value: '' },
        { label: '10', value: '10' },
        { label: '20', value: '20' },
        { label: '40', value: '40' },
      ],
      defaultValue: config?.maxContextSummaries ? String(config.maxContextSummaries) : '',
    },
  ];
}

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
