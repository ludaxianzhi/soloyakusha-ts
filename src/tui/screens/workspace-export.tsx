import { useState, useCallback } from 'react';
import { Box, Text } from 'ink';
import { Form } from '../components/form.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import { useProject } from '../context/project.tsx';
import type { FormFieldDef } from '../types.ts';

const FORMAT_OPTIONS = [
  { label: 'Nature Dialog', value: 'naturedialog' },
  { label: 'Nature Dialog (KeepName)', value: 'naturedialog_keepname' },
  { label: 'Plain Text', value: 'plain_text' },
  { label: 'M3T', value: 'm3t' },
  { label: 'GalTransl JSON', value: 'galtransl_json' },
];

const fields: FormFieldDef[] = [
  {
    key: 'format',
    label: '导出格式',
    type: 'select',
    description: '选择导出文件使用的格式，需与目标文件类型匹配。',
    options: FORMAT_OPTIONS,
    defaultValue: 'naturedialog',
  },
];

export function WorkspaceExportScreen() {
  const { goBack } = useNavigation();
  const { addLog } = useLog();
  const { project, exportProject, isBusy } = useProject();
  const [isExporting, setIsExporting] = useState(false);

  const handleSubmit = useCallback(
    async (values: Record<string, string>) => {
      if (!project) {
        addLog('warning', '请先打开或创建一个项目');
        return;
      }

      const formatName = values.format ?? 'naturedialog';
      setIsExporting(true);
      try {
        const result = await exportProject(formatName);
        if (result) {
          const routeSummary = result.routes
            .map((r) => `  ${r.routeName}（${r.chapters.length} 章节）`)
            .join('\n');
          addLog('info', `导出路线:\n${routeSummary}`);
          goBack();
        }
      } finally {
        setIsExporting(false);
      }
    },
    [addLog, exportProject, goBack, project],
  );

  if (!project) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="yellow">⚠ 请先打开或创建一个项目，再使用导出功能。</Text>
      </Box>
    );
  }

  return (
    <Form
      title="导出翻译文件"
      fields={fields}
      submitLabel={isExporting || isBusy ? '导出中…' : '导出'}
      onSubmit={handleSubmit}
      onCancel={goBack}
    />
  );
}
