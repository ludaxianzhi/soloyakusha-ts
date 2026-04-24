/**
 * WebUI 入口：启动 Hono HTTP 服务器。
 */

import { createWebUiServer, logWebUiServerStart, resolveWebUiPort } from './server.ts';

const port = await resolveWebUiPort();
const server = createWebUiServer({ port });

logWebUiServerStart(server.port);

export default server;
