import { access, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { normalize as normalizePosix } from 'node:path/posix';
import JSZip from 'jszip';

const WINDOWS_7Z_CANDIDATES = [
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe',
];

export interface ExtractArchiveOptions {
  archiveFileName?: string;
  stripSingleRoot?: boolean;
}

export async function extractArchiveToDirectory(
  targetDir: string,
  archiveBuffer: ArrayBuffer,
  options: ExtractArchiveOptions = {},
): Promise<string[]> {
  await mkdir(targetDir, { recursive: true });

  let extractedBy7z: string[] | null = null;
  let externalExtractionError: unknown;

  try {
    extractedBy7z = await tryExtractArchiveWith7z(
      targetDir,
      archiveBuffer,
      options.archiveFileName ?? 'archive.zip',
      options.stripSingleRoot ?? true,
    );
  } catch (error) {
    externalExtractionError = error;
  }

  if (extractedBy7z && extractedBy7z.length > 0) {
    return extractedBy7z;
  }

  try {
    return await extractWithJsZip(
      targetDir,
      archiveBuffer,
      options.stripSingleRoot ?? true,
    );
  } catch (error) {
    throw buildArchiveExtractionError(error, externalExtractionError);
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

async function extractWithJsZip(
  targetDir: string,
  archiveBuffer: ArrayBuffer,
  stripSingleRoot: boolean,
): Promise<string[]> {
  const zip = await JSZip.loadAsync(archiveBuffer);
  const entries = Object.keys(zip.files);
  const rootPrefix = stripSingleRoot ? detectSingleRootPrefix(entries) : undefined;
  const extractedFiles: string[] = [];

  for (const [rawPath, zipEntry] of Object.entries(zip.files)) {
    if (zipEntry.dir) continue;

    const relativePath = normalizeArchiveEntryPath(
      rootPrefix ? rawPath.slice(rootPrefix.length) : rawPath,
    );
    if (!relativePath) continue;

    const targetPath = join(targetDir, ...relativePath.split('/'));
    await mkdir(dirname(targetPath), { recursive: true });

    const content = await zipEntry.async('nodebuffer');
    await Bun.write(targetPath, content);
    extractedFiles.push(relativePath);
  }

  return extractedFiles.sort((left, right) => left.localeCompare(right));
}

async function tryExtractArchiveWith7z(
  targetDir: string,
  archiveBuffer: ArrayBuffer,
  archiveFileName: string,
  stripSingleRoot: boolean,
): Promise<string[] | null> {
  const sevenZipBinary = await resolve7zBinaryPath();
  if (!sevenZipBinary) {
    return null;
  }

  const tempArchivePath = join(targetDir, buildTempArchiveName(archiveFileName));
  const extractTempDir = join(targetDir, '__archive_extract__');
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
    const rootPrefix = stripSingleRoot ? detectSingleRootPrefix(extractedFiles) : undefined;
    const mappedPaths = new Set<string>();

    for (const sourceRelativePath of extractedFiles) {
      const outputRelativePath = normalizeArchiveEntryPath(
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
      const targetPath = join(targetDir, ...outputRelativePath.split('/'));
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

function detectSingleRootPrefix(entries: string[]): string | undefined {
  if (entries.length === 0) return undefined;

  const first = entries[0]!;
  const slashIndex = first.indexOf('/');
  if (slashIndex === -1) return undefined;

  const prefix = first.slice(0, slashIndex + 1);
  if (entries.every((entryPath) => entryPath.startsWith(prefix))) {
    return prefix;
  }

  return undefined;
}

function normalizeArchiveEntryPath(path: string): string {
  const normalized = normalizePosix(path).replace(/^\/+/, '');
  if (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new Error(`压缩包中存在非法路径: ${path}`);
  }

  return normalized;
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? 'unknown error');
}
