import { Box } from 'ink';
import { Children } from 'react';
import type { ComponentProps, ReactNode } from 'react';

function compactChildren(children: ReactNode) {
  return Children.toArray(children).filter(child => {
    return typeof child !== 'string' || child.trim().length > 0;
  });
}

type SafeBoxProps = ComponentProps<typeof Box>;

export function SafeBox({ children, ...props }: SafeBoxProps) {
  return <Box {...props}>{compactChildren(children)}</Box>;
}
