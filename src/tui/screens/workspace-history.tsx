import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { useEffect, useState } from 'react';
import { useInput } from 'ink';
import { ScrollableTextBox } from '../components/scrollable-text-box.tsx';
import { useLog } from '../context/log.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useProject } from '../context/project.tsx';

export function WorkspaceHistoryScreen() {
  const { goBack } = useNavigation();
  const { logs } = useLog();
  const { project } = useProject();
  const [llmHistory, setLlmHistory] = useState('');
  const [scrollOffset, setScrollOffset] = useState(999999);

  useInput((_input, key) => {
    if (key.escape) {
      goBack();
    }
  });

  useEffect(() => {
    void (async () => {
      if (!project) {
        setLlmHistory('');
        return;
      }

      const projectDir = project.getWorkspaceFileManifest().projectDir;
      const logPath = join(projectDir, 'logs', 'llm_requests.txt');
      try {
        const content = await readFile(logPath, 'utf8');
        setLlmHistory(content.slice(-4000));
      } catch {
        setLlmHistory('');
      }
    })();
  }, [project]);

  const lines = [
    '== 项目事件日志 ==',
    ...(logs.length === 0
      ? ['当前还没有事件日志。']
      : logs.map(
          (entry) =>
            `[${entry.timestamp.toLocaleTimeString('zh-CN', { hour12: false })}] ${entry.message}`,
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
      footerHint="  ↑↓ 或滚轮滚动 · Esc 返回"
      scrollOffset={scrollOffset}
      onScrollOffsetChange={setScrollOffset}
    />
  );
}
