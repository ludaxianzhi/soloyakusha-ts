import { Text } from 'ink';

interface KeycapProps {
  label: string;
  active?: boolean;
}

export function Keycap({ label, active = false }: KeycapProps) {
  return (
    <Text
      color={active ? 'black' : 'white'}
      backgroundColor={active ? 'cyan' : 'gray'}
      bold
    >
      {' '}
      {label}
      {' '}
    </Text>
  );
}
