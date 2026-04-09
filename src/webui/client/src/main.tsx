import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntdApp, ConfigProvider, theme } from 'antd';
import { BrowserRouter } from 'react-router-dom';
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
  </React.StrictMode>,
);
