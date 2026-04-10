/**
 * 工作区 REST API：列表、创建（ZIP 上传）、打开、删除。
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { TranslationUnit } from '../../project/types.ts';
import { TranslationFileHandlerFactory } from '../../file-handlers/factory.ts';
import { Hono } from 'hono';
import type { ProjectService } from '../services/project-service.ts';
import type { WorkspaceManager } from '../services/workspace-manager.ts';
import type { BranchImportInput } from '../services/project-service.ts';

export function createWorkspaceRoutes(
  projectService: ProjectService,
  workspaceManager: WorkspaceManager,
): Hono {
  const app = new Hono();

  /** 列出已知工作区 */
  app.get('/', async (c) => {
    const workspaces = await workspaceManager.listWorkspaces();
    return c.json({ workspaces });
  });

  /** 从压缩包创建新工作区 */
  app.post('/', async (c) => {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    const projectName = (formData.get('projectName') as string) || 'Untitled';
    const importFormat = (formData.get('importFormat') as string) || undefined;
    const importPattern = (formData.get('importPattern') as string) || undefined;
    const translatorName =
      (formData.get('translatorName') as string) || undefined;
    const manifestJson = (formData.get('manifestJson') as string) || undefined;
    const textSplitMaxChars = readOptionalPositiveInteger(
      formData.get('textSplitMaxChars'),
      'textSplitMaxChars',
    );
    const translationImportMode = parseTranslationImportMode(
      formData.get('translationImportMode'),
      'translationImportMode',
    );

    if (!file) {
      return c.json({ error: '请上传压缩包（ZIP / 7Z）' }, 400);
    }

    let workspaceDir: string | undefined;
    try {
      const manifest = manifestJson ? parseWorkspaceManifest(manifestJson) : undefined;
      const resolvedTranslatorName = manifest?.translatorName ?? translatorName;
      if (!resolvedTranslatorName) {
        return c.json({ error: '请选择翻译器，翻译器现在是语言对与提示词的唯一入口。' }, 400);
      }
      const archiveBuffer = await file.arrayBuffer();
      const createdWorkspace =
        await workspaceManager.createFromZip(projectName, archiveBuffer, file.name);
      workspaceDir = createdWorkspace.workspaceDir;
      const { extractedFiles } = createdWorkspace;
      const resolvedImportFormat = manifest?.importFormat ?? importFormat;
      const resolvedTextSplitMaxChars = manifest?.textSplitMaxChars ?? textSplitMaxChars;
      const resolvedTranslationImportMode =
        manifest?.translationImportMode ?? translationImportMode;

      const chapterFiles = (
        manifest?.chapterPaths?.length
          ? manifest.chapterPaths
          : await resolveImportedChapterFiles(
              workspaceDir,
              extractedFiles,
              manifest?.importPattern ?? importPattern,
            )
      ).sort();

      if (chapterFiles.length === 0) {
        await cleanupWorkspaceDirectory(workspaceDir);
        workspaceDir = undefined;
        return c.json(
          {
            error:
              manifest?.importPattern ?? importPattern
                ? '压缩包中没有文件匹配导入 Pattern'
                : '压缩包中未发现可识别的翻译源文件',
            extractedFiles,
            importPattern: manifest?.importPattern ?? importPattern,
          },
          400,
        );
      }

      const translationSummary = await inspectImportedTranslationContent(
        workspaceDir,
        chapterFiles,
        resolvedImportFormat,
      );
      if (
        translationSummary.hasTranslatedContent &&
        resolvedTranslationImportMode === undefined
      ) {
        await cleanupWorkspaceDirectory(workspaceDir);
        workspaceDir = undefined;
        return c.json(
          {
            error: '检测到导入文件中存在已翻译内容，请先选择导入译文还是只导入原文',
            code: 'translation-choice-required',
            translatedFileCount: translationSummary.translatedFileCount,
            translatedUnitCount: translationSummary.translatedUnitCount,
          },
          409,
        );
      }

      const ok = await projectService.initializeProject({
        projectName: manifest?.projectName ?? projectName,
        projectDir: workspaceDir,
        chapterPaths: chapterFiles,
        importFormat: resolvedImportFormat,
        translatorName: resolvedTranslatorName,
        textSplitMaxChars: resolvedTextSplitMaxChars,
        importTranslation: resolvedTranslationImportMode === 'with-translation',
        glossaryPath: manifest?.glossaryPath,
        branches: manifest?.branches,
      });

      if (!ok) {
        await cleanupWorkspaceDirectory(workspaceDir);
        workspaceDir = undefined;
        return c.json({ error: '初始化项目失败，请检查日志' }, 500);
      }

      return c.json({
        workspaceDir,
        extractedFiles,
        chapterFiles,
        snapshot: projectService.getSnapshot(),
      });
    } catch (error) {
      if (workspaceDir) {
        await cleanupWorkspaceDirectory(workspaceDir);
      }
      return c.json({ error: String(error) }, 500);
    }
  });

  /** 导入完整工作区归档 */
  app.post('/import', async (c) => {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return c.json({ error: '请上传 ZIP 文件' }, 400);
    }

    try {
      const zipBuffer = await file.arrayBuffer();
      const imported = await workspaceManager.importWorkspaceArchive(zipBuffer);
      return c.json(imported);
    } catch (error) {
      return c.json({ error: String(error) }, 400);
    }
  });

  /** 导出完整工作区归档 */
  app.post('/export', async (c) => {
    const body = await c.req.json<{ dir: string }>();
    if (!body.dir) {
      return c.json({ error: '缺少 dir 参数' }, 400);
    }

    try {
      const { archive, manifest } = await workspaceManager.exportWorkspaceArchive(body.dir);
      const fileName = `${sanitizeFileName(manifest.projectName)}-workspace.zip`;
      return new Response(new Blob([copyArrayBuffer(archive.buffer)]), {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
        },
      });
    } catch (error) {
      return c.json({ error: String(error) }, 400);
    }
  });

  /** 打开已有工作区 */
  app.post('/open', async (c) => {
    const body = await c.req.json<{ dir: string; projectName?: string }>();
    if (!body.dir) {
      return c.json({ error: '缺少 dir 参数' }, 400);
    }

    const ok = await projectService.initializeProject({
      projectName: body.projectName ?? 'Project',
      projectDir: body.dir,
      chapterPaths: [],
    });

    if (!ok) {
      return c.json({ error: '打开工作区失败' }, 500);
    }

    return c.json({
      snapshot: projectService.getSnapshot(),
    });
  });

  /** 删除工作区 */
  app.delete('/', async (c) => {
    const body = await c.req.json<{ dir: string }>();
    if (!body.dir) {
      return c.json({ error: '缺少 dir 参数' }, 400);
    }

    try {
      await workspaceManager.removeWorkspace(body.dir);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: String(error) }, 500);
    }
  });

  /** 获取当前活跃项目状态 */
  app.get('/active', (c) => {
    return c.json(projectService.getStatus());
  });

  /** 关闭当前工作区 */
  app.post('/close', (c) => {
    projectService.closeWorkspace();
    return c.json({ ok: true });
  });

  /** 删除当前工作区 */
  app.post('/remove', async (c) => {
    await projectService.removeWorkspace();
    return c.json({ ok: true });
  });

  return app;
}

