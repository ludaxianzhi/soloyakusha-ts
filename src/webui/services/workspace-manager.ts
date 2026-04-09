/**
 * 工作区目录管理：ZIP 上传解压、工作区列表、删除。
 */

import { access, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { normalize as normalizePosix } from 'node:path/posix';
import { homedir } from 'node:os';
import JSZip from 'jszip';
import { WorkspaceRegistry } from '../../config/workspace-registry.ts';
import type { WorkspaceEntry } from '../../config/types.ts';
import { openWorkspaceConfig } from '../../project/translation-project-workspace.ts';
import {
  exportWorkspaceArchive,
  importWorkspaceArchive,
  type WorkspaceArchiveManifest,
} from './workspace-archive.ts';

const DEFAULT_BASE_DIR = join(homedir(), '.soloyakusha-ts', 'workspaces');
const WINDOWS_7Z_CANDIDATES = [
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe',
];

export interface ManagedWorkspace extends WorkspaceEntry {
  managed: boolean;
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

    let extractedBy7z: string[] | null = null;
    let externalExtractionError: unknown;

    try {
      extractedBy7z = await tryExtractArchiveWith7z(
        workspaceDir,
        archiveBuffer,
        archiveFileName,
      );
    } catch (error) {
      externalExtractionError = error;
    }

    if (extractedBy7z && extractedBy7z.length > 0) {
      return {
        workspaceDir,
        extractedFiles: extractedBy7z,
      };
    }

    try {
      const extractedFiles = await extractWithJsZipFallback(workspaceDir, archiveBuffer);
      return { workspaceDir, extractedFiles };
    } catch (error) {
      throw buildArchiveExtractionError(error, externalExtractionError);
    }
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
              const [config, stats] = await Promise.all([
                openWorkspaceConfig(dir),
                stat(configPath),
              ]);
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

function buildArchiveExtractionError(
  jsZipError: unknown,
  externalExtractionError: unknown,
): Error {
  const jsZipMessage = toErrorMessage(jsZipError);
  const externalMessage = toErrorMessage(externalExtractionError);
  const hasUnknownCompressionMessage =
    jsZipMessage.includes('compression') && jsZipMessage.includes('unknown');
  if (hasUnknownCompressionMessage) {
    return new Error(
      externalMessage
        ? `压缩包解压失败：当前归档使用了 JSZip 不支持的压缩方法，且 7z 解压不可用/失败。JSZip=${jsZipMessage}；7z=${externalMessage}`
        : `压缩包解压失败：当前归档使用了 JSZip 不支持的压缩方法（${jsZipMessage}）。请安装 7z，或改用常见 ZIP 压缩方法（deflate/store）重新打包。`,
    );
  }

  return new Error(
    externalMessage
      ? `压缩包解压失败：JSZip=${jsZipMessage}；7z=${externalMessage}`
      : `压缩包解压失败：${jsZipMessage}`,
  );
}

async function extractWithJsZipFallback(
  workspaceDir: string,
  archiveBuffer: ArrayBuffer,
): Promise<string[]> {
  const zip = await JSZip.loadAsync(archiveBuffer);
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

    const targetPath = join(workspaceDir, ...relativePath.split('/'));
    await mkdir(dirname(targetPath), { recursive: true });

    const content = await zipEntry.async('nodebuffer');
    await Bun.write(targetPath, content);
    extractedFiles.push(relativePath);
  }

  return extractedFiles;
}

async function tryExtractArchiveWith7z(
  workspaceDir: string,
  archiveBuffer: ArrayBuffer,
  archiveFileName: string,
): Promise<string[] | null> {
  const sevenZipBinary = await resolve7zBinaryPath();
  if (!sevenZipBinary) {
    return null;
  }

  const tempArchivePath = join(workspaceDir, buildTempArchiveName(archiveFileName));
  const extractTempDir = join(workspaceDir, '__archive_extract__');
  await mkdir(extractTempDir, { recursive: true });
  await Bun.write(tempArchivePath, archiveBuffer);

  try {
    const process = Bun.spawn({
      cmd: [sevenZipBinary, 'x', '-y', `-o${extractTempDir}`, tempArchivePath],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await process.exited;
    if (exitCode !== 0) {
      const stdout = await new Response(process.stdout).text();
      const stderr = await new Response(process.stderr).text();
      throw new Error(
        `exit=${exitCode}; stderr=${stderr.trim() || '-'}; stdout=${stdout.trim() || '-'}`,
      );
    }

    const extractedFiles = await collectRelativeFiles(extractTempDir);
    const rootPrefix = detectSingleRootPrefix(extractedFiles);
    const mappedPaths = new Set<string>();

    for (const sourceRelativePath of extractedFiles) {
      const outputRelativePath = normalizeZipEntryPath(
        rootPrefix ? sourceRelativePath.slice(rootPrefix.length) : sourceRelativePath,
      );
      if (!outputRelativePath) {
        continue;
      }
      if (mappedPaths.has(outputRelativePath)) {
        throw new Error(`压缩包中存在冲突路径: ${outputRelativePath}`);
      }
      mappedPaths.add(outputRelativePath);

      const sourcePath = join(extractTempDir, ...sourceRelativePath.split('/'));
      const targetPath = join(workspaceDir, ...outputRelativePath.split('/'));
      await mkdir(dirname(targetPath), { recursive: true });
      await rename(sourcePath, targetPath);
    }

    return [...mappedPaths].sort((left, right) => left.localeCompare(right));
  } catch (error) {
    throw new Error(`7z 解压失败（${sevenZipBinary}）：${toErrorMessage(error)}`);
  } finally {
    await rm(tempArchivePath, { force: true });
    await rm(extractTempDir, { recursive: true, force: true });
  }
}

async function collectRelativeFiles(rootDir: string): Promise<string[]> {
  const result: string[] = [];

  async function walk(dirPath: string, prefix: string): Promise<void> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const normalizedName = entry.name.replace(/\\/g, '/');
      const nextRelativePath = prefix ? `${prefix}/${normalizedName}` : normalizedName;
      const absolutePath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, nextRelativePath);
        continue;
      }
      result.push(nextRelativePath);
    }
  }

  await walk(rootDir, '');
  return result.sort((left, right) => left.localeCompare(right));
}

function buildTempArchiveName(archiveFileName: string): string {
  const lowerName = archiveFileName.toLowerCase();
  if (lowerName.endsWith('.7z')) {
    return '__upload__.7z';
  }
  if (lowerName.endsWith('.zip')) {
    return '__upload__.zip';
  }
  return '__upload__.bin';
}

async function resolve7zBinaryPath(): Promise<string | undefined> {
  const fromEnv = process.env.SEVEN_ZIP_BIN?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  for (const command of ['7z', '7za']) {
    const resolved = Bun.which(command);
    if (resolved) {
      return resolved;
    }
  }

  if (process.platform === 'win32') {
    for (const candidate of WINDOWS_7Z_CANDIDATES) {
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? 'unknown error');
}
