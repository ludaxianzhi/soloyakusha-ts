import { createContext, useContext } from 'react';

export const ActiveWorkspaceIdContext = createContext<string | null>(null);

export function useActiveWorkspaceId(): string | null {
  return useContext(ActiveWorkspaceIdContext);
}
