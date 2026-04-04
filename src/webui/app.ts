/**
 * Hono 应用配置：注册中间件与路由。
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { join } from 'node:path';
import { EventBus } from './services/event-bus.ts';
import { WorkspaceManager } from './services/workspace-manager.ts';
import { ProjectService } from './services/project-service.ts';
import { ConfigService } from './services/config-service.ts';
import { createWorkspaceRoutes } from './routes/workspace.ts';
import { createProjectRoutes } from './routes/project.ts';
import { createConfigRoutes } from './routes/config.ts';
import { createEventsRoute } from './routes/events.ts';

export function createApp() {
  const eventBus = new EventBus();
  const workspaceManager = new WorkspaceManager();
  const projectService = new ProjectService(eventBus, workspaceManager);
  const configService = new ConfigService();

  const app = new Hono();

  // 中间件
  app.use('*', cors());

  // API 路由
  app.route('/api/workspaces', createWorkspaceRoutes(projectService, workspaceManager));
  app.route('/api/project', createProjectRoutes(projectService));
  app.route('/api/config', createConfigRoutes(configService));
  app.route('/api/events', createEventsRoute(eventBus));

  const clientDistDir = join(process.cwd(), 'dist', 'webui');
  app.get('*', async (c) => {
    const requestedPath =
      c.req.path === '/' ? 'index.html' : c.req.path.replace(/^\/+/, '');
    const requestedFile = Bun.file(join(clientDistDir, requestedPath));
    if (await requestedFile.exists()) {
      return new Response(requestedFile);
    }

    if (requestedPath.includes('.')) {
      return c.notFound();
    }

    const indexFile = Bun.file(join(clientDistDir, 'index.html'));
    if (await indexFile.exists()) {
      return new Response(indexFile, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
        },
      });
    }

    return c.html(
      '<h1>WebUI client not built</h1><p>Run <code>bun run webui:build</code> first, then start the server with <code>bun run webui</code>.</p>',
      503,
    );
  });

  return { app, eventBus, workspaceManager, projectService, configService };
}
