import { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, useInput } from 'ink';
import { GlobalConfigManager } from '../../config/manager.ts';
import type {
  AlignmentRepairConfig,
  GlossaryExtractorConfig,
  GlossaryUpdaterConfig,
  PlotSummaryConfig,
} from '../../project/config.ts';
import { Form } from '../components/form.tsx';
import { Select } from '../components/select.tsx';
import { SafeBox } from '../components/safe-box.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import type { SelectItem } from '../types.ts';
import {
  buildAlignmentRepairFields,
  buildGlossaryExtractorFields,
  buildGlossaryUpdaterFields,
  buildLlmOptions,
  buildPlotSummaryFields,
  parseOptionalPositiveIntegerField,
  parseOptionalUnitIntervalField,
  toErrorMessage,
} from './settings-translation-shared.ts';

type Mode =
  | { kind: 'loading' }
  | { kind: 'menu' }
  | { kind: 'glossary-extractor' }
  | { kind: 'glossary-updater' }
  | { kind: 'plot-summary' }
  | { kind: 'alignment-repair' };

export function SettingsTranslationAuxiliaryScreen() {
  const { goBack } = useNavigation();
  const { addLog } = useLog();
  const [mode, setMode] = useState<Mode>({ kind: 'loading' });
  const [profileNames, setProfileNames] = useState<string[]>([]);
  const [defaultProfileName, setDefaultProfileName] = useState<string>('');
  const [glossaryExtractorConfig, setGlossaryExtractorConfig] =
    useState<GlossaryExtractorConfig>();
  const [glossaryUpdaterConfig, setGlossaryUpdaterConfig] = useState<GlossaryUpdaterConfig>();
  const [plotSummaryConfig, setPlotSummaryConfig] = useState<PlotSummaryConfig>();
  const [alignmentRepairConfig, setAlignmentRepairConfig] = useState<AlignmentRepairConfig>();

  const reload = useCallback(async () => {
    const manager = new GlobalConfigManager();
    const [names, defaultName, glossaryExtractor, glossaryUpdater, plotSummary, alignmentRepair] =
      await Promise.all([
        manager.listLlmProfileNames(),
        manager.getDefaultLlmProfileName(),
        manager.getGlossaryExtractorConfig(),
        manager.getGlossaryUpdaterConfig(),
        manager.getPlotSummaryConfig(),
        manager.getAlignmentRepairConfig(),
      ]);

    setProfileNames(names);
    setDefaultProfileName(defaultName ?? '');
    setGlossaryExtractorConfig(glossaryExtractor);
    setGlossaryUpdaterConfig(glossaryUpdater);
    setPlotSummaryConfig(plotSummary);
    setAlignmentRepairConfig(alignmentRepair);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await reload();
      } catch (error) {
        addLog('error', `读取翻译辅助配置失败：${toErrorMessage(error)}`);
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
    () => buildLlmOptions(profileNames, defaultProfileName),
    [defaultProfileName, profileNames],
  );

  if (mode.kind === 'loading') {
    return (
      <SafeBox flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
        <Text bold color="magenta">翻译辅助配置</Text>
        <Text dimColor>正在加载配置...</Text>
      </SafeBox>
    );
  }

  if (mode.kind === 'menu') {
    const items: SelectItem<string>[] = [
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
        label: '🔧 对齐补翻',
        value: 'alignment-repair',
        meta: alignmentRepairConfig?.modelName ?? 'unset',
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
          <Text bold color="magenta">翻译辅助配置</Text>
          <Text>可用 LLM 预设：{profileNames.length}</Text>
          {profileNames.length === 0 ? (
            <Text color="yellow">请先在"LLM 配置"中创建至少一个命名配置。</Text>
          ) : null}
        </SafeBox>

        <Select
          title="辅助模块列表"
          items={items}
          onSelect={(item) => {
            if (item.value === '__back__') {
              goBack();
              return;
            }
            if (item.value === 'glossary-extractor') setMode({ kind: 'glossary-extractor' });
            else if (item.value === 'glossary-updater') setMode({ kind: 'glossary-updater' });
            else if (item.value === 'plot-summary') setMode({ kind: 'plot-summary' });
            else if (item.value === 'alignment-repair') setMode({ kind: 'alignment-repair' });
          }}
        />
      </SafeBox>
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

          const maxCharsPerBatch = parseOptionalPositiveIntegerField(
            values.maxCharsPerBatch,
            '批次字符数',
          );
          if (!maxCharsPerBatch.ok) {
            addLog('warning', maxCharsPerBatch.message);
            return;
          }

          const occurrenceTopK = parseOptionalPositiveIntegerField(
            values.occurrenceTopK,
            '频次 Top K',
          );
          if (!occurrenceTopK.ok) {
            addLog('warning', occurrenceTopK.message);
            return;
          }

          const occurrenceTopP = parseOptionalUnitIntervalField(
            values.occurrenceTopP,
            '频次 Top P',
          );
          if (!occurrenceTopP.ok) {
            addLog('warning', occurrenceTopP.message);
            return;
          }

          try {
            const manager = new GlobalConfigManager();
            await manager.setGlossaryExtractorConfig({
              modelName: values.modelName,
              maxCharsPerBatch: maxCharsPerBatch.value,
              occurrenceTopK: occurrenceTopK.value,
              occurrenceTopP: occurrenceTopP.value,
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

  if (mode.kind === 'plot-summary') {
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

          const fragmentsPerBatch = parseOptionalPositiveIntegerField(
            values.fragmentsPerBatch,
            '每批片段数',
          );
          if (!fragmentsPerBatch.ok) {
            addLog('warning', fragmentsPerBatch.message);
            return;
          }

          const maxContextSummaries = parseOptionalPositiveIntegerField(
            values.maxContextSummaries,
            '上下文总结数',
          );
          if (!maxContextSummaries.ok) {
            addLog('warning', maxContextSummaries.message);
            return;
          }

          try {
            const manager = new GlobalConfigManager();
            await manager.setPlotSummaryConfig({
              modelName: values.modelName,
              fragmentsPerBatch: fragmentsPerBatch.value,
              maxContextSummaries: maxContextSummaries.value,
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

  return (
    <Form
      title="对齐补翻配置"
      fields={buildAlignmentRepairFields(alignmentRepairConfig, llmOptions)}
      submitLabel="保存对齐补翻配置"
      onSubmit={async (values) => {
        if (!values.modelName) {
          addLog('warning', '请选择对齐补翻使用的 LLM 配置');
          return;
        }

        try {
          const manager = new GlobalConfigManager();
          await manager.setAlignmentRepairConfig({
            modelName: values.modelName,
            requestOptions: alignmentRepairConfig?.requestOptions,
          });
          await reload();
          addLog('success', `对齐补翻配置已更新：${values.modelName}`);
          setMode({ kind: 'menu' });
        } catch (error) {
          addLog('error', `保存对齐补翻配置失败：${toErrorMessage(error)}`);
        }
      }}
      onCancel={() => setMode({ kind: 'menu' })}
    />
  );
}
