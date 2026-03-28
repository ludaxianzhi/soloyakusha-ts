import { Select } from '../components/select.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useApp } from 'ink';
import type { SelectItem, ScreenName } from '../types.ts';

const menuItems: SelectItem<ScreenName | 'exit'>[] = [
  {
    label: '📂 打开最近工作区',
    value: 'workspace-menu',
    description: '查看最近打开的工作区，并进入工作区操作面板。',
    meta: 'recent',
  },
  {
    label: '✨ 新建工作区',
    value: 'workspace-create',
    description: '初始化新项目，配置章节、语言和默认翻译器。',
    meta: 'new',
  },
  {
    label: '🤖 LLM 配置',
    value: 'settings-llm',
    description: '管理聊天模型和嵌入模型的全局配置。',
    meta: 'llm',
  },
  {
    label: '📝 翻译器配置',
    value: 'settings-translator',
    description: '直接配置默认翻译器使用的模型、工作流和滑窗参数。',
    meta: 'translator',
  },
  {
    label: '🧰 翻译辅助配置',
    value: 'settings-translation-auxiliary',
    description: '集中管理术语提取、字典更新和情节总结配置。',
    meta: 'aux',
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
      description="从首页直接进入工作区和各类全局配置。"
      items={menuItems}
      onSelect={item => {
        if (item.value === 'exit') exit();
        else navigate(item.value);
      }}
    />
  );
}
