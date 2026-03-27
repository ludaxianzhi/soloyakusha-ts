import { Text } from 'ink';
import { useLog } from '../context/log.tsx';
import { Panel } from './panel.tsx';
import { SafeBox } from './safe-box.tsx';

const MAX_VISIBLE = 6;

function formatTime(d: Date): string {
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

export function LogPanel() {
  const { logs } = useLog();
  const visible = logs.slice(-MAX_VISIBLE);

  return (
    <Panel title={`日志流${logs.length > 0 ? ` (${logs.length})` : ''}`} subtitle="最近的界面反馈会显示在这里。">
      {visible.length === 0 ? (
        <Text dimColor>暂无日志，当前界面仍处于纯框架阶段。</Text>
      ) : (
        visible.map(entry => (
          <SafeBox key={entry.id} marginBottom={1}>
            <Text color={getLevelColor(entry.level)} bold>
              {getLevelLabel(entry.level)}
            </Text>
            <Text dimColor> [{formatTime(entry.timestamp)}] </Text>
            <Text wrap="wrap">{entry.message}</Text>
          </SafeBox>
        ))
      )}
    </Panel>
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
