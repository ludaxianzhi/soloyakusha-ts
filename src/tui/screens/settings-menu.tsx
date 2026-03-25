import { Text, useInput } from 'ink';
import { Select } from '../components/select.tsx';
import { useNavigation } from '../context/navigation.tsx';
import type { SelectItem, ScreenName } from '../types.ts';

const menuItems: SelectItem<ScreenName | 'back'>[] = [
  { label: '🤖  LLM 配置', value: 'settings-llm' },
  { label: '🔧  翻译器配置', value: 'settings-translator' },
  { label: '↩️   返回', value: 'back' },
];

export function SettingsMenuScreen() {
  const { navigate, goBack } = useNavigation();

  useInput((_input, key) => {
    if (key.escape) goBack();
  });

  return (
    <>
      <Text bold>全局配置</Text>
      <Text> </Text>
      <Select
        items={menuItems}
        onSelect={item => {
          if (item.value === 'back') goBack();
          else navigate(item.value);
        }}
      />
    </>
  );
}
