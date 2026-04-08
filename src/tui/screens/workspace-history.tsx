import { join } from 'node:path';
import { useEffect, useMemo, useState } from 'react';
import { useInput } from 'ink';
import { readHistoryEntriesFromLogDir } from '../../llm/history.ts';
import { ScrollableTextBox } from '../components/scrollable-text-box.tsx';
import { useLog } from '../context/log.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useProject } from '../context/project.tsx';

type EventLogFilter = 'all' | 'info' | 'warning' | 'error';

const FILTER_ORDER: EventLogFilter[] = ['all', 'info', 'warning', 'error'];

export function WorkspaceHistoryScreen() {
  const { goBack } = useNavigation();
  const { logs, logCounts, getFilteredLogs } = useLog();
  const { project } = useProject();
  const [llmHistory, setLlmHistory] = useState('');
  const [scrollOffset, setScrollOffset] = useState(999999);
  const [eventLogFilter, setEventLogFilter] = useState<EventLogFilter>('all');

  useInput((_input, key) => {
    if (key.escape) {
      goBack();
      return;
    }
    if (key.leftArrow) {
      setEventLogFilter((current) => getAdjacentFilter(current, -1));
      setScrollOffset(999999);
      return;
    }
    if (key.rightArrow || key.tab) {
      setEventLogFilter((current) => getAdjacentFilter(current, 1));
      setScrollOffset(999999);
    }
  });

  useEffect(() => {
    void (async () => {
      if (!project) {
        setLlmHistory('');
        return;
      }

      const projectDir = project.getWorkspaceFileManifest().projectDir;
        try {
          const entries = await readHistoryEntriesFromLogDir(join(projectDir, 'logs'), 20);
          setLlmHistory(
            entries.length === 0
              ? ''
              : entries
                  .flatMap((entry) => [
                    `[${new Date(entry.timestamp).toLocaleString('zh-CN', { hour12: false })}] ${entry.type.toUpperCase()} ${entry.source ?? 'llm'} ${entry.modelName ?? ''}`.trim(),
                    `  Request ID: ${entry.requestId}`,
                    ...(entry.requestConfig?.systemPrompt
                      ? [`  System: ${entry.requestConfig.systemPrompt}`]
                      : []),
                    `  Prompt: ${entry.prompt}`,
                    ...(entry.response ? [`  Response: ${entry.response}`] : []),
                    ...(entry.errorMessage ? [`  Error: ${entry.errorMessage}`] : []),
                    ...(entry.responseBody ? [`  Response Body: ${entry.responseBody}`] : []),
                    '',
                  ])
                  .join('\n'),
          );
        } catch {
          setLlmHistory('');
        }
    })();
  }, [project]);

  const visibleEventLogs = useMemo(() => {
    if (eventLogFilter === 'all') {
      return logs;
    }
    return getFilteredLogs([eventLogFilter]);
  }, [eventLogFilter, getFilteredLogs, logs]);

  const lines = [
    `== 项目事件日志（筛选：${formatFilterLabel(eventLogFilter)}） ==`,
    `INFO ${logCounts.info} · WARNING ${logCounts.warning} · ERROR ${logCounts.error} · SUCCESS ${logCounts.success}`,
    ...(visibleEventLogs.length === 0
      ? ['当前还没有事件日志。']
      : visibleEventLogs.map(
          (entry) =>
            `[${entry.timestamp.toLocaleTimeString('zh-CN', { hour12: false })}] [${entry.level.toUpperCase()}] ${entry.message}`,
        )),
    '',
    '== LLM 请求历史 ==',
    ...(llmHistory
      ? llmHistory.split('\n')
      : ['当前没有可显示的 LLM 请求历史日志。']),
  ];

  return (
    <ScrollableTextBox
      title="历史日志"
      lines={lines}
      visibleRows={24}
      borderColor="blue"
      titleColor="blue"
      footerHint="  ↑↓ 或滚轮滚动 · ←→/Tab 切换 INFO/WARNING/ERROR · Esc 返回"
      scrollOffset={scrollOffset}
      onScrollOffsetChange={setScrollOffset}
    />
  );
}

function getAdjacentFilter(current: EventLogFilter, delta: -1 | 1): EventLogFilter {
  const currentIndex = FILTER_ORDER.indexOf(current);
  const nextIndex = (currentIndex + delta + FILTER_ORDER.length) % FILTER_ORDER.length;
  return FILTER_ORDER[nextIndex] ?? 'all';
}

function formatFilterLabel(filter: EventLogFilter): string {
  switch (filter) {
    case 'info':
      return 'INFO';
    case 'warning':
      return 'WARNING';
    case 'error':
      return 'ERROR';
    default:
      return '全部';
  }
}
