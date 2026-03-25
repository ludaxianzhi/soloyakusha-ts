import { Text, useInput } from 'ink';
import { Select } from '../components/select.tsx';
import { useNavigation } from '../context/navigation.tsx';
import type { SelectItem, ScreenName } from '../types.ts';

const menuItems: SelectItem<ScreenName | 'back'>[] = [
  { label: '✨  新建工作区', value: 'workspace-create' },
  { label: '📥  导入翻译文件', value: 'workspace-import' },
  { label: '📝  编辑工作区配置', value: 'workspace-config' },
  { label: '🔀  章节排序', value: 'workspace-sort' },
  { label: '↩️   返回', value: 'back' },
];

export function WorkspaceMenuScreen() {
  const { navigate, goBack } = useNavigation();

  useInput((_input, key) => {
    if (key.escape) goBack();
  });

  return (
    <>
      <Text bold>工作区管理</Text>
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
