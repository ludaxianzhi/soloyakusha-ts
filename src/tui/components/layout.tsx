import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useScreenSize } from 'fullscreen-ink';
import { MdxContent } from './mdx-content.tsx';
import { Panel } from './panel.tsx';
import { Keycap } from './keycap.tsx';
import { LogPanel } from './log-panel.tsx';
import { SafeBox } from './safe-box.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useMouse } from '../context/mouse.tsx';
import { screenDescriptors } from '../screen-registry.ts';

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const { canGoBack, currentScreen, screenStack } = useNavigation();
  const { enabled, lastEvent } = useMouse();
  const { width, height } = useScreenSize();
  const descriptor = screenDescriptors[currentScreen];
  const screenTrail = screenStack.map(screen => screenDescriptors[screen].title).join(' / ');
  const sidebarWidth = Math.max(34, Math.min(42, Math.floor(width * 0.32)));
  const contentMinHeight = Math.max(12, height - 12);

  return (
    <SafeBox flexDirection="column" flexGrow={1} paddingX={1} paddingY={1}>
      <Panel
        tone="cyan"
        eyebrow="SOLOYAKUSHA"
        title="翻译工程控制台"
        subtitle="全屏 TUI 骨架 · alternate screen · MDX surface"
      >
        <SafeBox justifyContent="space-between">
          <Text dimColor>{screenTrail}</Text>
          <Text dimColor>
            {width}x{height}
          </Text>
        </SafeBox>
      </Panel>

      <SafeBox flexGrow={1} gap={1} marginTop={1}>
        <SafeBox flexDirection="column" width={sidebarWidth} gap={1}>
          <Panel
            tone={descriptor.tone}
            eyebrow={descriptor.eyebrow}
            title={descriptor.title}
            subtitle={descriptor.subtitle}
            flexGrow={1}
          >
            <MdxContent source={descriptor.mdx} />
          </Panel>

          <Panel title="交互状态" subtitle="键盘优先，鼠标支持为 best-effort。">
            <SafeBox flexDirection="column">
              <Text>
                <Text color={enabled ? 'green' : 'yellow'} bold>
                  {enabled ? '●' : '○'}
                </Text>{' '}
                鼠标 {enabled ? '已启用' : '未启用'}
              </Text>
              <Text dimColor>
                {lastEvent
                  ? `最近事件：${lastEvent.action} @ (${lastEvent.x}, ${lastEvent.y})`
                  : '最近事件：暂无'}
              </Text>
              <Text dimColor>导航栈深度：{screenStack.length}</Text>
            </SafeBox>
          </Panel>
        </SafeBox>

        <SafeBox flexDirection="column" flexGrow={1} gap={1}>
          <Panel
            tone={descriptor.tone}
            eyebrow="WORKSPACE VIEW"
            title="当前页面"
            subtitle="本区域承载当前 screen 的核心交互组件。"
            flexGrow={1}
            minHeight={contentMinHeight}
          >
            {children}
          </Panel>
          <LogPanel />
        </SafeBox>
      </SafeBox>

      <SafeBox justifyContent="space-between" marginTop={1}>
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
          {enabled ? (
            <SafeBox gap={1}>
              <Keycap label="Wheel" active />
              <Text dimColor>辅助滚动</Text>
              <Keycap label="Click" active />
              <Text dimColor>触发焦点操作</Text>
            </SafeBox>
          ) : (
            <Text dimColor>Ctrl+C 退出</Text>
          )}
        </SafeBox>
      </SafeBox>
    </SafeBox>
  );
}