type UploadedWorkspaceManifest = {
  projectName?: string;
  chapterPaths?: string[];
  importPattern?: string;
  glossaryPath?: string;
  importFormat?: string;
  translatorName?: string;
  textSplitMaxChars?: number;
  translationImportMode?: TranslationImportMode;
  branches?: BranchImportInput[];
};

type TranslationImportMode = 'source-only' | 'with-translation';

function isVisibleWorkspaceFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (lower.includes('/__macosx/') || lower.startsWith('__macosx/')) {
    return false;
  }
  if (lower.includes('/.') || lower.startsWith('.')) {
    return false;
  }
  return true;
}

function parseWorkspaceManifest(raw: string): UploadedWorkspaceManifest {
  const parsed = JSON.parse(raw) as UploadedWorkspaceManifest;
  if (parsed.chapterPaths && !Array.isArray(parsed.chapterPaths)) {
    throw new Error('manifest.chapterPaths 必须是字符串数组');
  }
  if (parsed.branches && !Array.isArray(parsed.branches)) {
    throw new Error('manifest.branches 必须是数组');
  }
  if (parsed.textSplitMaxChars !== undefined) {
    parsed.textSplitMaxChars = readOptionalPositiveInteger(
      parsed.textSplitMaxChars,
      'manifest.textSplitMaxChars',
    );
  }
  if (parsed.translationImportMode !== undefined) {
    parsed.translationImportMode = parseTranslationImportMode(
      parsed.translationImportMode,
      'manifest.translationImportMode',
    );
  }
  return parsed;
}

