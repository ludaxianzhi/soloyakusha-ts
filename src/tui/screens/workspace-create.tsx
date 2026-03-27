import { join } from 'node:path';
import { Form } from '../components/form.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import { useProject } from '../context/project.tsx';
import type { FormFieldDef } from '../types.ts';

const fields: FormFieldDef[] = [
  {
    key: 'name',
    label: '工作区名称',
    type: 'text',
    placeholder: '输入名称...',
    description: '用于在未来的项目列表和状态栏中标识当前工作区。',
  },
  {
    key: 'dir',
    label: '工作区路径',
    type: 'text',
    placeholder: '输入目录路径...',
    description: '项目目录。若其中已存在 Data/workspace-config.json，则会直接作为已有工作区打开。',
  },
  {
    key: 'chapters',
    label: '章节文件路径',
    type: 'text',
    placeholder: 'sources\\chapter-1.txt; sources\\chapter-2.txt',
    description: '新建项目时使用；支持用分号、逗号或换行分隔多个章节文件路径。',
  },
  {
    key: 'glossaryPath',
    label: '术语表路径（可选）',
    type: 'text',
    placeholder: 'glossary.csv',
    description: '如果提供，会在初始化项目时接入术语表持久化路径。',
  },
  {
    key: 'srcLang',
    label: '源语言',
    type: 'select',
    description: '指定原始文本的语言，用于后续翻译管线的默认配置。',
    options: [
      { label: '日语 (ja)', value: 'ja' },
      { label: '英语 (en)', value: 'en' },
      { label: '韩语 (ko)', value: 'ko' },
    ],
    defaultValue: 'ja',
  },
  {
    key: 'tgtLang',
    label: '目标语言',
    type: 'select',
    description: '指定输出文本的目标语言，未来会参与项目默认参数初始化。',
    options: [
      { label: '简体中文 (zh-CN)', value: 'zh-CN' },
      { label: '英语 (en)', value: 'en' },
      { label: '繁体中文 (zh-TW)', value: 'zh-TW' },
    ],
    defaultValue: 'zh-CN',
  },
];

export function WorkspaceCreateScreen() {
  const { goBack, navigate } = useNavigation();
  const { addLog } = useLog();
  const { initializeProject } = useProject();

  return (
    <Form
      title="新建工作区"
      fields={fields}
      submitLabel="创建"
      onSubmit={async values => {
        if (!values.dir?.trim()) {
          addLog('warning', '工作区路径不能为空');
          return;
        }

        const chapterPaths = splitChapterPaths(values.chapters ?? '');
        const opened = await initializeProject({
          projectName: values.name ?? '',
          projectDir: values.dir,
          chapterPaths,
          glossaryPath: values.glossaryPath,
          srcLang: values.srcLang,
          tgtLang: values.tgtLang,
        });

        if (opened) {
          addLog(
            'success',
            `项目控制台已就绪：${values.name?.trim() || join(values.dir, 'Data', 'workspace-config.json')}`,
          );
          navigate('workspace-progress');
        }
      }}
      onCancel={goBack}
    />
  );
}

function splitChapterPaths(value: string): string[] {
  return value
    .split(/[\r\n;,]+/)
    .map(item => item.trim())
    .filter(Boolean);
}
