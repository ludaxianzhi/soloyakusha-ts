import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntdApp, ConfigProvider, theme } from 'antd';
import { BrowserRouter } from 'react-router-dom';
import 'antd/dist/reset.css';
import './styles.css';
import { AppShell } from './app/App.tsx';

function ThemedRoot() {
  const [isDarkMode, setIsDarkMode] = React.useState(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  React.useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => {
      setIsDarkMode(event.matches);
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, []);

  React.useEffect(() => {
    document.documentElement.dataset.colorScheme = isDarkMode ? 'dark' : 'light';
  }, [isDarkMode]);

  return (
    <ConfigProvider
      theme={{
        algorithm: isDarkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: '#6c8cff',
          borderRadius: 8,
          fontFamily: 'Cascadia Mono, Noto Sans CJK SC, sans-serif',
          controlHeight: 34,
          fontSize: 13,
          padding: 12,
          paddingSM: 8,
          paddingLG: 16,
          margin: 12,
          marginSM: 8,
          marginLG: 16,
        },
      }}
    >
      <AntdApp>
        <BrowserRouter>
          <AppShell />
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemedRoot />
  </React.StrictMode>,
);
