import { Form } from '../components/form.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import type { FormFieldDef } from '../types.ts';

const fields: FormFieldDef[] = [
  { key: 'name', label: '工作区名称', type: 'text', placeholder: '输入名称...' },
  { key: 'dir', label: '工作区路径', type: 'text', placeholder: '输入目录路径...' },
  {
    key: 'srcLang',
    label: '源语言',
    type: 'select',
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
    options: [
      { label: '简体中文 (zh-CN)', value: 'zh-CN' },
      { label: '英语 (en)', value: 'en' },
      { label: '繁体中文 (zh-TW)', value: 'zh-TW' },
    ],
    defaultValue: 'zh-CN',
  },
];

export function WorkspaceCreateScreen() {
  const { goBack } = useNavigation();
  const { addLog } = useLog();

  return (
    <Form
      title="新建工作区"
      fields={fields}
      submitLabel="创建"
      onSubmit={values => {
        if (!values.name?.trim()) {
          addLog('warning', '工作区名称不能为空');
          return;
        }
        if (!values.dir?.trim()) {
          addLog('warning', '工作区路径不能为空');
          return;
        }
        // TODO: 调用 TranslationProject 创建工作区
        addLog('warning', `工作区创建功能尚未接入 (${values.name})`);
        goBack();
      }}
      onCancel={goBack}
    />
  );
}
