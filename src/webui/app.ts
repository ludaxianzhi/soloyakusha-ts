/**
 * Hono 应用配置：注册中间件与路由。
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { join } from 'node:path';
import {
  normalizeStaticAssetPath,
  resolveStaticAssetResponse,
  type StaticAssetMap,
} from './static-assets.ts';
import { EventBus } from './services/event-bus.ts';
import { WorkspaceManager } from './services/workspace-manager.ts';
import { ProjectService } from './services/project-service.ts';
import { ConfigService } from './services/config-service.ts';
import { createWorkspaceRoutes } from './routes/workspace.ts';
import { createProjectRoutes } from './routes/project.ts';
import { createConfigRoutes } from './routes/config.ts';
import { createEventsRoute } from './routes/events.ts';

export interface CreateAppOptions {
  staticAssets?: StaticAssetMap;
  clientDistDir?: string;
}

export function createApp(options: CreateAppOptions = {}) {
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

  const clientDistDir = options.clientDistDir ?? join(process.cwd(), 'dist', 'webui');
  app.get('*', async (c) => {
    const staticAssetResponse = await resolveStaticAssetResponse(
      c.req.path,
      options.staticAssets,
      clientDistDir,
    );
    if (staticAssetResponse) {
      return staticAssetResponse;
    }

    const requestedPath = normalizeStaticAssetPath(c.req.path);
    if (requestedPath.includes('.')) {
      return c.notFound();
    }

    return c.html(
      '<h1>WebUI client not built</h1><p>Run <code>bun run webui</code> to build the frontend and start the server on one port, use <code>bun run webui:dev</code> for the Vite-based development flow, or use <code>bun run webui:build</code> to produce a standalone executable with embedded assets.</p>',
      503,
    );
  });

  return { app, eventBus, workspaceManager, projectService, configService };
}
