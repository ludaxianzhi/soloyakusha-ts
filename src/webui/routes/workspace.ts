/**
 * 工作区 REST API：列表、创建（ZIP 上传）、打开、删除。
 */

import { join } from 'node:path';
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

  /** 从 ZIP 创建新工作区 */
  app.post('/', async (c) => {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    const projectName = (formData.get('projectName') as string) || 'Untitled';
    const importFormat = (formData.get('importFormat') as string) || undefined;
    const importPattern = (formData.get('importPattern') as string) || undefined;
    const translatorName =
      (formData.get('translatorName') as string) || undefined;
    const srcLang = (formData.get('srcLang') as string) || undefined;
    const tgtLang = (formData.get('tgtLang') as string) || undefined;
    const manifestJson = (formData.get('manifestJson') as string) || undefined;

    if (!file) {
      return c.json({ error: '请上传 ZIP 文件' }, 400);
    }

    try {
      const manifest = manifestJson ? parseWorkspaceManifest(manifestJson) : undefined;
      const zipBuffer = await file.arrayBuffer();
      const { workspaceDir, extractedFiles } =
        await workspaceManager.createFromZip(projectName, zipBuffer);

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

      const ok = await projectService.initializeProject({
        projectName: manifest?.projectName ?? projectName,
        projectDir: workspaceDir,
        chapterPaths: chapterFiles,
        importFormat: manifest?.importFormat ?? importFormat,
        translatorName: manifest?.translatorName ?? translatorName,
        srcLang: manifest?.srcLang ?? srcLang,
        tgtLang: manifest?.tgtLang ?? tgtLang,
        glossaryPath: manifest?.glossaryPath,
        branches: manifest?.branches,
      });

      if (!ok) {
        return c.json({ error: '初始化项目失败，请检查日志' }, 500);
      }

      return c.json({
        workspaceDir,
        extractedFiles,
        chapterFiles,
        snapshot: projectService.getSnapshot(),
      });
    } catch (error) {
      return c.json({ error: String(error) }, 500);
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
  srcLang?: string;
  tgtLang?: string;
  importFormat?: string;
  translatorName?: string;
  branches?: BranchImportInput[];
};

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
