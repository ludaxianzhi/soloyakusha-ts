import { NavigationProvider } from './context/navigation.tsx';
import { LogProvider } from './context/log.tsx';
import { Layout } from './components/layout.tsx';
import { Router } from './router.tsx';

export function App() {
  return (
    <NavigationProvider>
      <LogProvider>
        <Layout>
          <Router />
        </Layout>
      </LogProvider>
    </NavigationProvider>
  );
}
