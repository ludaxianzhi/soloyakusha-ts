import { useState, useEffect } from 'react';
import { Text } from 'ink';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;

type SpinnerProps = {
  label?: string;
  color?: string;
};

export function Spinner({ label, color = 'cyan' }: SpinnerProps) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text>
      <Text color={color}>{SPINNER_FRAMES[frame]}</Text>
      {label ? <Text> {label}</Text> : null}
    </Text>
  );
}
