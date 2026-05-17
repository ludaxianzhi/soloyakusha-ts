import { Hono } from 'hono';
import type { StyleLibraryService } from '../services/style-library-service.ts';

export function createStyleLibraryRoutes(styleLibraryService: StyleLibraryService): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    return c.json(await styleLibraryService.listLibraries());
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

  app.delete('/:name', async (c) => {
    return c.json(await styleLibraryService.deleteLibrary(c.req.param('name')));
  });

  app.post('/:name/reembed', async (c) => {
    const body = await c.req.json<{ embeddingProfileName?: string }>();
    const embeddingProfileName = body.embeddingProfileName?.trim();
    if (!embeddingProfileName) {
      return c.json({ error: 'embeddingProfileName 不能为空' }, 400);
    }
    try {
      const result = await styleLibraryService.reEmbedLibrary(c.req.param('name'), embeddingProfileName);
      return c.json(result);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
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
