import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { GlobalConfigManager } from '../../config/manager.ts';
import { Form } from '../components/form.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import { useProject } from '../context/project.tsx';
import type { FormFieldDef, SelectItem } from '../types.ts';

const FORMAT_OPTIONS = [
  { label: 'Plain Text', value: 'plain_text' },
  { label: 'Nature Dialog', value: 'naturedialog' },
  { label: 'Nature Dialog (KeepName)', value: 'naturedialog_keepname' },
  { label: 'M3T', value: 'm3t' },
  { label: 'GalTransl JSON', value: 'galtransl_json' },
];

export function WorkspaceConfigScreen() {
  const { goBack } = useNavigation();
  const { addLog } = useLog();
  const { project, getWorkspaceConfig, updateWorkspaceConfig, isBusy } = useProject();
  const [translatorOptions, setTranslatorOptions] = useState<SelectItem[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const manager = new GlobalConfigManager();
        const names = await manager.listTranslatorNames();
        setTranslatorOptions([
          { label: '(使用默认)', value: '' },
          ...names.map((name) => ({ label: name, value: name })),
        ]);
      } catch {
        setTranslatorOptions([{ label: '(暂无可用翻译器)', value: '' }]);
      }
    })();
  }, []);

  // Memoize so that a new object from getWorkspaceConfig() each render doesn't
  // invalidate the fields memo and cause Form to receive unstable props every second.
  const config = useMemo(() => getWorkspaceConfig(), [getWorkspaceConfig]);

  const fields = useMemo<FormFieldDef[]>(() => [
    {
      key: 'projectName',
      label: '项目名称',
      type: 'text',
      placeholder: '输入项目名称…',
      description: '工作区的展示名称。',
      defaultValue: config?.projectName ?? '',
    },
    {
      key: 'glossaryPath',
      label: '术语表路径',
      type: 'text',
      placeholder: '输入术语表文件路径…',
      description: '术语表文件的相对或绝对路径（留空表示不使用）。',
      defaultValue: config?.glossary?.path ?? '',
    },
    {
      key: 'translatorName',
      label: '翻译器',
      type: 'select',
      description: '从全局翻译器目录中选择本项目使用的翻译器（留空则在启动时自动选择）。',
      options: translatorOptions.length > 0
        ? translatorOptions
        : [{ label: '(暂无可用翻译器)', value: '' }],
      defaultValue: config?.translator?.translatorName ?? '',
    },
    {
      key: 'defaultImportFormat',
      label: '默认导入格式',
      type: 'select',
      description: '新章节导入时使用的默认文件格式。',
      options: FORMAT_OPTIONS,
      defaultValue: config?.defaultImportFormat ?? 'plain_text',
    },
    {
      key: 'defaultExportFormat',
      label: '默认导出格式',
      type: 'select',
      description: '导出翻译文件时使用的默认格式。',
      options: FORMAT_OPTIONS,
      defaultValue: config?.defaultExportFormat ?? 'naturedialog',
    },
  ], [config, translatorOptions]);

  const handleSubmit = useCallback(
    async (values: Record<string, string>) => {
      await updateWorkspaceConfig({
        projectName: values.projectName?.trim() || undefined,
        glossary: values.glossaryPath?.trim()
          ? { path: values.glossaryPath.trim() }
          : { path: undefined },
        translator: {
          translatorName: values.translatorName?.trim() || null,
        },
        defaultImportFormat: values.defaultImportFormat || null,
        defaultExportFormat: values.defaultExportFormat || null,
      });
      addLog('success', '工作区配置已保存');
      goBack();
    },
    [addLog, goBack, updateWorkspaceConfig],
  );

  if (!project) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="yellow">⚠ 请先打开或新建一个工作区，再编辑配置。</Text>
      </Box>
    );
  }

  return (
    <Form
      title="编辑工作区配置"
      fields={fields}
      submitLabel={isBusy ? '保存中…' : '保存'}
      onSubmit={handleSubmit}
      onCancel={goBack}
    />
  );
}
