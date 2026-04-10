/**
 * 工作区目录管理：ZIP 上传解压、工作区列表、删除。
 */

import { access, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { WorkspaceRegistry } from '../../config/workspace-registry.ts';
import type { WorkspaceEntry } from '../../config/types.ts';
import {
  inspectWorkspaceBootstrap,
  openWorkspaceConfig,
} from '../../project/translation-project-workspace.ts';
import {
  exportWorkspaceArchive,
  importWorkspaceArchive,
  type WorkspaceArchiveManifest,
} from './workspace-archive.ts';
import { extractArchiveToDirectory } from './archive-extractor.ts';

const DEFAULT_BASE_DIR = join(homedir(), '.soloyakusha-ts', 'workspaces');

export interface ManagedWorkspace extends WorkspaceEntry {
  managed: boolean;
  deprecated?: boolean;
  deprecationMessage?: string;
}

export class WorkspaceManager {
  private readonly baseDir: string;
  private readonly registry: WorkspaceRegistry;

  constructor(baseDir?: string, registry = new WorkspaceRegistry()) {
    this.baseDir = baseDir ?? DEFAULT_BASE_DIR;
    this.registry = registry;
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  async ensureBaseDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  /**
   * 从上传的压缩包创建工作区目录并解压文件。
   * 解压优先使用 7z（支持更多压缩方法与 7z 格式），不可用时回退 JSZip。
   * 返回工作区根目录和解压出的相对文件路径列表。
   */
  async createFromZip(
    projectName: string,
    archiveBuffer: ArrayBuffer,
    archiveFileName = 'archive.zip',
  ): Promise<{ workspaceDir: string; extractedFiles: string[] }> {
    await this.ensureBaseDir();

    const safeName = projectName.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_');
    const dirName = `${safeName}_${Date.now()}`;
    const workspaceDir = join(this.baseDir, dirName);
    await mkdir(workspaceDir, { recursive: true });

    const extractedFiles = await extractArchiveToDirectory(workspaceDir, archiveBuffer, {
      archiveFileName,
      stripSingleRoot: true,
    });
    return { workspaceDir, extractedFiles };
  }

  async importWorkspaceArchive(
    zipBuffer: ArrayBuffer,
  ): Promise<{
    workspaceDir: string;
    extractedFiles: string[];
    manifest: WorkspaceArchiveManifest;
  }> {
    await this.ensureBaseDir();

    const workspaceDir = join(this.baseDir, `workspace_archive_${Date.now()}`);
    await mkdir(workspaceDir, { recursive: true });

    try {
      const imported = await importWorkspaceArchive(zipBuffer, workspaceDir);
      return {
        workspaceDir,
        extractedFiles: imported.extractedFiles,
        manifest: imported.manifest,
      };
    } catch (error) {
      await rm(workspaceDir, { recursive: true, force: true });
      throw error;
    }
  }

  async exportWorkspaceArchive(
    dir: string,
  ): Promise<{ archive: Uint8Array; manifest: WorkspaceArchiveManifest }> {
    return exportWorkspaceArchive(dir);
  }

  async listWorkspaces(): Promise<ManagedWorkspace[]> {
    const recent = await this.registry.listRegisteredWorkspaces({
      pruneMissing: true,
    });
    const merged = new Map<string, ManagedWorkspace>();

    for (const ws of recent) {
      merged.set(ws.dir, {
        ...ws,
        managed: ws.dir.startsWith(this.baseDir),
      });
    }

    for (const discovered of await this.discoverManagedWorkspaces()) {
      const existing = merged.get(discovered.dir);
      merged.set(discovered.dir, existing ? { ...existing, managed: true } : discovered);
    }

    return [...merged.values()].sort((left, right) =>
      right.lastOpenedAt.localeCompare(left.lastOpenedAt),
    );
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

  private async discoverManagedWorkspaces(): Promise<ManagedWorkspace[]> {
    try {
      const entries = await readdir(this.baseDir, { withFileTypes: true });
      const discovered = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            const dir = join(this.baseDir, entry.name);
            const configPath = join(dir, 'Data', 'workspace-config.json');

            try {
              await access(configPath);
              const [inspection, stats] = await Promise.all([
                inspectWorkspaceBootstrap(dir),
                stat(configPath),
              ]);
              if (inspection.kind === 'deprecated') {
                return {
                  name: inspection.projectName?.trim() || `${entry.name}（已弃用）`,
                  dir,
                  lastOpenedAt: stats.mtime.toISOString(),
                  managed: true,
                  deprecated: true,
                  deprecationMessage: inspection.message,
                } as ManagedWorkspace;
              }
              if (inspection.kind !== 'current') {
                return null;
              }

              const config = await openWorkspaceConfig(dir);
              return {
                name: config.projectName?.trim() || entry.name,
                dir,
                lastOpenedAt: stats.mtime.toISOString(),
                managed: true,
              } as ManagedWorkspace;
            } catch {
              return null;
            }
          }),
      );

      return discovered.filter((entry): entry is ManagedWorkspace => entry !== null);
    } catch {
      return [];
    }
  }
}
