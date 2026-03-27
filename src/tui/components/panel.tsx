import { Text } from 'ink';
import type { PropsWithChildren } from 'react';
import { SafeBox } from './safe-box.tsx';

export type PanelTone = 'cyan' | 'magenta' | 'green' | 'yellow' | 'blue';

interface PanelProps extends PropsWithChildren {
  title?: string;
  subtitle?: string;
  eyebrow?: string;
  tone?: PanelTone;
  flexGrow?: number;
  width?: number | string;
  minHeight?: number;
  paddingX?: number;
  paddingY?: number;
}

const toneTextColor: Record<PanelTone, 'cyan' | 'magenta' | 'green' | 'yellow' | 'blue'> = {
  cyan: 'cyan',
  magenta: 'magenta',
  green: 'green',
  yellow: 'yellow',
  blue: 'blue',
};

export function Panel({
  title,
  subtitle,
  eyebrow,
  tone = 'cyan',
  children,
  flexGrow,
  width,
  minHeight,
  paddingX = 1,
  paddingY = 0,
}: PanelProps) {
  const color = toneTextColor[tone];

  return (
    <SafeBox
      borderStyle="round"
      borderColor={color}
      flexDirection="column"
      flexGrow={flexGrow}
      width={width}
      minHeight={minHeight}
      paddingX={paddingX}
      paddingY={paddingY}
    >
      {(eyebrow || title || subtitle) && (
        <SafeBox flexDirection="column" marginBottom={children ? 1 : 0}>
          {eyebrow ? (
            <Text color={color} bold>
              {eyebrow}
            </Text>
          ) : null}
          {title ? <Text bold>{title}</Text> : null}
          {subtitle ? <Text dimColor>{subtitle}</Text> : null}
        </SafeBox>
      )}
      {children}
    </SafeBox>
  );
}
