/**
 * 项目操作 REST API：翻译控制、字典、导出、章节管理、重置。
 */

import { readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { Hono } from 'hono';
import JSZip from 'jszip';
import { ProjectServiceUserInputError, type ProjectService } from '../services/project-service.ts';

export function createProjectRoutes(projectService: ProjectService): Hono {
  const app = new Hono();

  // ─── 快照与状态 ─────────────────────────────────

  app.get('/snapshot', (c) => {
    return c.json(projectService.getSnapshot());
  });

  app.get('/status', (c) => {
    return c.json(projectService.getStatus());
  });

  // ─── 翻译控制 ───────────────────────────────────

  app.post('/start', async (c) => {
    await projectService.startTranslation();
    return c.json({ ok: true, snapshot: projectService.getSnapshot() });
  });

  app.post('/pause', async (c) => {
    await projectService.pauseTranslation();
    return c.json({ ok: true, snapshot: projectService.getSnapshot() });
  });

  app.post('/resume', async (c) => {
    await projectService.resumeTranslation();
    return c.json({ ok: true, snapshot: projectService.getSnapshot() });
  });

  app.post('/abort', async (c) => {
    await projectService.abortTranslation();
    return c.json({ ok: true, snapshot: projectService.getSnapshot() });
  });

  // ─── 字典 / 术语表 ──────────────────────────────

  app.get('/dictionary', (c) => {
    return c.json({ terms: projectService.getGlossaryTerms() });
  });

  app.put('/dictionary', async (c) => {
    const body = await c.req.json();
    await projectService.updateDictionaryTerm(body);
    return c.json({ ok: true });
  });

  app.delete('/dictionary', async (c) => {
    const body = await c.req.json<{ term: string }>();
    await projectService.deleteDictionaryTerm(body.term);
    return c.json({ ok: true });
  });

  app.post('/dictionary/scan', async (c) => {
    await projectService.scanDictionary();
    return c.json({ ok: true });
  });

  app.post('/dictionary/import', async (c) => {
    const body = await c.req.json<{ filePath: string }>();
    await projectService.importGlossary(body.filePath);
    return c.json({ ok: true });
  });

  app.post('/dictionary/import-content', async (c) => {
    const body = await c.req.json<{ content: string; format: 'csv' | 'tsv' }>();
    try {
      const result = await projectService.importGlossaryFromContent(
        String(body.content ?? ''),
        body.format === 'tsv' ? 'tsv' : 'csv',
      );
      return c.json(result);
    } catch (error) {
      if (error instanceof ProjectServiceUserInputError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: String(error) }, 500);
    }
  });

  app.post('/dictionary/export', async (c) => {
    const body = await c.req.json<{ outputPath: string }>();
    await projectService.exportGlossary(body.outputPath);
    return c.json({ ok: true });
  });

  // ─── 情节大纲 ───────────────────────────────────

  app.post('/plot-summary', async (c) => {
    await projectService.startPlotSummary();
    return c.json({ ok: true });
  });

  app.post('/task-ui/clear', (c) => {
    return c.req.json<{ task?: 'scan' | 'plot' | 'all' }>().then((body) => {
      projectService.clearTaskProgressUi(body.task ?? 'all');
      return c.json({ ok: true });
    });
  });

  // ─── 导出 ───────────────────────────────────────

  app.post('/export', async (c) => {
    const body = await c.req.json<{ format: string }>();
    const result = await projectService.exportProject(body.format);
    if (!result) {
      return c.json({ error: '当前没有可导出的项目' }, 400);
    }

    const archive = await buildExportArchive(result.exportDir);
    const snapshot = projectService.getSnapshot();
    const projectName = snapshot?.projectName ?? 'soloyakusha';
    const fileName = `${projectName}-${body.format || 'export'}.zip`;

    const archiveBuffer = Uint8Array.from(archive).buffer;
    return new Response(new Blob([archiveBuffer]), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
      },
    });
  });

  // ─── 章节管理 ───────────────────────────────────

  app.get('/chapters', (c) => {
    return c.json({ chapters: projectService.getChapterDescriptors() });
  });

  app.get('/topology', (c) => {
    return c.json({ topology: projectService.getTopology() });
  });

  app.get('/preview/chapters/:id', (c) => {
    const id = Number(c.req.param('id'));
    const preview = projectService.getChapterPreview(id);
    if (!preview) {
      return c.json({ error: '当前没有可预览的工作区章节' }, 404);
    }
    return c.json(preview);
  });

  app.post('/chapters', async (c) => {
    const body = await c.req.json<{
      filePath: string;
      format?: string;
      importTranslation?: boolean;
    }>();
    await projectService.addChapter(body.filePath, {
      format: body.format,
      importTranslation: body.importTranslation,
    });
    return c.json({ ok: true });
  });

  app.post('/chapters/import-archive', async (c) => {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    if (!file) {
      return c.json({ error: '请上传 ZIP / 7Z 压缩包' }, 400);
    }

    const importFormat = normalizeOptionalString(formData.get('importFormat'));
    const importPattern = normalizeOptionalString(formData.get('importPattern'));
    const importTranslation = parseBooleanField(formData.get('importTranslation'), false);

    try {
      const result = await projectService.importChaptersFromArchive({
        archiveBuffer: await file.arrayBuffer(),
        archiveFileName: file.name,
        importFormat,
        importPattern,
        importTranslation,
      });
      return c.json(result);
    } catch (error) {
      if (error instanceof ProjectServiceUserInputError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: String(error) }, 500);
    }
  });

  app.delete('/chapters/:id', async (c) => {
    const id = Number(c.req.param('id'));
    await projectService.removeChapter(id);
    return c.json({ ok: true });
  });

  app.post('/chapters/remove', async (c) => {
    const body = await c.req.json<{ chapterIds: number[]; cascadeBranches?: boolean }>();
    await projectService.removeChapters(body.chapterIds, {
      cascadeBranches: body.cascadeBranches,
    });
    return c.json({ ok: true });
  });

  app.put('/chapters/reorder', async (c) => {
    const body = await c.req.json<{ chapterIds: number[] }>();
    await projectService.reorderChapters(body.chapterIds);
    return c.json({ ok: true });
  });

  app.post('/topology/routes', async (c) => {
    const body = await c.req.json<{
      name: string;
      parentRouteId?: string;
      forkAfterChapterId: number;
      chapterIds?: number[];
    }>();
    await projectService.createStoryBranch(body);
    return c.json({ ok: true });
  });

  app.put('/topology/routes/:id', async (c) => {
    const routeId = c.req.param('id');
    const body = await c.req.json<{ name?: string; forkAfterChapterId?: number }>();
    await projectService.updateStoryRoute(routeId, body);
    return c.json({ ok: true });
  });

  app.put('/topology/routes/:id/reorder', async (c) => {
    const routeId = c.req.param('id');
    const body = await c.req.json<{ chapterIds: number[] }>();
    await projectService.reorderStoryRouteChapters(routeId, body.chapterIds);
    return c.json({ ok: true });
  });

  app.delete('/topology/routes/:id', async (c) => {
    const routeId = c.req.param('id');
    await projectService.removeStoryRoute(routeId);
    return c.json({ ok: true });
  });

  app.post('/topology/move-chapter', async (c) => {
    const body = await c.req.json<{
      chapterId: number;
      targetRouteId: string;
      targetIndex: number;
    }>();
    await projectService.moveChapterToRoute(
      body.chapterId,
      body.targetRouteId,
      body.targetIndex,
    );
    return c.json({ ok: true });
  });

  app.post('/chapters/clear', async (c) => {
    const body = await c.req.json<{ chapterIds: number[] }>();
    await projectService.clearChapterTranslations(body.chapterIds);
    return c.json({ ok: true });
  });

  // ─── 工作区配置 ─────────────────────────────────

  app.get('/config', (c) => {
    return c.json(projectService.getWorkspaceConfig());
  });

  app.put('/config', async (c) => {
    const patch = await c.req.json();
    await projectService.updateWorkspaceConfig(patch);
    return c.json({ ok: true, config: projectService.getWorkspaceConfig() });
  });

  // ─── 重置 ───────────────────────────────────────

  app.post('/reset', async (c) => {
    const body = await c.req.json();
    await projectService.resetProject(body);
    return c.json({ ok: true });
  });

  // ─── 历史 ───────────────────────────────────────

  app.get('/history', async (c) => {
    const history = await projectService.getRequestHistory();
    return c.json({ history });
  });

  return app;
}

async function buildExportArchive(exportDir: string): Promise<Uint8Array> {
  const zip = new JSZip();
  await addDirectoryToZip(zip, exportDir, exportDir);
  return zip.generateAsync({ type: 'uint8array' });
}

async function addDirectoryToZip(
  zip: JSZip,
  baseDir: string,
  currentDir: string,
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await addDirectoryToZip(zip, baseDir, absolutePath);
      continue;
    }

    const relativePath = relative(baseDir, absolutePath).replace(/\\/g, '/');
    zip.file(relativePath || basename(absolutePath), await Bun.file(absolutePath).arrayBuffer());
  }
}

function normalizeOptionalString(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function parseBooleanField(value: FormDataEntryValue | null, fallback: boolean): boolean {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  return fallback;
}
