import { useCallback, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import { useProject } from '../context/project.tsx';

export function WorkspaceResetChaptersScreen() {
  const { goBack } = useNavigation();
  const { addLog } = useLog();
  const { project, getChapterDescriptors, clearChapterTranslations, isBusy } = useProject();
  const descriptors = useMemo(() => getChapterDescriptors(), [getChapterDescriptors]);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  const toggle = useCallback((chapterId: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(chapterId)) next.delete(chapterId);
      else next.add(chapterId);
      return next;
    });
  }, []);

  useInput((_input, key) => {
    if (isRunning) return;

    if (confirming) {
      if (key.return || _input === 'y' || _input === 'Y') {
        void handleConfirm();
      } else if (key.escape || _input === 'n' || _input === 'N') {
        setConfirming(false);
      }
      return;
    }

    if (key.escape) {
      goBack();
      return;
    }
    if (key.upArrow) {
      setCursor(c => (c - 1 + descriptors.length) % descriptors.length);
    } else if (key.downArrow) {
      setCursor(c => (c + 1) % descriptors.length);
    } else if (_input === ' ') {
      const desc = descriptors[cursor];
      if (desc) toggle(desc.id);
    } else if (_input === 'a' || _input === 'A') {
      if (selected.size === descriptors.length) {
        setSelected(new Set());
      } else {
        setSelected(new Set(descriptors.map(d => d.id)));
      }
    } else if (key.return) {
      if (selected.size === 0) {
        addLog('warning', '请至少选择一个章节');
        return;
      }
      setConfirming(true);
    }
  });

  const handleConfirm = useCallback(async () => {
    setConfirming(false);
    setIsRunning(true);
    try {
      await clearChapterTranslations([...selected]);
      goBack();
    } finally {
      setIsRunning(false);
    }
  }, [clearChapterTranslations, goBack, selected]);

  if (!project) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="yellow">⚠ 请先打开工作区。</Text>
      </Box>
    );
  }

  if (descriptors.length === 0) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="gray">当前工作区没有任何章节。</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="yellow">🗑  清除部分译文</Text>
      </Box>

      {descriptors.map((desc, index) => {
        const isFocused = cursor === index;
        const isChecked = selected.has(desc.id);
        const hasTranslation = desc.translatedLineCount > 0;
        return (
          <Box key={desc.id} flexDirection="column" marginBottom={0}>
            <Box>
              <Text color={isFocused ? 'white' : undefined} bold={isFocused}>
                {isFocused ? '❯ ' : '  '}
              </Text>
              <Text color={isChecked ? 'green' : undefined}>
                {isChecked ? '[x] ' : '[ ] '}
              </Text>
              <Text color={isFocused ? 'white' : undefined} bold={isFocused}>
                {`第 ${desc.id} 章`}
              </Text>
              <Text color="gray">{` — ${desc.filePath}`}</Text>
              <Text color={hasTranslation ? 'green' : 'gray'}>
                {`  (${desc.translatedLineCount}/${desc.sourceLineCount} 行已译)`}
              </Text>
            </Box>
          </Box>
        );
      })}

      <Box marginTop={1} flexDirection="column">
        {confirming ? (
          <Box flexDirection="column">
            <Text color="red" bold>{`确认清除以下 ${selected.size} 个章节的译文（不可恢复）？`}</Text>
            <Text color="red">{`  章节 ID：${[...selected].sort((a, b) => a - b).join('、')}`}</Text>
            <Text color="gray">按 Y 或 Enter 确认，按 N 或 Esc 取消</Text>
          </Box>
        ) : isRunning || isBusy ? (
          <Text color="cyan">正在清除译文，请稍候…</Text>
        ) : (
          <Text color="gray">
            {`↑↓ 移动　空格 勾选/取消　A 全选/取消全选　Enter 执行　Esc 返回`}
            {selected.size > 0 && (
              <Text color="yellow">{`　已选 ${selected.size} 个章节`}</Text>
            )}
          </Text>
        )}
      </Box>
    </Box>
  );
}
