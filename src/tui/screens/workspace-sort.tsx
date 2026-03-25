import { SortableList } from '../components/sortable-list.tsx';
import type { SortableItem } from '../components/sortable-list.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';

// 示例数据 —— 实际使用时从 TranslationProject 加载
const mockChapters: SortableItem[] = [
  { id: '1', label: '第 1 章: prologue.txt' },
  { id: '2', label: '第 2 章: chapter01.txt' },
  { id: '3', label: '第 3 章: chapter02.txt' },
  { id: '4', label: '第 4 章: chapter03.txt' },
  { id: '5', label: '第 5 章: epilogue.txt' },
];

export function WorkspaceSortScreen() {
  const { goBack } = useNavigation();
  const { addLog } = useLog();

  return (
    <SortableList
      title="章节排序"
      items={mockChapters}
      onSave={sorted => {
        const order = sorted.map(c => c.id).join(', ');
        // TODO: 调用 TranslationProject 更新章节顺序
        addLog('warning', `章节排序保存功能尚未接入 (顺序: ${order})`);
        goBack();
      }}
      onCancel={goBack}
    />
  );
}
