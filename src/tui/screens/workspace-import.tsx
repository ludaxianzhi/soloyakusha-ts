import { useCallback, useState } from 'react';
import { Box, Text } from 'ink';
import { Form } from '../components/form.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import { useProject } from '../context/project.tsx';
import type { FormFieldDef } from '../types.ts';

const fields: FormFieldDef[] = [
  {
    key: 'filePath',
    label: '文件路径',
    type: 'text',
    placeholder: '输入文件的相对或绝对路径…',
    description: '要导入到当前工作区的翻译源文件路径。',
  },
  {
    key: 'format',
    label: '文件格式',
    type: 'select',
    description: '文件格式决定使用的解析器；留空则使用工作区默认格式。',
    options: [
      { label: 'Plain Text', value: 'plain_text' },
      { label: 'Nature Dialog', value: 'naturedialog' },
      { label: 'Nature Dialog (KeepName)', value: 'naturedialog_keepname' },
      { label: 'M3T', value: 'm3t' },
      { label: 'GalTransl JSON', value: 'galtransl_json' },
    ],
    defaultValue: 'plain_text',
  },
  {
    key: 'importTranslation',
    label: '导入译文',
    type: 'select',
    description: '对照格式（如 Nature Dialog / M3T）中，是否同时导入文件内已有的译文。默认仅导入原文，避免将译文中的占位符误作翻译结果。',
    options: [
      { label: '否（仅导入原文）', value: 'no' },
      { label: '是（同时导入译文）', value: 'yes' },
    ],
    defaultValue: 'no',
  },
];

export function WorkspaceImportScreen() {
  const { goBack } = useNavigation();
  const { addLog } = useLog();
  const { project, getChapterDescriptors, isBusy } = useProject();
  const [isImporting, setIsImporting] = useState(false);

  const handleSubmit = useCallback(
    async (values: Record<string, string>) => {
      if (!project) {
        addLog('warning', '请先打开或新建一个工作区，再导入文件');
        return;
      }

      const filePath = values.filePath?.trim();
      if (!filePath) {
        addLog('warning', '请输入文件路径');
        return;
      }

      const descriptors = getChapterDescriptors();
      const nextId = descriptors.length > 0
        ? Math.max(...descriptors.map((d) => d.id)) + 1
        : 1;

      setIsImporting(true);
      try {
        const result = await project.addChapter(nextId, filePath, {
          format: values.format || undefined,
          importTranslation: values.importTranslation === 'yes',
        });
        addLog(
          'success',
          `已导入章节 ${result.chapterId}：${result.filePath}（${result.fragmentCount} 块，${result.unitCount} 行）`,
        );
        goBack();
      } catch (error) {
        addLog('error', `导入失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setIsImporting(false);
      }
    },
    [addLog, getChapterDescriptors, goBack, project],
  );

  if (!project) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="yellow">⚠ 请先打开或新建一个工作区，再导入文件。</Text>
      </Box>
    );
  }

  return (
    <Form
      title="导入翻译文件"
      fields={fields}
      submitLabel={isImporting || isBusy ? '导入中…' : '导入'}
      onSubmit={handleSubmit}
      onCancel={goBack}
    />
  );
}
