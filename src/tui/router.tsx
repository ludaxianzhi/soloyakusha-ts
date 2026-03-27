import { useNavigation } from './context/navigation.tsx';

import { MainMenuScreen } from './screens/main-menu.tsx';
import { WorkspaceMenuScreen } from './screens/workspace-menu.tsx';
import { WorkspaceCreateScreen } from './screens/workspace-create.tsx';
import { WorkspaceProgressScreen } from './screens/workspace-progress.tsx';
import { WorkspaceImportScreen } from './screens/workspace-import.tsx';
import { WorkspaceConfigScreen } from './screens/workspace-config.tsx';
import { WorkspaceSortScreen } from './screens/workspace-sort.tsx';
import { SettingsMenuScreen } from './screens/settings-menu.tsx';
import { SettingsLlmScreen } from './screens/settings-llm.tsx';
import { SettingsTranslatorScreen } from './screens/settings-translator.tsx';

import type { ScreenName } from './types.ts';
import type { JSX } from 'react';

const screenMap: Record<ScreenName, () => JSX.Element> = {
  'main-menu': MainMenuScreen,
  'workspace-menu': WorkspaceMenuScreen,
  'workspace-create': WorkspaceCreateScreen,
  'workspace-progress': WorkspaceProgressScreen,
  'workspace-import': WorkspaceImportScreen,
  'workspace-config': WorkspaceConfigScreen,
  'workspace-sort': WorkspaceSortScreen,
  'settings-menu': SettingsMenuScreen,
  'settings-llm': SettingsLlmScreen,
  'settings-translator': SettingsTranslatorScreen,
};

export function Router() {
  const { currentScreen } = useNavigation();
  const Screen = screenMap[currentScreen];
  return <Screen />;
}