async function resolveImportedChapterFiles(
  workspaceDir: string,
  extractedFiles: string[],
  importPattern?: string,
): Promise<string[]> {
  const normalizedPattern = normalizeImportPattern(importPattern);
  const visibleFiles = extractedFiles.filter((filePath) => isVisibleWorkspaceFile(filePath));

  const candidateFiles = normalizedPattern
    ? visibleFiles.filter((filePath) => {
        const normalizedFilePath = filePath.replace(/\\/g, '/');
        return buildImportGlobPatterns(normalizedPattern).some((pattern) =>
          new Bun.Glob(pattern).match(normalizedFilePath),
        );
      })
    : visibleFiles;

  const detectedFiles = await Promise.all(
    candidateFiles.map(async (filePath) =>
      (await isLikelyTextFile(join(workspaceDir, ...filePath.split('/')))) ? filePath : null,
    ),
  );
  return detectedFiles.filter((filePath): filePath is string => Boolean(filePath));
}

function normalizeImportPattern(importPattern?: string): string | undefined {
  const normalizedPattern = importPattern?.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  return normalizedPattern ? normalizedPattern : undefined;
}

function buildImportGlobPatterns(importPattern: string): string[] {
  const patterns = [importPattern];
  if (!importPattern.includes('/')) {
    patterns.push(`**/${importPattern}`);
  }
  return [...new Set(patterns)];
}

async function isLikelyTextFile(filePath: string): Promise<boolean> {
  const sample = new Uint8Array(await Bun.file(filePath).slice(0, 4096).arrayBuffer());
  if (sample.length === 0) {
    return true;
  }

  let controlCharCount = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return false;
    }
    if ((byte < 9 || (byte > 13 && byte < 32)) && byte !== 27) {
      controlCharCount += 1;
    }
  }

  return controlCharCount / sample.length < 0.05;
}

async function inspectImportedTranslationContent(
  workspaceDir: string,
  chapterFiles: string[],
  importFormat?: string,
): Promise<{
  hasTranslatedContent: boolean;
  translatedFileCount: number;
  translatedUnitCount: number;
}> {
  if (!importFormat) {
    return {
      hasTranslatedContent: false,
      translatedFileCount: 0,
      translatedUnitCount: 0,
    };
  }

  const fileHandler = TranslationFileHandlerFactory.getHandler(importFormat);
  const unitCounts = await Promise.all(
    chapterFiles.map(async (filePath) => {
      const units = await fileHandler.readTranslationUnits(
        join(workspaceDir, ...filePath.split('/')),
      );
      return countTranslatedUnits(units);
    }),
  );
  const translatedFileCount = unitCounts.filter((count) => count > 0).length;
  const translatedUnitCount = unitCounts.reduce((sum, count) => sum + count, 0);
  return {
    hasTranslatedContent: translatedUnitCount > 0,
    translatedFileCount,
    translatedUnitCount,
  };
}

function countTranslatedUnits(units: TranslationUnit[]): number {
  return units.filter((unit) =>
    unit.target.some((target) => target.trim().length > 0),
  ).length;
}

function readOptionalPositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }

  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} 必须是正整数`);
  }

  return parsed;
}

function parseTranslationImportMode(
  value: unknown,
  fieldName: string,
): TranslationImportMode | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }

  const normalized = String(value);
  if (normalized === 'source-only' || normalized === 'with-translation') {
    return normalized;
  }

  throw new Error(`${fieldName} 必须是 "source-only" 或 "with-translation"`);
}

async function cleanupWorkspaceDirectory(workspaceDir: string): Promise<void> {
  await rm(workspaceDir, { recursive: true, force: true });
}

function sanitizeFileName(name: string): string {
  const normalized = name.trim().replace(/[^\w\-\u4e00-\u9fff]+/g, '_');
  return normalized || 'workspace';
}

function copyArrayBuffer(buffer: ArrayBufferLike): ArrayBuffer {
  return Uint8Array.from(new Uint8Array(buffer)).buffer;
}
