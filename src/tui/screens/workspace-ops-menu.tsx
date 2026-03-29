import { useInput } from 'ink';
import { Select } from '../components/select.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useProject } from '../context/project.tsx';
import type { SelectItem, ScreenName } from '../types.ts';

type MenuItem = SelectItem<ScreenName | 'close' | 'remove'>;

const menuItems: MenuItem[] = [
  {
    label: '📊 项目进度与控制',
    value: 'workspace-progress',
    description: '查看实时项目状态，并执行开始、暂停、保存和中止等动作。',
    meta: 'live',
  },
  {
    label: '📥 导入翻译文件',
    value: 'workspace-import',
    description: '向当前工作区导入新的翻译章节文件。',
    meta: 'import',
  },
  {
    label: '📤 导出翻译文件',
    value: 'workspace-export',
    description: '将已翻译章节按分线拓扑结构批量导出到 export/ 目录。',
    meta: 'export',
  },
  {
    label: '📝 编辑工作区配置',
    value: 'workspace-config',
    description: '修改当前工作区的项目名称、术语表、翻译器等配置。',
    meta: 'config',
  },
  {
    label: '🔀 章节排序',
    value: 'workspace-sort',
    description: '调整当前工作区的章节翻译顺序。',
    meta: 'list',
  },
  {
    label: '📖 词典管理',
    value: 'workspace-dictionary',
    description: '查看和编辑项目术语表。',
    meta: 'dict',
  },
  {
    label: '📝 情节摘要',
    value: 'workspace-plot-summary',
    description: '生成章节情节摘要，辅助翻译上下文。',
    meta: 'plot',
  },
  {
    label: '⚠️  重置项目状态',
    value: 'workspace-reset',
    description: '清空译文、清除术语表或大纲等不可恢复操作。',
    meta: 'reset',
  },
  {
    label: '📋 翻译历史',
    value: 'workspace-history',
    description: '查看 LLM 请求历史记录。',
    meta: 'log',
  },
  {
    label: '🚪 关闭工作区',
    value: 'close',
    description: '关闭当前工作区，返回工作区列表。',
    meta: 'esc',
  },
  {
    label: '🗑️ 移除工作区',
    value: 'remove',
    description: '从最近列表中移除当前工作区，并返回工作区列表。',
    meta: 'del',
  },
];

export function WorkspaceOpsMenuScreen() {
  const { navigate, goBack } = useNavigation();
  const { snapshot, closeWorkspace, removeWorkspace } = useProject();

  const title = snapshot ? `${snapshot.projectName} — 工作区操作` : '工作区操作';

  useInput((_input, key) => {
    if (key.escape) goBack();
  });

  return (
    <Select
      title={title}
      description="围绕当前工作区的翻译生命周期操作。"
      items={menuItems}
      onSelect={item => {
        if (item.value === 'close') {
          closeWorkspace();
          goBack();
        }
        else if (item.value === 'remove') {
          void removeWorkspace().then(() => goBack());
        }
        else navigate(item.value);
      }}
    />
  );
}
