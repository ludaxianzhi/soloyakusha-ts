import { Text } from 'ink';
import type { ReactNode } from 'react';
import { useScreenSize } from 'fullscreen-ink';
import { Keycap } from './keycap.tsx';
import { LogPanel } from './log-panel.tsx';
import { SafeBox } from './safe-box.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { screenDescriptors } from '../screen-registry.ts';

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const { canGoBack, currentScreen, screenStack } = useNavigation();
  const { width, height } = useScreenSize();
  const descriptor = screenDescriptors[currentScreen];
  const screenTrail = screenStack.map(screen => screenDescriptors[screen].title).join(' / ');

  // Reserve: header=3, footer=1, log=8, gaps=2
  const contentHeight = Math.max(8, height - 14);

  return (
    <SafeBox flexDirection="column" flexGrow={1} paddingX={1}>
      {/* ── Header ── */}
      <SafeBox borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
        <SafeBox justifyContent="space-between">
          <Text>
            <Text color={descriptor.tone} bold>{descriptor.eyebrow}</Text>
            <Text dimColor> · </Text>
            <Text bold>{descriptor.title}</Text>
          </Text>
          <Text dimColor>
            {width}x{height}
          </Text>
        </SafeBox>
        <Text dimColor>{screenTrail}</Text>
      </SafeBox>

      {/* ── Main content (fixed height, scrollable inside) ── */}
      <SafeBox flexDirection="column" height={contentHeight} overflow="hidden" marginTop={1}>
        {children}
      </SafeBox>

      {/* ── Log panel ── */}
      <LogPanel />

      {/* ── Footer ── */}
      <SafeBox justifyContent="space-between">
        <SafeBox gap={1}>
          <Keycap label="↑↓" />
          <Text dimColor>切换</Text>
          <Keycap label="Enter" />
          <Text dimColor>确认</Text>
          {canGoBack ? (
            <SafeBox gap={1}>
              <Keycap label="Esc" />
              <Text dimColor>返回</Text>
            </SafeBox>
          ) : null}
        </SafeBox>

        <SafeBox gap={1}>
          <Text dimColor>Ctrl+C 退出</Text>
        </SafeBox>
      </SafeBox>
    </SafeBox>
  );
}
