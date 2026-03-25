import { Form } from '../components/form.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import type { FormFieldDef } from '../types.ts';

const fields: FormFieldDef[] = [
  { key: 'filePath', label: '文件路径', type: 'text', placeholder: '输入文件路径或通配符...' },
  {
    key: 'format',
    label: '文件格式',
    type: 'select',
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
    key: 'encoding',
    label: '文件编码',
    type: 'select',
    options: [
      { label: 'UTF-8', value: 'utf-8' },
      { label: 'Shift_JIS', value: 'shift_jis' },
      { label: 'GBK', value: 'gbk' },
    ],
    defaultValue: 'utf-8',
  },
];

export function WorkspaceImportScreen() {
  const { goBack } = useNavigation();
  const { addLog } = useLog();

  return (
    <Form
      title="导入翻译文件"
      fields={fields}
      submitLabel="导入"
      onSubmit={values => {
        if (!values.filePath?.trim()) {
          addLog('warning', '请输入文件路径');
          return;
        }
        // TODO: 调用 TranslationFileHandler 导入文件
        addLog('warning', `文件导入功能尚未接入 (${values.filePath})`);
        goBack();
      }}
      onCancel={goBack}
    />
  );
}
