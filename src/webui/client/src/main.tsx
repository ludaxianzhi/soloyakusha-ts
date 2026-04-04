import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntdApp, ConfigProvider, theme } from 'antd';
import 'antd/dist/reset.css';
import './styles.css';
import { AppShell } from './app/App.tsx';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#6c8cff',
          borderRadius: 10,
        },
      }}
    >
      <AntdApp>
        <AppShell />
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
