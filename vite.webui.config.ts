import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { isAbsolute, resolve } from 'node:path';

const projectRoot = process.cwd();
const configuredOutDir = process.env.WEBUI_CLIENT_OUTDIR;
const clientOutDir = !configuredOutDir
  ? resolve(projectRoot, 'dist', 'webui')
  : isAbsolute(configuredOutDir)
    ? configuredOutDir
    : resolve(projectRoot, configuredOutDir);

const manualChunks = (id: string): string | undefined => {
  if (!id.includes('node_modules')) {
    return;
  }

  if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
    return 'react';
  }

  if (id.includes('react-router-dom') || id.includes('react-router')) {
    return 'router';
  }

  if (id.includes('antd') || id.includes('@ant-design/icons')) {
    return 'antd';
  }

  if (id.includes('@dnd-kit')) {
    return 'dnd-kit';
  }

  if (id.includes('@monaco-editor/react') || id.includes('monaco-editor')) {
    return 'editor-monaco';
  }

  if (id.includes('@uiw/react-codemirror') || id.includes('@codemirror/')) {
    return 'editor-codemirror';
  }

  if (id.includes('@xyflow/react')) {
    return 'xyflow';
  }

  return 'vendor';
};

export default defineConfig({
  root: resolve(projectRoot, 'src', 'webui', 'client'),
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: clientOutDir,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
});
