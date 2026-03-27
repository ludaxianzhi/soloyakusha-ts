import { Select } from '../components/select.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useApp } from 'ink';
import type { SelectItem, ScreenName } from '../types.ts';

const menuItems: SelectItem<ScreenName | 'exit'>[] = [
  {
    label: '📁 工作区管理',
    value: 'workspace-menu',
    description: '进入工作区创建、导入、配置和章节排序相关的交互骨架。',
    meta: '4 flows',
  },
  {
    label: '⚙️ 全局配置',
    value: 'settings-menu',
    description: '查看 LLM 与翻译器设置页的新版视觉与表单框架。',
    meta: '2 panels',
  },
  {
    label: '🚪 退出',
    value: 'exit',
    description: '关闭 full-screen TUI，并恢复之前的终端内容。',
    meta: 'quit',
  },
];

export function MainMenuScreen() {
  const { navigate } = useNavigation();
  const { exit } = useApp();

  return (
    <Select
      title="主菜单"
      description="新的首页把导航入口包装成更清晰的卡片列表。"
      items={menuItems}
      onSelect={item => {
        if (item.value === 'exit') exit();
        else navigate(item.value);
      }}
    />
  );
}
