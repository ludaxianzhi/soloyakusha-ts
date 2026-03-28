import { useCallback, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { SortableList } from '../components/sortable-list.tsx';
import type { SortableItem } from '../components/sortable-list.tsx';
import { Select } from '../components/select.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import { useProject } from '../context/project.tsx';
import type { SelectItem } from '../types.ts';

type Mode = 'menu' | 'reorder' | 'remove' | 'confirm-remove';

export function WorkspaceSortScreen() {
  const { goBack } = useNavigation();
  const { addLog } = useLog();
  const { project, getChapterDescriptors, reorderChapters, removeChapter, isBusy } = useProject();
  const [mode, setMode] = useState<Mode>('menu');
  const [pendingRemoveId, setPendingRemoveId] = useState<number | null>(null);

  const descriptors = getChapterDescriptors();
  const items = useMemo<SortableItem[]>(
    () =>
      descriptors.map((ch) => ({
        id: String(ch.id),
        label: `第 ${ch.id} 章: ${ch.filePath}`,
      })),
    [descriptors],
  );

  const handleSave = useCallback(
    async (sorted: SortableItem[]) => {
      const ids = sorted.map((item) => Number(item.id));
      await reorderChapters(ids);
      addLog('success', '章节排序已保存');
      goBack();
    },
    [addLog, goBack, reorderChapters],
  );

  if (!project) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="yellow">⚠ 请先打开或新建一个工作区，再管理章节。</Text>
      </Box>
    );
  }

  if (items.length === 0) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="yellow">⚠ 当前工作区没有章节，无法管理。</Text>
      </Box>
    );
  }

  if (mode === 'reorder') {
    return (
      <SortableList
        title="章节排序"
        items={items}
        onSave={handleSave}
        onCancel={() => setMode('menu')}
      />
    );
  }

  if (mode === 'remove') {
    const removeItems: SelectItem<string>[] = [
      ...descriptors.map((ch) => ({
        label: `🗑️ 第 ${ch.id} 章`,
        value: String(ch.id),
        description: ch.filePath,
        meta: `${ch.fragmentCount}块`,
      })),
      {
        label: '↩️ 返回',
        value: '__back__',
        description: '返回章节管理。',
        meta: 'esc',
      },
    ];

    return (
      <Select
        title="删除章节"
        description="选择要从当前工作区移除的章节。"
        items={removeItems}
        isActive={!isBusy}
        onSelect={(item) => {
          if (item.value === '__back__') {
            setMode('menu');
            return;
          }
          setPendingRemoveId(Number(item.value));
          setMode('confirm-remove');
        }}
      />
    );
  }

  if (mode === 'confirm-remove' && pendingRemoveId != null) {
    const chapter = descriptors.find((item) => item.id === pendingRemoveId);
    const confirmItems: SelectItem<string>[] = [
      {
        label: '确认删除',
        value: '__confirm__',
        description: chapter ? `移除 ${chapter.filePath}` : '移除该章节',
        meta: 'del',
      },
      {
        label: '取消',
        value: '__cancel__',
        description: '返回章节列表。',
        meta: 'esc',
      },
    ];

    return (
      <Select
        title={`确认删除章节 ${pendingRemoveId}`}
        description={
          chapter
            ? `将从工作区移除：${chapter.filePath}`
            : '将从工作区移除所选章节。'
        }
        items={confirmItems}
        isActive={!isBusy}
        onSelect={(item) => {
          if (item.value === '__cancel__') {
            setPendingRemoveId(null);
            setMode('remove');
            return;
          }
          void (async () => {
            try {
              await removeChapter(pendingRemoveId);
              setPendingRemoveId(null);
              setMode('menu');
            } catch {
              setPendingRemoveId(null);
              setMode('menu');
            }
          })();
        }}
      />
    );
  }

  const menuItems: SelectItem<string>[] = [
    {
      label: '🔀 调整章节顺序',
      value: '__reorder__',
      description: '调整当前工作区的章节顺序。',
      meta: 'sort',
    },
    {
      label: '🗑️ 删除章节',
      value: '__remove__',
      description: '从当前工作区移除章节。',
      meta: 'del',
    },
    {
      label: '↩️ 返回',
      value: '__back__',
      description: '回到工作区操作。',
      meta: 'esc',
    },
  ];

  return (
    <Select
      title="章节管理"
      description={`当前共有 ${descriptors.length} 个章节。`}
      items={menuItems}
      isActive={!isBusy}
      onSelect={(item) => {
        if (item.value === '__back__') {
          goBack();
          return;
        }
        if (item.value === '__reorder__') {
          setMode('reorder');
          return;
        }
        setMode('remove');
      }}
    />
  );
}
