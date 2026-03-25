import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { LogPanel } from './log-panel.tsx';
import { useNavigation } from '../context/navigation.tsx';

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const { canGoBack } = useNavigation();

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header */}
      <Box gap={1}>
        <Text bold color="cyan">
          🌐 SoloYakusha
        </Text>
        <Text dimColor>翻译工程框架</Text>
      </Box>
      <Text dimColor>{'─'.repeat(36)}</Text>

      {/* Content */}
      <Box flexDirection="column" paddingY={1}>
        {children}
      </Box>

      {/* Log Panel */}
      <LogPanel />

      {/* Status Bar */}
      <Text dimColor>{'─'.repeat(36)}</Text>
      <Text dimColor>
        {canGoBack ? 'ESC 返回 · ' : ''}Ctrl+C 退出
      </Text>
    </Box>
  );
}
