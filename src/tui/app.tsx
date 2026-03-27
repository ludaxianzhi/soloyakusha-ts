import { NavigationProvider } from './context/navigation.tsx';
import { LogProvider } from './context/log.tsx';
import { MouseProvider } from './context/mouse.tsx';
import { Layout } from './components/layout.tsx';
import { Router } from './router.tsx';

export function App() {
  return (
    <NavigationProvider>
      <LogProvider>
        <MouseProvider>
          <Layout>
            <Router />
          </Layout>
        </MouseProvider>
      </LogProvider>
    </NavigationProvider>
  );
}
