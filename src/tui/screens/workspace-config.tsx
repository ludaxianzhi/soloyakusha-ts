import { Form } from '../components/form.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import type { FormFieldDef } from '../types.ts';

const fields: FormFieldDef[] = [
  {
    key: 'projectName',
    label: '项目名称',
    type: 'text',
    placeholder: '输入项目名称...',
    description: '工作区的展示名称。',
  },
  {
    key: 'glossaryPath',
    label: '术语表路径',
    type: 'text',
    placeholder: '输入术语表文件路径...',
    description: '未来用于加载术语表资源；当前阶段仅展示表单结构。',
  },
  {
    key: 'contextWindow',
    label: '上下文窗口',
    type: 'select',
    description: '翻译时默认带入的上下文条目数。',
    options: [
      { label: '3 行', value: '3' },
      { label: '5 行', value: '5' },
      { label: '10 行', value: '10' },
    ],
    defaultValue: '5',
  },
  {
    key: 'batchSize',
    label: '批次大小',
    type: 'select',
    description: '用于未来批处理策略的默认分批大小。',
    options: [
      { label: '5', value: '5' },
      { label: '10', value: '10' },
      { label: '20', value: '20' },
      { label: '50', value: '50' },
    ],
    defaultValue: '10',
  },
];

export function WorkspaceConfigScreen() {
  const { goBack } = useNavigation();
  const { addLog } = useLog();

  return (
    <Form
      title="编辑工作区配置"
      fields={fields}
      submitLabel="保存"
      onSubmit={values => {
        // TODO: 保存到 TranslationProject 配置
        addLog('warning', `工作区配置保存功能尚未接入 (${values.projectName})`);
        goBack();
      }}
      onCancel={goBack}
    />
  );
}
