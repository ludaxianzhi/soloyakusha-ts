import { Box, Text } from 'ink';
import { useLog } from '../context/log.tsx';

const MAX_VISIBLE = 6;

function formatTime(d: Date): string {
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

export function LogPanel() {
  const { logs } = useLog();
  const visible = logs.slice(-MAX_VISIBLE);

  return (
    <Box flexDirection="column">
      <Text dimColor>{'─'.repeat(36)}</Text>
      <Text bold> 📋 日志 {logs.length > 0 ? `(${logs.length})` : ''}</Text>

      {visible.length === 0 ? (
        <Text dimColor>  暂无日志</Text>
      ) : (
        visible.map(entry => (
          <Box key={entry.id}>
            <Text color={entry.level === 'error' ? 'red' : 'yellow'}>
              {entry.level === 'error' ? ' ❌' : ' ⚠️'}{' '}
            </Text>
            <Text dimColor>[{formatTime(entry.timestamp)}] </Text>
            <Text>{entry.message}</Text>
          </Box>
        ))
      )}
    </Box>
  );
}
