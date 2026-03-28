import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { useEffect, useState } from 'react';
import { Text, useInput } from 'ink';
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
      <SafeBox flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
        <Text bold color="blue">项目事件日志</Text>
        {logs.length === 0 ? (
          <Text dimColor>当前还没有事件日志。</Text>
        ) : (
          logs.slice(-18).map((entry) => (
            <Text key={entry.id} dimColor>
              [{entry.timestamp.toLocaleTimeString('zh-CN', { hour12: false })}] {entry.message}
            </Text>
          ))
        )}
      </SafeBox>

      <SafeBox flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">LLM 请求历史</Text>
        {llmHistory ? (
          llmHistory.split('\n').slice(-24).map((line, index) => (
            <Text key={`${index}:${line}`} dimColor={!line.trim()}>
              {line || ' '}
            </Text>
          ))
        ) : (
          <Text dimColor>当前没有可显示的 LLM 请求历史日志。</Text>
        )}
      </SafeBox>
    </SafeBox>
  );
}
