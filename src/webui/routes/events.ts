/**
 * SSE 事件推送路由：向前端实时推送项目快照与日志事件。
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { BusEvent, EventBus } from '../services/event-bus.ts';
import type { ProjectService } from '../services/project-service.ts';

export function createEventsRoute(eventBus: EventBus, projectService: ProjectService): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const includeLogs = readBooleanQuery(c.req.query('includeLogs'), false);
    const includeWorkspace = readBooleanQuery(c.req.query('includeWorkspace'), false);
    const workspaceId = readOptionalWorkspaceIdQuery(c.req.query('workspaceId'));
    return streamSSE(c, async (stream) => {
      let eventId = 0;

      const unsubscribe = eventBus.subscribe((event) => {
        if (!shouldIncludeEvent(event, {
          includeLogs,
          includeWorkspaceId: workspaceId,
          activeWorkspaceId: projectService.getActiveWorkspaceId(),
        })) {
          return;
        }
        void stream.writeSSE({
          id: String(++eventId),
          event: event.type,
          data: JSON.stringify(
            includeWorkspace
              ? { workspaceId: event.workspaceId, data: event.data }
              : event.data,
          ),
        });
      });

      // 保持连接直到客户端断开
      try {
        while (true) {
          await stream.sleep(30_000);
          // 心跳
          void stream.writeSSE({
            id: String(++eventId),
            event: 'ping',
            data: '{}',
          });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  /** 获取当前所有日志 */
  app.get('/logs', (c) => {
    return c.json(
      eventBus.getLogPage({
        limit: readPositiveIntegerQuery(c.req.query('limit'), 50, 200),
        beforeId: readOptionalPositiveIntegerQuery(c.req.query('beforeId')),
      }),
    );
  });

  app.get('/logs/summary', (c) => {
    return c.json(eventBus.getLogDigest());
  });

  app.get('/logs/session', (c) => {
    return c.json(eventBus.getLogSession());
  });

  app.get('/logs/export', (c) => {
    const format = readLogExportFormatQuery(c.req.query('format'));
    const exported = eventBus.formatLogExport(format);
    return new Response(exported.content, {
      headers: {
        'Content-Type': exported.contentType,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(exported.fileName)}"`,
      },
    });
  });

  /** 清空日志 */
  app.post('/logs/clear', (c) => {
    eventBus.clearLogs();
    return c.json({ ok: true });
  });

  return app;
}

function shouldIncludeEvent(
  event: BusEvent,
  options: {
    includeLogs: boolean;
    includeWorkspaceId?: string;
    activeWorkspaceId: string | null;
  },
): boolean {
  if (!options.includeLogs && event.type === 'log') {
    return false;
  }

  if (options.includeWorkspaceId) {
    return event.workspaceId === options.includeWorkspaceId;
  }

  if (event.workspaceId === null) {
    return true;
  }

  return event.workspaceId === options.activeWorkspaceId;
}

function readBooleanQuery(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no') {
    return false;
  }
  return fallback;
}

function readPositiveIntegerQuery(
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function readOptionalPositiveIntegerQuery(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function readOptionalWorkspaceIdQuery(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function readLogExportFormatQuery(value: string | undefined): 'json' | 'text' {
  return value?.trim().toLowerCase() === 'json' ? 'json' : 'text';
}
