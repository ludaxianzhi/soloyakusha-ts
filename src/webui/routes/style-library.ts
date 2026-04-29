import { Hono } from 'hono';
import type { StyleLibraryService } from '../services/style-library-service.ts';

export function createStyleLibraryRoutes(styleLibraryService: StyleLibraryService): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    return c.json(await styleLibraryService.listLibraries());
  });

  app.get('/vector-stores', async (c) => {
    return c.json({ names: await styleLibraryService.listVectorStoreNames() });
  });

  app.put('/:name', async (c) => {
    const body = await c.req.json();
    const library = await styleLibraryService.saveLibrary(c.req.param('name'), body);
    return c.json({ ok: true, library });
  });

  app.post('/:name/import', async (c) => {
    const formData = await c.req.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) {
      return c.json({ error: '缺少文件字段 file' }, 400);
    }

    const formatName = normalizeOptionalString(formData.get('formatName'));
    const result = await styleLibraryService.importLibrary(c.req.param('name'), {
      fileName: file.name,
      content: new Uint8Array(await file.arrayBuffer()),
      formatName,
    });
    return c.json(result);
  });

  app.post('/:name/query', async (c) => {
    const body = await c.req.json<{ text?: string }>();
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      return c.json({ error: 'text 不能为空' }, 400);
    }

    return c.json(await styleLibraryService.queryLibrary(c.req.param('name'), text));
  });

  app.delete('/external', async (c) => {
    const body = await c.req.json<{
      vectorStoreName?: string;
      collectionName?: string;
      deleteCollection?: boolean;
    }>();
    if (!body.vectorStoreName || !body.collectionName) {
      return c.json({ error: '缺少 vectorStoreName 或 collectionName' }, 400);
    }

    return c.json(await styleLibraryService.deleteExternalCollection({
      vectorStoreName: body.vectorStoreName,
      collectionName: body.collectionName,
      deleteCollection: body.deleteCollection,
    }));
  });

  app.delete('/:name', async (c) => {
    const deleteCollection = parseBooleanQuery(c.req.query('deleteCollection'), true);
    return c.json(await styleLibraryService.deleteLibrary(c.req.param('name'), deleteCollection));
  });

  return app;
}

function normalizeOptionalString(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseBooleanQuery(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return value === '1' || value.toLowerCase() === 'true';
}