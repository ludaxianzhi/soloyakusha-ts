import { Form } from '../components/form.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import type { FormFieldDef } from '../types.ts';

const fields: FormFieldDef[] = [
  {
    key: 'profileName',
    label: '配置名称',
    type: 'text',
    placeholder: '例如: writer, reviewer...',
    description: '用于区分不同用途的模型配置。',
  },
  {
    key: 'provider',
    label: '提供商',
    type: 'select',
    description: '决定 API 协议和默认字段约定。',
    options: [
      { label: 'OpenAI (兼容)', value: 'openai' },
      { label: 'Anthropic', value: 'anthropic' },
    ],
    defaultValue: 'openai',
  },
  {
    key: 'baseUrl',
    label: 'API 地址',
    type: 'text',
    placeholder: 'https://api.openai.com/v1',
    description: '允许未来接入代理地址、自建网关或兼容服务。',
  },
  {
    key: 'apiKey',
    label: 'API 密钥',
    type: 'text',
    placeholder: 'sk-...',
    description: '当前仅做普通文本输入展示，后续可扩展为安全输入组件。',
  },
  {
    key: 'model',
    label: '模型名称',
    type: 'text',
    placeholder: 'gpt-4o, claude-sonnet-4-20250514...',
    description: '将作为未来翻译/校对流程的默认模型标识。',
  },
  {
    key: 'maxQps',
    label: '最大 QPS',
    type: 'select',
    description: '用于后续并发与限流策略的默认值。',
    options: [
      { label: '1', value: '1' },
      { label: '3', value: '3' },
      { label: '5', value: '5' },
      { label: '10', value: '10' },
    ],
    defaultValue: '3',
  },
];

export function SettingsLlmScreen() {
  const { goBack } = useNavigation();
  const { addLog } = useLog();

  return (
    <Form
      title="LLM 配置"
      fields={fields}
      submitLabel="保存"
      onSubmit={values => {
        if (!values.profileName?.trim()) {
          addLog('warning', '配置名称不能为空');
          return;
        }
        // TODO: 调用 GlobalConfigManager.setLlmProfile() 保存
        addLog('warning', `LLM 配置保存功能尚未接入 (${values.profileName}: ${values.provider}/${values.model})`);
        goBack();
      }}
      onCancel={goBack}
    />
  );
}
