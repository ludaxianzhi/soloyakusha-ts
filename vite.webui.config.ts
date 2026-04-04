import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const projectRoot = process.cwd();

export default defineConfig({
  root: resolve(projectRoot, 'src', 'webui', 'client'),
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: resolve(projectRoot, 'dist', 'webui'),
    emptyOutDir: true,
  },
});
