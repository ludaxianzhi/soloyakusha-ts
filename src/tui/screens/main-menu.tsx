import { Text } from 'ink';
import { Select } from '../components/select.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useApp } from 'ink';
import type { SelectItem, ScreenName } from '../types.ts';

const menuItems: SelectItem<ScreenName | 'exit'>[] = [
  { label: '📁  工作区管理', value: 'workspace-menu' },
  { label: '⚙️   全局配置', value: 'settings-menu' },
  { label: '🚪  退出', value: 'exit' },
];

export function MainMenuScreen() {
  const { navigate } = useNavigation();
  const { exit } = useApp();

  return (
    <>
      <Text bold>主菜单</Text>
      <Text> </Text>
      <Select
        items={menuItems}
        onSelect={item => {
          if (item.value === 'exit') exit();
          else navigate(item.value);
        }}
      />
    </>
  );
}
