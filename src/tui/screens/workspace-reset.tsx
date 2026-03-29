import { useInput } from 'ink';
import { Select } from '../components/select.tsx';
import { useNavigation } from '../context/navigation.tsx';
import type { SelectItem, ScreenName } from '../types.ts';

type MenuItem = SelectItem<ScreenName | 'back'>;

const menuItems: MenuItem[] = [
  {
    label: '🗑 批量重置',
    value: 'workspace-reset-global',
    description: '按类别批量清除：译文、术语表、术语表译文或大纲。',
    meta: 'multi',
  },
  {
    label: '📄 清除部分译文',
    value: 'workspace-reset-chapters',
    description: '选择特定章节，仅清除这些章节的已有译文。',
    meta: 'select',
  },
  {
    label: '← 返回',
    value: 'back',
    description: '不做任何操作，返回上一层。',
    meta: 'esc',
  },
];

export function WorkspaceResetScreen() {
  const { navigate, goBack } = useNavigation();

  useInput((_input, key) => {
    if (key.escape) goBack();
  });

  return (
    <Select
      title="重置项目状态"
      description="⚠ 以下操作均不可恢复，请谨慎操作。"
      items={menuItems}
      onSelect={item => {
        if (item.value === 'back') goBack();
        else navigate(item.value as ScreenName);
      }}
    />
  );
}
