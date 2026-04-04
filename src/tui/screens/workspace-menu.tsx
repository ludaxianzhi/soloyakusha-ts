import { useEffect, useState, useCallback } from 'react';
import { useInput } from 'ink';
import { WorkspaceRegistry } from '../../config/workspace-registry.ts';
import type { WorkspaceEntry } from '../../config/types.ts';
import { Select } from '../components/select.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import { useProject } from '../context/project.tsx';
import type { SelectItem } from '../types.ts';

type MenuValue = 'create' | 'back' | `ws:${string}`;

function buildMenuItems(workspaces: WorkspaceEntry[]): SelectItem<MenuValue>[] {
  const items: SelectItem<MenuValue>[] = workspaces.map((ws) => ({
    label: `📂 ${ws.name}`,
    value: `ws:${ws.dir}` as MenuValue,
    description: ws.dir,
    meta: new Date(ws.lastOpenedAt).toLocaleDateString('zh-CN'),
  }));

  items.push({
    label: '✨ 新建工作区',
    value: 'create',
    description: '初始化新项目，配置章节、语言和翻译器。',
    meta: 'new',
  });

  items.push({
    label: '↩️ 返回',
    value: 'back',
    description: '回到主菜单。',
    meta: 'esc',
  });

  return items;
}

export function WorkspaceMenuScreen() {
  const { navigate, goBack } = useNavigation();
  const { addLog } = useLog();
  const { initializeProject } = useProject();
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const registry = new WorkspaceRegistry();
        const list = await registry.listRegisteredWorkspaces({
          pruneMissing: true,
          onMissingWorkspace: (entry) => {
            addLog('warning', `工作区目录已不存在，已自动移除：${entry.dir}`);
          },
        });
        setWorkspaces(list);
      } catch {
        setWorkspaces([]);
      } finally {
        setIsLoading(false);
      }
    })();
  }, [addLog]);

  const handleSelect = useCallback(
    (item: SelectItem<MenuValue>) => {
      if (item.value === 'back') {
        goBack();
        return;
      }
      if (item.value === 'create') {
        navigate('workspace-create');
        return;
      }

      const dir = item.value.slice(3);
      void (async () => {
        addLog('info', `正在打开工作区：${dir}`);
        const opened = await initializeProject({ projectName: '', projectDir: dir, chapterPaths: [] });
        if (opened) {
          try {
            const registry = new WorkspaceRegistry();
            await registry.touchWorkspace({ dir });
          } catch {
            // 注册表更新失败不阻断流程
          }
          navigate('workspace-ops');
        }
      })();
    },
    [addLog, goBack, initializeProject, navigate],
  );

  useInput((_input, key) => {
    if (key.escape) goBack();
  });

  const description = isLoading
    ? '正在加载工作区列表…'
    : workspaces.length > 0
      ? `共有 ${workspaces.length} 个最近工作区，可直接打开，或继续新建工作区。`
      : '暂无最近工作区记录，请先新建一个工作区。';

  return (
    <Select
      title="打开最近工作区"
      description={description}
      items={isLoading ? [] : buildMenuItems(workspaces)}
      onSelect={handleSelect}
    />
  );
}

