import { useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import { Form } from '../components/form.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import { useProject } from '../context/project.tsx';
import type { FormFieldDef } from '../types.ts';

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

  const config = getWorkspaceConfig();

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
      key: 'translatorModel',
      label: '翻译器模型',
      type: 'text',
      placeholder: '输入 LLM profile 名称…',
      description: '覆盖全局默认的翻译器模型名称。',
      defaultValue: config?.translator?.modelName ?? '',
    },
    {
      key: 'translatorWorkflow',
      label: '翻译工作流',
      type: 'text',
      placeholder: 'default',
      description: '翻译处理工作流名称。',
      defaultValue: config?.translator?.workflow ?? 'default',
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
  ], [config]);

  const handleSubmit = useCallback(
    async (values: Record<string, string>) => {
      await updateWorkspaceConfig({
        projectName: values.projectName?.trim() || undefined,
        glossary: values.glossaryPath?.trim()
          ? { path: values.glossaryPath.trim() }
          : { path: undefined },
        translator: {
          modelName: values.translatorModel?.trim() || undefined,
          workflow: values.translatorWorkflow?.trim() || undefined,
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
