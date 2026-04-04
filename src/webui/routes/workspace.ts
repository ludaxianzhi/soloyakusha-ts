/**
 * 工作区 REST API：列表、创建（ZIP 上传）、打开、删除。
 */

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
          : extractedFiles.filter((f) => isTranslationFile(f))
      ).sort();

      if (chapterFiles.length === 0) {
        return c.json(
          {
            error: '压缩包中未发现可识别的翻译源文件',
            extractedFiles,
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
  glossaryPath?: string;
  srcLang?: string;
  tgtLang?: string;
  importFormat?: string;
  translatorName?: string;
  branches?: BranchImportInput[];
};

function isTranslationFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  // 跳过隐藏文件和 macOS 资源文件
  if (lower.includes('/__macosx/') || lower.startsWith('__macosx/')) {
    return false;
  }
  if (lower.includes('/.') || lower.startsWith('.')) {
    return false;
  }
  return (
    lower.endsWith('.txt') ||
    lower.endsWith('.m3t') ||
    lower.endsWith('.json') ||
    lower.endsWith('.csv') ||
    lower.endsWith('.tsv') ||
    lower.endsWith('.yaml') ||
    lower.endsWith('.yml')
  );
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
