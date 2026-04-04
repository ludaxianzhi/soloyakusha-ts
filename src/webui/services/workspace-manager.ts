/**
 * 工作区目录管理：ZIP 上传解压、工作区列表、删除。
 */

import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { normalize as normalizePosix } from 'node:path/posix';
import { homedir } from 'node:os';
import JSZip from 'jszip';
import { WorkspaceRegistry } from '../../config/workspace-registry.ts';
import type { WorkspaceEntry } from '../../config/types.ts';

const DEFAULT_BASE_DIR = join(homedir(), '.soloyakusha-ts', 'workspaces');

export interface ManagedWorkspace extends WorkspaceEntry {
  managed: boolean;
}

export class WorkspaceManager {
  private readonly baseDir: string;
  private readonly registry: WorkspaceRegistry;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? DEFAULT_BASE_DIR;
    this.registry = new WorkspaceRegistry();
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  async ensureBaseDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  /**
   * 从上传的 ZIP 创建工作区目录并解压文件。
   * 返回工作区根目录和解压出的相对文件路径列表。
   */
  async createFromZip(
    projectName: string,
    zipBuffer: ArrayBuffer,
  ): Promise<{ workspaceDir: string; extractedFiles: string[] }> {
    await this.ensureBaseDir();

    const safeName = projectName.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_');
    const dirName = `${safeName}_${Date.now()}`;
    const workspaceDir = join(this.baseDir, dirName);
    await mkdir(workspaceDir, { recursive: true });

    const zip = await JSZip.loadAsync(zipBuffer);
    const extractedFiles: string[] = [];

    // 识别 ZIP 内是否有唯一根目录（常见打包方式），若有则剥离
    const entries = Object.keys(zip.files);
    const rootPrefix = detectSingleRootPrefix(entries);

    for (const [rawPath, zipEntry] of Object.entries(zip.files)) {
      if (zipEntry.dir) continue;

      const relativePath = normalizeZipEntryPath(
        rootPrefix ? rawPath.slice(rootPrefix.length) : rawPath,
      );
      if (!relativePath) continue;

      const targetPath = join(workspaceDir, relativePath);
      await mkdir(dirname(targetPath), { recursive: true });

      const content = await zipEntry.async('nodebuffer');
      await Bun.write(targetPath, content);
      extractedFiles.push(relativePath);
    }

    return { workspaceDir, extractedFiles };
  }

  async listWorkspaces(): Promise<ManagedWorkspace[]> {
    const recent = await this.registry.listRegisteredWorkspaces({
      pruneMissing: true,
    });

    return recent.map((ws) => ({
      ...ws,
      managed: ws.dir.startsWith(this.baseDir),
    }));
  }

  async removeWorkspace(dir: string): Promise<void> {
    await this.registry.removeWorkspace(dir);

    if (dir.startsWith(this.baseDir)) {
      await rm(dir, { recursive: true, force: true });
    } else {
      for (const subDir of ['Data', 'logs']) {
        try {
          await rm(join(dir, subDir), { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  }

  isManaged(dir: string): boolean {
    return dir.startsWith(this.baseDir);
  }
}

/** 检测 ZIP 条目是否都在同一个根文件夹下 */
function detectSingleRootPrefix(entries: string[]): string | undefined {
  if (entries.length === 0) return undefined;

  const first = entries[0]!;
  const slashIndex = first.indexOf('/');
  if (slashIndex === -1) return undefined;

  const prefix = first.slice(0, slashIndex + 1);
  if (entries.every((e) => e.startsWith(prefix))) {
    return prefix;
  }

  return undefined;
}

function normalizeZipEntryPath(path: string): string {
  const normalized = normalizePosix(path).replace(/^\/+/, '');
  if (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new Error(`ZIP 中存在非法路径: ${path}`);
  }

  return normalized;
}
