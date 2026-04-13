import { Hono } from 'hono';
import type { RequestHistoryService } from '../services/request-history-service.ts';

export function createActivityRoutes(requestHistoryService: RequestHistoryService): Hono {
  const app = new Hono();

  app.get('/history/summary', async (c) => {
    return c.json(await requestHistoryService.getDigest());
  });

  app.get('/history/export', async () => {
    const content = await requestHistoryService.exportPrettyJson();
    const fileName = `request-history-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    return new Response(content, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
      },
    });
  });

  app.delete('/history', async (c) => {
    const deletedCount = await requestHistoryService.clear();
    return c.json({ ok: true, deletedCount });
  });

  app.get('/history/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ error: '无效的历史记录 ID' }, 400);
    }
    const entry = await requestHistoryService.getDetail(id);
    if (!entry) {
      return c.json({ error: '未找到对应的请求历史' }, 404);
    }
    return c.json(entry);
  });

  app.delete('/history/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ error: '无效的历史记录 ID' }, 400);
    }
    const deleted = await requestHistoryService.deleteEntry(id);
    if (!deleted) {
      return c.json({ error: '未找到对应的请求历史' }, 404);
    }
    return c.json({ ok: true });
  });

  app.get('/history', async (c) => {
    return c.json(
      await requestHistoryService.getPage({
        limit: readPositiveIntegerQuery(c.req.query('limit'), 20, 100),
        beforeId: readOptionalPositiveIntegerQuery(c.req.query('beforeId')),
      }),
    );
  });

  return app;
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
