import { useCallback, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import { useProject } from '../context/project.tsx';

type ResetOption = {
  key: string;
  label: string;
  description: string;
  conflictsWith?: string;
};

const RESET_OPTIONS: ResetOption[] = [
  {
    key: 'clearAllTranslations',
    label: '清空所有译文',
    description: '将所有章节的译文清空，流水线状态重置为初始状态。',
  },
  {
    key: 'clearGlossary',
    label: '清除术语表',
    description: '删除所有术语条目（包括术语本身和对应译文）。',
    conflictsWith: 'clearGlossaryTranslations',
  },
  {
    key: 'clearGlossaryTranslations',
    label: '清除术语表译文',
    description: '仅清除所有术语的译文字段，保留术语条目。',
    conflictsWith: 'clearGlossary',
  },
  {
    key: 'clearPlotSummaries',
    label: '清除大纲',
    description: '删除所有已生成的情节大纲条目。',
  },
];

export function WorkspaceResetGlobalScreen() {
  const { goBack } = useNavigation();
  const { addLog } = useLog();
  const { project, resetProject, isBusy } = useProject();
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  const toggle = useCallback((key: string) => {
    const option = RESET_OPTIONS.find(o => o.key === key);
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        if (option?.conflictsWith && next.has(option.conflictsWith)) {
          next.delete(option.conflictsWith);
        }
      }
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
      setCursor(c => (c - 1 + RESET_OPTIONS.length) % RESET_OPTIONS.length);
    } else if (key.downArrow) {
      setCursor(c => (c + 1) % RESET_OPTIONS.length);
    } else if (_input === ' ') {
      const option = RESET_OPTIONS[cursor];
      if (option) toggle(option.key);
    } else if (key.return) {
      if (selected.size === 0) {
        addLog('warning', '请至少勾选一个重置项');
        return;
      }
      setConfirming(true);
    }
  });

  const handleConfirm = useCallback(async () => {
    setConfirming(false);
    setIsRunning(true);
    try {
      await resetProject({
        clearAllTranslations: selected.has('clearAllTranslations'),
        clearGlossary: selected.has('clearGlossary'),
        clearGlossaryTranslations: selected.has('clearGlossaryTranslations'),
        clearPlotSummaries: selected.has('clearPlotSummaries'),
      });
      goBack();
    } finally {
      setIsRunning(false);
    }
  }, [goBack, resetProject, selected]);

  if (!project) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="yellow">⚠ 请先打开工作区。</Text>
      </Box>
    );
  }

  const selectedLabels = RESET_OPTIONS.filter(o => selected.has(o.key)).map(o => o.label);

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="yellow">⚠  批量重置项目状态</Text>
      </Box>

      {RESET_OPTIONS.map((option, index) => {
        const isFocused = cursor === index;
        const isChecked = selected.has(option.key);
        const isDisabled = option.conflictsWith ? selected.has(option.conflictsWith) : false;
        return (
          <Box key={option.key} flexDirection="column" marginBottom={0}>
            <Box>
              <Text color={isFocused ? 'white' : undefined} bold={isFocused}>
                {isFocused ? '❯ ' : '  '}
              </Text>
              <Text color={isDisabled ? 'gray' : isChecked ? 'green' : undefined}>
                {isChecked ? '[x] ' : '[ ] '}
              </Text>
              <Text color={isFocused ? 'white' : isDisabled ? 'gray' : undefined} bold={isFocused}>
                {option.label}
              </Text>
            </Box>
            {isFocused && (
              <Box paddingLeft={5}>
                <Text color="gray">{option.description}</Text>
              </Box>
            )}
          </Box>
        );
      })}

      <Box marginTop={1} flexDirection="column">
        {confirming ? (
          <Box flexDirection="column">
            <Text color="red" bold>确认执行以下操作（不可恢复）？</Text>
            <Text color="red">  {selectedLabels.join('、')}</Text>
            <Text color="gray">按 Y 或 Enter 确认，按 N 或 Esc 取消</Text>
          </Box>
        ) : isRunning || isBusy ? (
          <Text color="cyan">正在执行重置操作，请稍候…</Text>
        ) : (
          <Text color="gray">
            ↑↓ 移动　空格 勾选/取消　Enter 执行　Esc 返回
            {selected.size > 0 && (
              <Text color="yellow">　已选：{selectedLabels.join('、')}</Text>
            )}
          </Text>
        )}
      </Box>
    </Box>
  );
}
