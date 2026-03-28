import { useEffect, useState, useCallback } from 'react';
import { useInput } from 'ink';
import { GlobalConfigManager } from '../../config/manager.ts';
import type { WorkspaceEntry } from '../../config/types.ts';
import { Select } from '../components/select.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import { useProject } from '../context/project.tsx';
import type { SelectItem } from '../types.ts';

type MenuValue = 'create' | 'back' | `ws:${string}` | `rm:${string}`;

function buildMenuItems(workspaces: WorkspaceEntry[]): SelectItem<MenuValue>[] {
  const items: SelectItem<MenuValue>[] = [];

  for (const ws of workspaces) {
    items.push({
      label: `📂 ${ws.name}`,
      value: `ws:${ws.dir}` as MenuValue,
      description: ws.dir,
      meta: new Date(ws.lastOpenedAt).toLocaleDateString('zh-CN'),
    });
    items.push({
      label: `🗑️ 移除：${ws.name}`,
      value: `rm:${ws.dir}` as MenuValue,
      description: `从最近列表中移除工作区 ${ws.dir}`,
      meta: 'del',
    });
  }

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
        const manager = new GlobalConfigManager();
        const list = await manager.getRecentWorkspaces();
        setWorkspaces(list);
      } catch {
        setWorkspaces([]);
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

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

      if (item.value.startsWith('rm:')) {
        const dir = item.value.slice(3);
        void (async () => {
          addLog('info', `正在移除工作区：${dir}`);
          try {
            const manager = new GlobalConfigManager();
            await manager.removeRecentWorkspace(dir);
            setWorkspaces((prev) => prev.filter((w) => w.dir !== dir));
            addLog('success', `工作区已从最近列表中移除：${dir}`);
          } catch {
            addLog('error', `移除工作区失败：${dir}`);
          }
        })();
        return;
      }

      const dir = item.value.slice(3);
      void (async () => {
        addLog('info', `正在打开工作区：${dir}`);
        const opened = await initializeProject({ projectName: '', projectDir: dir, chapterPaths: [] });
        if (opened) {
          try {
            const manager = new GlobalConfigManager();
            const list = await manager.getRecentWorkspaces();
            const entry = list.find((e) => e.dir === dir);
            if (entry) {
              await manager.addRecentWorkspace({ name: entry.name, dir });
            }
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

