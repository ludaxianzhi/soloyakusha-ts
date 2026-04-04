/**
 * WebUI 入口：启动 Hono HTTP 服务器。
 */

import { createWebUiServer, logWebUiServerStart } from './server.ts';

const server = createWebUiServer();

logWebUiServerStart(server.port);

export default server;
