import { createContext, useContext, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import type { ScreenName } from '../types.ts';

interface NavigationContextValue {
  currentScreen: ScreenName;
  screenStack: ScreenName[];
  navigate: (screen: ScreenName) => void;
  goBack: () => void;
  canGoBack: boolean;
}

const NavigationContext = createContext<NavigationContextValue | null>(null);

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<ScreenName[]>(['main-menu']);

  const navigate = useCallback((screen: ScreenName) => {
    setStack(prev => [...prev, screen]);
  }, []);

  const goBack = useCallback(() => {
    setStack(prev => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }, []);

  const currentScreen = stack[stack.length - 1]!;
  const canGoBack = stack.length > 1;

  return (
    <NavigationContext value={{ currentScreen, screenStack: stack, navigate, goBack, canGoBack }}>
      {children}
    </NavigationContext>
  );
}

export function useNavigation() {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error('useNavigation must be used within NavigationProvider');
  return ctx;
}
