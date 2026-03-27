import { evaluateSync } from '@mdx-js/mdx';
import { Text } from 'ink';
import { Children, cloneElement, isValidElement } from 'react';
import type { ReactNode } from 'react';
import * as runtime from 'react/jsx-runtime';
import { SafeBox } from './safe-box.tsx';

const mdxCache = new Map<string, (props: { components?: Record<string, unknown> }) => ReactNode>();

function compactChildren(children: ReactNode) {
  return Children.toArray(children).filter(child => {
    return typeof child !== 'string' || child.trim().length > 0;
  });
}

function MdxFragment({ children }: { children?: ReactNode }) {
  return compactChildren(children);
}

function normalizeMdxSource(source: string) {
  return source.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => {
    return String.fromCharCode(Number.parseInt(hex, 16));
  });
}

function sanitizeInkTree(node: ReactNode, insideText = false): ReactNode {
  if (typeof node === 'string') {
    return insideText || node.trim().length > 0 ? node : null;
  }

  if (Array.isArray(node)) {
    return node
      .map(child => sanitizeInkTree(child, insideText))
      .filter(child => child !== null && child !== undefined);
  }

  if (!isValidElement<{ children?: ReactNode }>(node)) {
    return node;
  }

  const isTextElement = node.type === Text;
  const children = sanitizeInkTree(node.props.children, insideText || isTextElement);
  return cloneElement(node, undefined, children);
}

function getComponent(source: string) {
  const normalizedSource = normalizeMdxSource(source);
  const cached = mdxCache.get(normalizedSource);
  if (cached) {
    return cached;
  }

  const module = evaluateSync(normalizedSource, {
    ...runtime,
    Fragment: MdxFragment,
    development: false,
  }) as {
    default: (props: { components?: Record<string, unknown> }) => ReactNode;
  };

  mdxCache.set(normalizedSource, module.default);
  return module.default;
}

const components = {
  wrapper: ({ children }: { children?: ReactNode }) => (
    <SafeBox flexDirection="column">{compactChildren(children)}</SafeBox>
  ),
  h1: ({ children }: { children?: ReactNode }) => (
    <SafeBox marginBottom={1}>
      <Text bold color="cyan">
        {compactChildren(children)}
      </Text>
    </SafeBox>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <SafeBox marginBottom={1}>
      <Text bold color="magenta">
        {compactChildren(children)}
      </Text>
    </SafeBox>
  ),
  p: ({ children }: { children?: ReactNode }) => (
    <SafeBox marginBottom={1}>
      <Text wrap="wrap">{compactChildren(children)}</Text>
    </SafeBox>
  ),
  strong: ({ children }: { children?: ReactNode }) => <Text bold>{compactChildren(children)}</Text>,
  em: ({ children }: { children?: ReactNode }) => <Text italic>{compactChildren(children)}</Text>,
  code: ({ children }: { children?: ReactNode }) => (
    <Text backgroundColor="gray" color="white">
      {' '}
      {compactChildren(children)}
      {' '}
    </Text>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <SafeBox flexDirection="column">{compactChildren(children)}</SafeBox>
  ),
  li: ({ children }: { children?: ReactNode }) => (
    <SafeBox marginBottom={1}>
      <Text color="cyan">• </Text>
      <Text wrap="wrap">{compactChildren(children)}</Text>
    </SafeBox>
  ),
  blockquote: ({ children }: { children?: ReactNode }) => (
    <SafeBox borderStyle="round" borderColor="yellow" paddingX={1} marginBottom={1}>
      {compactChildren(children)}
    </SafeBox>
  ),
  hr: () => (
    <SafeBox marginBottom={1}>
      <Text dimColor>{'─'.repeat(24)}</Text>
    </SafeBox>
  ),
};

interface MdxContentProps {
  source: string;
}

export function MdxContent({ source }: MdxContentProps) {
  const Content = getComponent(source);
  return sanitizeInkTree(Content({ components }));
}
