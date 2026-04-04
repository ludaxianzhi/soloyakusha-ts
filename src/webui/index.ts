/**
 * WebUI 入口：启动 Hono HTTP 服务器。
 */

import { createApp } from './app.ts';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const { app } = createApp();

console.log(`\n  🌐 SoloYakusha WebUI 已启动`);
console.log(`  → http://localhost:${PORT}\n`);

export default {
  port: PORT,
  hostname: HOST,
  fetch: app.fetch,
};
