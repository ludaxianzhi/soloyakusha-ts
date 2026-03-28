import { useMemo, useCallback } from 'react';
import { Box, Text } from 'ink';
import { SortableList } from '../components/sortable-list.tsx';
import type { SortableItem } from '../components/sortable-list.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import { useProject } from '../context/project.tsx';

export function WorkspaceSortScreen() {
  const { goBack } = useNavigation();
  const { addLog } = useLog();
  const { project, getChapterDescriptors, reorderChapters } = useProject();

  const items = useMemo<SortableItem[]>(() => {
    const descriptors = getChapterDescriptors();
    return descriptors.map((ch) => ({
      id: String(ch.id),
      label: `第 ${ch.id} 章: ${ch.filePath}`,
    }));
  }, [getChapterDescriptors]);

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
        <Text color="yellow">⚠ 请先打开或新建一个工作区，再调整章节排序。</Text>
      </Box>
    );
  }

  if (items.length === 0) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="yellow">⚠ 当前工作区没有章节，无法排序。</Text>
      </Box>
    );
  }

  return (
    <SortableList
      title="章节排序"
      items={items}
      onSave={handleSave}
      onCancel={goBack}
    />
  );
}
