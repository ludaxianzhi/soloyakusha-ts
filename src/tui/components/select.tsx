import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SelectItem } from '../types.ts';

interface SelectProps<T extends string = string> {
  items: SelectItem<T>[];
  onSelect: (item: SelectItem<T>) => void;
  isActive?: boolean;
}

export function Select<T extends string = string>({
  items,
  onSelect,
  isActive = true,
}: SelectProps<T>) {
  const [focusIndex, setFocusIndex] = useState(0);

  useInput(
    (_input, key) => {
      if (key.upArrow) {
        setFocusIndex(prev => (prev - 1 + items.length) % items.length);
      } else if (key.downArrow) {
        setFocusIndex(prev => (prev + 1) % items.length);
      } else if (key.return) {
        const item = items[focusIndex];
        if (item) onSelect(item);
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection="column">
      {items.map((item, index) => (
        <Box key={item.value}>
          <Text color={index === focusIndex ? 'cyan' : undefined} bold={index === focusIndex}>
            {index === focusIndex ? '❯ ' : '  '}
            {item.label}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
