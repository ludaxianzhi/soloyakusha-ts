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
  },
});
