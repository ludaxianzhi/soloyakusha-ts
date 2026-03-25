import { Box, Text, useInput } from 'ink';

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  isActive?: boolean;
}

export function TextInput({
  value,
  onChange,
  onSubmit,
  placeholder = '',
  isActive = true,
}: TextInputProps) {
  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit?.(value);
        return;
      }
      if (key.backspace || key.delete) {
        onChange(value.slice(0, -1));
        return;
      }
      if (key.escape || key.ctrl || key.meta) return;
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
      if (key.tab) return;
      if (input) {
        onChange(value + input);
      }
    },
    { isActive },
  );

  const showPlaceholder = !value && placeholder;

  return (
    <Box>
      <Text dimColor={!!showPlaceholder}>{value || placeholder}</Text>
      {isActive && <Text color="cyan">█</Text>}
    </Box>
  );
}
