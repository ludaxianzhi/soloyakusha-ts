import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { useEffect, useState } from 'react';
import { Text, useInput } from 'ink';
import { Panel } from '../components/panel.tsx';
import { SafeBox } from '../components/safe-box.tsx';
import { useLog } from '../context/log.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useProject } from '../context/project.tsx';

export function WorkspaceHistoryScreen() {
  const { goBack } = useNavigation();
  const { logs } = useLog();
  const { project } = useProject();
  const [llmHistory, setLlmHistory] = useState('');

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

  return (
    <SafeBox flexDirection="column" gap={1}>
      <Panel
        title="项目事件日志"
        subtitle="当前 TUI 会话中记录的项目事件。"
        tone="blue"
      >
        {logs.length === 0 ? (
          <Text dimColor>当前还没有事件日志。</Text>
        ) : (
          logs.slice(-18).map((entry) => (
            <Text key={entry.id} dimColor>
              [{entry.timestamp.toLocaleTimeString('zh-CN', { hour12: false })}] {entry.message}
            </Text>
          ))
        )}
      </Panel>

      <Panel
        title="LLM 请求历史"
        subtitle="显示项目目录下最近的 LLM 请求历史尾部（如果存在）。"
        tone="cyan"
      >
        {llmHistory ? (
          llmHistory.split('\n').slice(-24).map((line, index) => (
            <Text key={`${index}:${line}`} dimColor={!line.trim()}>
              {line || ' '}
            </Text>
          ))
        ) : (
          <Text dimColor>当前没有可显示的 LLM 请求历史日志。</Text>
        )}
      </Panel>
    </SafeBox>
  );
}
