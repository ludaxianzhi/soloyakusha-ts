import { useInput } from 'ink';
import { Select } from '../components/select.tsx';
import { useNavigation } from '../context/navigation.tsx';
import type { SelectItem, ScreenName } from '../types.ts';

const menuItems: SelectItem<ScreenName | 'back'>[] = [
  {
    label: '📊 项目进度与控制',
    value: 'workspace-progress',
    description: '查看实时项目状态，并执行开始、暂停、保存和中止等动作。',
    meta: 'live',
  },
  {
    label: '✨ 新建工作区',
    value: 'workspace-create',
    description: '初始化新项目，或打开已有工作区。',
    meta: 'form',
  },
  {
    label: '📥 导入翻译文件',
    value: 'workspace-import',
    description: '检查导入向导风格的字段布局和状态提示。',
    meta: 'import',
  },
  {
    label: '📝 编辑工作区配置',
    value: 'workspace-config',
    description: '体验配置表单在新版 shell 中的视觉层次。',
    meta: 'config',
  },
  {
    label: '🔀 章节排序',
    value: 'workspace-sort',
    description: '体验 grab 状态更明显的排序交互。',
    meta: 'list',
  },
  {
    label: '↩️ 返回',
    value: 'back',
    description: '回到主菜单。',
    meta: 'esc',
  },
];

export function WorkspaceMenuScreen() {
  const { navigate, goBack } = useNavigation();

  useInput((_input, key) => {
    if (key.escape) goBack();
  });

  return (
    <Select
      title="工作区管理"
      description="围绕工作区生命周期组织的流程入口。"
      items={menuItems}
      onSelect={item => {
        if (item.value === 'back') goBack();
        else navigate(item.value);
      }}
    />
  );
}
