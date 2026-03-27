import { useInput } from 'ink';
import { Select } from '../components/select.tsx';
import { useNavigation } from '../context/navigation.tsx';
import type { SelectItem, ScreenName } from '../types.ts';

const menuItems: SelectItem<ScreenName | 'back'>[] = [
  {
    label: '🤖 LLM 配置',
    value: 'settings-llm',
    description: '检查模型配置表单在新版框架中的输入与反馈体验。',
    meta: 'profile',
  },
  {
    label: '🔧 翻译器配置',
    value: 'settings-translator',
    description: '体验类型选择 + 参数表单的两段式配置流。',
    meta: 'preset',
  },
  {
    label: '↩️ 返回',
    value: 'back',
    description: '回到主菜单。',
    meta: 'esc',
  },
];

export function SettingsMenuScreen() {
  const { navigate, goBack } = useNavigation();

  useInput((_input, key) => {
    if (key.escape) goBack();
  });

  return (
    <Select
      title="全局配置"
      description="围绕 LLM 和翻译器能力组织的新版设置入口。"
      items={menuItems}
      onSelect={item => {
        if (item.value === 'back') goBack();
        else navigate(item.value);
      }}
    />
  );
}
