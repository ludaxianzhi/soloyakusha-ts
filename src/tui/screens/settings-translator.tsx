import { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, useInput } from 'ink';
import { GlobalConfigManager } from '../../config/manager.ts';
import type { TranslationProcessorConfig } from '../../project/config.ts';
import { Form } from '../components/form.tsx';
import { SafeBox } from '../components/safe-box.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import {
  buildLlmOptions,
  buildTranslatorFields,
  parseInteger,
  toErrorMessage,
} from './settings-translation-shared.ts';

type Mode =
  | { kind: 'loading' }
  | { kind: 'translator' };

export function SettingsTranslatorScreen() {
  const { goBack } = useNavigation();
  const { addLog } = useLog();
  const [mode, setMode] = useState<Mode>({ kind: 'loading' });
  const [profileNames, setProfileNames] = useState<string[]>([]);
  const [defaultProfileName, setDefaultProfileName] = useState<string>('');
  const [translationProcessorConfig, setTranslationProcessorConfig] =
    useState<TranslationProcessorConfig>();

  const reload = useCallback(async () => {
    const manager = new GlobalConfigManager();
    const [names, defaultName, translator] = await Promise.all([
      manager.listLlmProfileNames(),
      manager.getDefaultLlmProfileName(),
      manager.getTranslationProcessorConfig(),
    ]);

    setProfileNames(names);
    setDefaultProfileName(defaultName ?? '');
    setTranslationProcessorConfig(translator);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await reload();
      } catch (error) {
        addLog('error', `读取翻译器配置失败：${toErrorMessage(error)}`);
      } finally {
        setMode({ kind: 'translator' });
      }
    })();
  }, [addLog, reload]);

  useInput((_input, key) => {
    if (key.escape && mode.kind === 'loading') {
      goBack();
    }
  });

  const llmOptions = useMemo(
    () => buildLlmOptions(profileNames, defaultProfileName),
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
        } catch (error) {
          addLog('error', `保存翻译器配置失败：${toErrorMessage(error)}`);
        }
      }}
      onCancel={() => goBack()}
    />
  );
}
