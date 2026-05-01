/**
 * 项目操作 REST API：翻译控制、字典、导出、章节管理、重置。
 */

import { readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { Hono } from 'hono';
import JSZip from 'jszip';
import {
  ProjectServiceUserInputError,
  type ChapterTranslationAssistantRequest,
  type ProjectService,
} from '../services/project-service.ts';
import type { RequestHistoryService } from '../services/request-history-service.ts';

export function createProjectRoutes(
  projectService: ProjectService,
  requestHistoryService: RequestHistoryService,
): Hono {
  const app = new Hono();

  // ─── 快照与状态 ─────────────────────────────────

  app.get('/snapshot', (c) => {
    if (readIncludeEntriesQuery(c.req.query('includeEntries'))) {
      return c.json(projectService.getSnapshotWithEntries());
    }
    return c.json(projectService.getSnapshot());
  });

  app.get('/status', (c) => {
    if (readIncludeEntriesQuery(c.req.query('includeEntries'))) {
      const status = projectService.getStatus();
      return c.json({
        ...status,
        snapshot: projectService.getSnapshotWithEntries(),
      });
    }
    return c.json(projectService.getStatus());
  });

  app.get('/resources/versions', (c) => {
    return c.json(projectService.getResourceVersions());
  });

  app.get('/queue/:stepId/entries', (c) => {
    const stepId = c.req.param('stepId');
    return c.json({
      stepId,
      entries: projectService.getQueueEntries(stepId),
    });
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

  app.post('/dictionary/scan/abort', async (c) => {
    try {
      await projectService.abortGlossaryScan();
      return c.json({ ok: true, snapshot: projectService.getSnapshot() });
    } catch (error) {
      if (error instanceof ProjectServiceUserInputError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post('/dictionary/scan/resume', async (c) => {
    try {
      await projectService.resumeGlossaryScan();
      return c.json({ ok: true, snapshot: projectService.getSnapshot() });
    } catch (error) {
      if (error instanceof ProjectServiceUserInputError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
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

  app.post('/plot-summary/abort', async (c) => {
    try {
      await projectService.abortPlotSummary();
      return c.json({ ok: true, snapshot: projectService.getSnapshot() });
    } catch (error) {
      if (error instanceof ProjectServiceUserInputError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post('/plot-summary/resume', async (c) => {
    try {
      await projectService.resumePlotSummary();
      return c.json({ ok: true, snapshot: projectService.getSnapshot() });
    } catch (error) {
      if (error instanceof ProjectServiceUserInputError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post('/proofread', async (c) => {
    try {
      const body = await c.req.json<{ chapterIds?: number[]; mode?: 'linear' | 'simultaneous' }>();
      await projectService.startProofread({
        chapterIds: Array.isArray(body.chapterIds) ? body.chapterIds.map((value) => Number(value)) : [],
        mode: body.mode === 'simultaneous' ? 'simultaneous' : 'linear',
      });
      return c.json({ ok: true, snapshot: projectService.getSnapshot() });
    } catch (error) {
      if (error instanceof ProjectServiceUserInputError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post('/proofread/abort', async (c) => {
    try {
      await projectService.abortProofread();
      return c.json({ ok: true, snapshot: projectService.getSnapshot() });
    } catch (error) {
      if (error instanceof ProjectServiceUserInputError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post('/proofread/force-abort', async (c) => {
    try {
      await projectService.forceAbortProofread();
      return c.json({ ok: true, snapshot: projectService.getSnapshot() });
    } catch (error) {
      if (error instanceof ProjectServiceUserInputError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post('/proofread/resume', async (c) => {
    try {
      await projectService.resumeProofread();
      return c.json({ ok: true, snapshot: projectService.getSnapshot() });
    } catch (error) {
      if (error instanceof ProjectServiceUserInputError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post('/proofread/remove', async (c) => {
    try {
      await projectService.removeProofreadTask();
      return c.json({ ok: true, snapshot: projectService.getSnapshot() });
    } catch (error) {
      if (error instanceof ProjectServiceUserInputError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post('/task-ui/clear', (c) => {
    return c.req.json<{ task?: 'scan' | 'plot' | 'proofread' | 'all' }>().then((body) => {
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

  app.get('/editor/chapters/:id', (c) => {
    const id = Number(c.req.param('id'));
    const format = normalizeEditorFormat(c.req.query('format'));
    if (!format) {
      return c.json({ error: 'format 必须是 naturedialog 或 m3t' }, 400);
    }
    const draft = projectService.getChapterTranslationEditorDocument(id, format);
    if (!draft) {
      return c.json({ error: '当前没有可编辑的工作区章节' }, 404);
    }
    return c.json(draft);
  });

  app.post('/editor/validate', async (c) => {
    try {
      const body = await c.req.json<{
        chapterId: number;
        format: string;
        content: string;
      }>();
      const format = normalizeEditorFormat(body.format);
      if (!format) {
        return c.json({ error: 'format 必须是 naturedialog 或 m3t' }, 400);
      }
      return c.json(
        projectService.validateChapterTranslationEditorContent({
          chapterId: Number(body.chapterId),
          format,
          content: String(body.content ?? ''),
        }),
      );
    } catch (error) {
      if (error instanceof ProjectServiceUserInputError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post('/editor/apply', async (c) => {
    try {
      const body = await c.req.json<{
        chapterId: number;
        format: string;
        content: string;
      }>();
      const format = normalizeEditorFormat(body.format);
      if (!format) {
        return c.json({ error: 'format 必须是 naturedialog 或 m3t' }, 400);
      }
      return c.json(
        await projectService.applyChapterTranslationEditorContent({
          chapterId: Number(body.chapterId),
          format,
          content: String(body.content ?? ''),
        }),
      );
    } catch (error) {
      if (error instanceof ProjectServiceUserInputError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post('/editor/assistant', async (c) => {
    try {
      const body = await c.req.json<ChapterTranslationAssistantRequest>();
      return c.json(await projectService.runChapterTranslationAssistant(body));
    } catch (error) {
      if (error instanceof ProjectServiceUserInputError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get('/repetition-patterns', (c) => {
    try {
      const result = projectService.getRepeatedPatterns({
        chapterIds: readOptionalPositiveIntegerListQuery(c.req.query('chapterIds')),
      });
      if (!result) {
        return c.json({ error: '当前没有已初始化的项目' }, 404);
      }
      return c.json(result);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post('/repetition-patterns/scan', async (c) => {
    try {
      const body = await c.req.json<{
        minOccurrences?: number;
        minLength?: number;
        maxResults?: number;
      }>();
      const result = await projectService.scanRepeatedPatterns({
        minOccurrences: readOptionalPositiveIntegerValue(body.minOccurrences),
        minLength: readOptionalPositiveIntegerValue(body.minLength),
        maxResults: readOptionalPositiveIntegerValue(body.maxResults),
      });
      return c.json(result);
    } catch (error) {
      if (error instanceof ProjectServiceUserInputError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post('/repetition-patterns/hydrate', async (c) => {
    try {
      const body = await c.req.json<{
        chapterIds?: number[];
        patternTexts?: string[];
      }>();
      const result = projectService.hydrateRepeatedPatterns({
        chapterIds: readOptionalPositiveIntegerArrayValue(body.chapterIds),
        patternTexts: Array.isArray(body.patternTexts)
          ? body.patternTexts
              .map((value) => String(value).trim())
              .filter(Boolean)
          : undefined,
      });
      if (!result) {
        return c.json({ error: '当前没有已初始化的项目或没有已保存的 Pattern' }, 404);
      }
      return c.json(result);
    } catch (error) {
      if (error instanceof ProjectServiceUserInputError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.put('/repetition-patterns/translation', async (c) => {
    try {
      const body = await c.req.json<{
        chapterId: number;
        fragmentIndex: number;
        lineIndex: number;
        translation: string;
      }>();
      await projectService.updateRepeatedPatternTranslation({
        chapterId: body.chapterId,
        fragmentIndex: body.fragmentIndex,
        lineIndex: body.lineIndex,
        translation: String(body.translation ?? ''),
      });
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof ProjectServiceUserInputError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get('/repetition-patterns/context', (c) => {
    const chapterId = readOptionalPositiveIntegerQuery(c.req.query('chapterId'));
    const unitIndex = readOptionalPositiveIntegerQuery(c.req.query('unitIndex'));
    if (chapterId === undefined || unitIndex === undefined) {
      return c.json({ error: 'chapterId 和 unitIndex 必须为正整数' }, 400);
    }

    const context = projectService.getRepeatedPatternTranslationContext({
      chapterId,
      unitIndex: unitIndex - 1,
    });
    if (!context) {
      return c.json({ error: '未找到对应的一致性分析上下文' }, 404);
    }
    return c.json(context);
  });

  app.post('/repetition-patterns/consistency-fix', async (c) => {
    try {
      const body = await c.req.json<{
        llmProfileName?: string;
        chapterIds?: number[];
      }>();
      const progress = await projectService.startRepetitionPatternConsistencyFix({
        llmProfileName: String(body.llmProfileName ?? ''),
        chapterIds: readOptionalPositiveIntegerArrayValue(body.chapterIds),
      });
      return c.json(progress);
    } catch (error) {
      if (error instanceof ProjectServiceUserInputError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get('/repetition-patterns/consistency-fix/status', (c) => {
    return c.json(projectService.getRepetitionPatternConsistencyFixProgress());
  });

  app.post('/repetition-patterns/consistency-fix/clear', (c) => {
    try {
      projectService.clearRepetitionPatternConsistencyFixProgress();
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof ProjectServiceUserInputError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
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

  app.post('/chapters/export', async (c) => {
    const body = await c.req.json<{ chapterIds: number[]; format: string }>();
    if (!Array.isArray(body.chapterIds) || body.chapterIds.length === 0) {
      return c.json({ error: '请提供至少一个章节 ID' }, 400);
    }
    const format = String(body.format ?? 'plain_text').trim();
    if (!format) {
      return c.json({ error: '请提供导出格式' }, 400);
    }

    const result = await projectService.exportChapters(body.chapterIds, format);
    if (!result) {
      return c.json({ error: '导出失败' }, 400);
    }

    const snapshot = projectService.getSnapshot();
    const projectName = snapshot?.projectName ?? 'soloyakusha';

    if (result.totalChapters === 1 && result.routes[0]?.chapters[0]) {
      const single = result.routes[0].chapters[0];
      const file = Bun.file(single.outputPath);
      const buffer = await file.arrayBuffer();
      const fileName = basename(single.outputPath);
      return new Response(new Blob([buffer]), {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
        },
      });
    }

    const archive = await buildExportArchive(result.exportDir);
    const archiveBuffer = Uint8Array.from(archive).buffer;
    const fileName = `${projectName}-chapters-${format}.zip`;
    return new Response(new Blob([archiveBuffer]), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
      },
    });
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

  app.get('/post-processors', (c) => {
    return c.json({ processors: projectService.getPostProcessorDescriptors() });
  });

  app.post('/chapters/post-process', async (c) => {
    const body = await c.req.json<{ chapterIds: number[]; processorIds: string[] }>();
    try {
      await projectService.runBatchPostProcess(body.chapterIds, body.processorIds);
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof ProjectServiceUserInputError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: String(error) }, 500);
    }
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
    try {
      const patch = await c.req.json();
      await projectService.updateWorkspaceConfig(patch);
      return c.json({ ok: true, config: projectService.getWorkspaceConfig() });
    } catch (error) {
      if (error instanceof ProjectServiceUserInputError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post('/context-network', async (c) => {
    try {
      const body = await c.req.json<{
        vectorStoreType?: 'registered' | 'memory';
        minEdgeStrength?: number;
      }>();
      const vectorStoreType = body.vectorStoreType === 'memory' ? 'memory' : 'registered';
      return c.json(await projectService.buildContextNetwork({
        vectorStoreType,
        minEdgeStrength: body.minEdgeStrength,
      }));
    } catch (error) {
      if (error instanceof ProjectServiceUserInputError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  // ─── 重置 ───────────────────────────────────────

  app.post('/reset', async (c) => {
    const body = await c.req.json();
    await projectService.resetProject(body);
    return c.json({ ok: true });
  });

  // ─── 历史 ───────────────────────────────────────

  app.get('/history/summary', async (c) => {
    return c.json(await requestHistoryService.getDigest());
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

function normalizeEditorFormat(format: string | undefined): 'naturedialog' | 'm3t' | undefined {
  if (format === 'naturedialog' || format === 'm3t') {
    return format;
  }
  return undefined;
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

function readOptionalPositiveIntegerListQuery(value: string | undefined): number[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const parsed = Number.parseInt(part, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new ProjectServiceUserInputError('章节范围参数必须为正整数列表');
      }
      return parsed;
    })
    .filter((chapterId, index, chapterIds) => chapterIds.indexOf(chapterId) === index);
}

function readOptionalPositiveIntegerValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ProjectServiceUserInputError('数值参数必须为正整数');
  }
  return value;
}

function readOptionalPositiveIntegerArrayValue(value: unknown): number[] | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ProjectServiceUserInputError('章节范围参数必须为正整数数组');
  }
  return value
    .map((item) => {
      if (typeof item !== 'number' || !Number.isInteger(item) || item <= 0) {
        throw new ProjectServiceUserInputError('章节范围参数必须为正整数数组');
      }
      return item;
    })
    .filter((chapterId, index, chapterIds) => chapterIds.indexOf(chapterId) === index);
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

function readIncludeEntriesQuery(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}
