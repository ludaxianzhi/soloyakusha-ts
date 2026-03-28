import { Text } from 'ink';
import { useLog } from '../context/log.tsx';
import { SafeBox } from './safe-box.tsx';

const MAX_VISIBLE = 5;

function formatTime(d: Date): string {
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

export function LogPanel() {
  const { logs } = useLog();
  const visible = logs.slice(-MAX_VISIBLE);

  return (
    <SafeBox flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
      <Text dimColor bold>
        日志{logs.length > 0 ? ` (${logs.length})` : ''}
      </Text>
      {visible.length === 0 ? (
        <Text dimColor>暂无日志</Text>
      ) : (
        visible.map(entry => (
          <Text key={entry.id} wrap="truncate-end">
            <Text color={getLevelColor(entry.level)} bold>
              {getLevelLabel(entry.level).padEnd(5)}
            </Text>
            <Text dimColor>{formatTime(entry.timestamp)} </Text>
            <Text>{entry.message}</Text>
          </Text>
        ))
      )}
    </SafeBox>
  );
}

function getLevelColor(
  level: 'error' | 'warning' | 'info' | 'success',
): 'red' | 'yellow' | 'blue' | 'green' {
  switch (level) {
    case 'error':
      return 'red';
    case 'warning':
      return 'yellow';
    case 'success':
      return 'green';
    default:
      return 'blue';
  }
}

function getLevelLabel(level: 'error' | 'warning' | 'info' | 'success'): string {
  switch (level) {
    case 'error':
      return 'ERR';
    case 'warning':
      return 'WARN';
    case 'success':
      return 'OK';
    default:
      return 'INFO';
  }
}
