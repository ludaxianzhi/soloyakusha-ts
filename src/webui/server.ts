import { createApp, type CreateAppOptions } from './app.ts';

export function createWebUiServer(options: CreateAppOptions = {}) {
  const port = Number(process.env.PORT) || 8000;
  const hostname = process.env.HOST || '0.0.0.0';
  const runtime = createApp(options);

  return {
    ...runtime,
    port,
    hostname,
    fetch: runtime.app.fetch,
  };
}

export function logWebUiServerStart(port: number) {
  console.log(`\n  🌐 SoloYakusha WebUI 已启动`);
  console.log(`  → http://localhost:${port}\n`);
}
