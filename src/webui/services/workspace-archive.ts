import { mkdir, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { normalize as normalizePosix } from 'node:path/posix';
import JSZip from 'jszip';

const ARCHIVE_MANIFEST_FILE = 'soloyakusha-workspace.json';
const ARCHIVE_WORKSPACE_ROOT = 'workspace';
const WORKSPACE_CONFIG_RELATIVE_PATH = 'Data/workspace-config.json';
const PROJECT_STATE_RELATIVE_PATH = 'Data/project-state.json';
const SUPPORTED_WORKSPACE_SCHEMA_VERSION = 1;
const SUPPORTED_PROJECT_STATE_SCHEMA_VERSION = 1;

export const WORKSPACE_ARCHIVE_VERSION = 1;

export interface WorkspaceArchiveManifest {
  archiveType: 'workspace';
  archiveVersion: typeof WORKSPACE_ARCHIVE_VERSION;
  workspaceRoot: typeof ARCHIVE_WORKSPACE_ROOT;
  projectName: string;
  exportedAt: string;
  sourceDirectoryName: string;
  workspaceSchemaVersion: number;
  projectStateSchemaVersion: number;
}

export async function exportWorkspaceArchive(
  workspaceDir: string,
): Promise<{ archive: Uint8Array; manifest: WorkspaceArchiveManifest }> {
  const [workspaceConfig, projectState] = await Promise.all([
    readWorkspaceConfigDocument(workspaceDir),
    readProjectStateDocument(workspaceDir),
  ]);
  validateSupportedWorkspaceVersions(
    workspaceConfig.schemaVersion,
    projectState.schemaVersion,
  );

  const manifest: WorkspaceArchiveManifest = {
    archiveType: 'workspace',
    archiveVersion: WORKSPACE_ARCHIVE_VERSION,
    workspaceRoot: ARCHIVE_WORKSPACE_ROOT,
    projectName: workspaceConfig.projectName,
    exportedAt: new Date().toISOString(),
    sourceDirectoryName: basename(workspaceDir),
    workspaceSchemaVersion: workspaceConfig.schemaVersion,
    projectStateSchemaVersion: projectState.schemaVersion,
  };

  const zip = new JSZip();
  zip.file(ARCHIVE_MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  await addDirectoryToZip(zip, workspaceDir, workspaceDir, ARCHIVE_WORKSPACE_ROOT);

  return {
    archive: await zip.generateAsync({ type: 'uint8array' }),
    manifest,
  };
}

export async function importWorkspaceArchive(
  zipBuffer: ArrayBuffer,
  targetDir: string,
): Promise<{ extractedFiles: string[]; manifest: WorkspaceArchiveManifest }> {
  const zip = await JSZip.loadAsync(zipBuffer);
  const manifest = await readArchiveManifest(zip);
  const archiveRoot = `${manifest.workspaceRoot}/`;

  const [workspaceConfig, projectState] = await Promise.all([
    readArchiveJson(zip, `${archiveRoot}${WORKSPACE_CONFIG_RELATIVE_PATH}`),
    readArchiveJson(zip, `${archiveRoot}${PROJECT_STATE_RELATIVE_PATH}`),
  ]);

  if (workspaceConfig.projectName !== manifest.projectName) {
    throw new Error('工作区归档 manifest 与 workspace-config 中的 projectName 不一致');
  }
  if (workspaceConfig.schemaVersion !== manifest.workspaceSchemaVersion) {
    throw new Error('工作区归档 manifest 与 workspace-config 中的 schemaVersion 不一致');
  }
  if (projectState.schemaVersion !== manifest.projectStateSchemaVersion) {
    throw new Error('工作区归档 manifest 与 project-state 中的 schemaVersion 不一致');
  }

  validateSupportedWorkspaceVersions(
    workspaceConfig.schemaVersion,
    projectState.schemaVersion,
  );

  await mkdir(targetDir, { recursive: true });
  const extractedFiles: string[] = [];

  for (const [rawPath, zipEntry] of Object.entries(zip.files)) {
    if (zipEntry.dir || rawPath === ARCHIVE_MANIFEST_FILE || !rawPath.startsWith(archiveRoot)) {
      continue;
    }

    const relativePath = normalizeArchiveEntryPath(rawPath.slice(archiveRoot.length));
    if (!relativePath) {
      continue;
    }

    const targetPath = join(targetDir, ...relativePath.split('/'));
    await mkdir(dirname(targetPath), { recursive: true });
    await Bun.write(targetPath, await zipEntry.async('nodebuffer'));
    extractedFiles.push(relativePath);
  }

  if (extractedFiles.length === 0) {
    throw new Error('工作区归档中没有可解压的文件');
  }

  return { extractedFiles, manifest };
}

async function addDirectoryToZip(
  zip: JSZip,
  baseDir: string,
  currentDir: string,
  archiveRoot: string,
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await addDirectoryToZip(zip, baseDir, absolutePath, archiveRoot);
      continue;
    }

    const relativePath = relative(baseDir, absolutePath).replace(/\\/g, '/');
    const archivePath = relativePath
      ? `${archiveRoot}/${relativePath}`
      : `${archiveRoot}/${basename(absolutePath)}`;
    zip.file(archivePath, await Bun.file(absolutePath).arrayBuffer());
  }
}

async function readArchiveManifest(zip: JSZip): Promise<WorkspaceArchiveManifest> {
  return parseArchiveManifest(
    await readArchiveJson(zip, ARCHIVE_MANIFEST_FILE),
    ARCHIVE_MANIFEST_FILE,
  );
}

async function readArchiveJson(zip: JSZip, entryPath: string): Promise<Record<string, unknown>> {
  const entry = zip.file(entryPath);
  if (!entry) {
    throw new Error(`工作区归档缺少必需文件: ${entryPath}`);
  }

  const raw = await entry.async('string');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`工作区归档中的 JSON 无法解析: ${entryPath}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`工作区归档中的 JSON 必须是对象: ${entryPath}`);
  }
  return parsed;
}

async function readWorkspaceConfigDocument(workspaceDir: string): Promise<{
  schemaVersion: number;
  projectName: string;
}> {
  const parsed = await readJsonFile(join(workspaceDir, WORKSPACE_CONFIG_RELATIVE_PATH));
  const schemaVersion = readRequiredNumber(parsed.schemaVersion, WORKSPACE_CONFIG_RELATIVE_PATH);
  const projectName = readRequiredString(parsed.projectName, WORKSPACE_CONFIG_RELATIVE_PATH);
  return { schemaVersion, projectName };
}

async function readProjectStateDocument(workspaceDir: string): Promise<{
  schemaVersion: number;
}> {
  const parsed = await readJsonFile(join(workspaceDir, PROJECT_STATE_RELATIVE_PATH));
  return {
    schemaVersion: readRequiredNumber(parsed.schemaVersion, PROJECT_STATE_RELATIVE_PATH),
  };
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    throw new Error(`工作区缺少必需文件: ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`工作区文件无法解析为 JSON: ${filePath}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`工作区文件必须是 JSON 对象: ${filePath}`);
  }
  return parsed;
}

function parseArchiveManifest(
  value: Record<string, unknown>,
  sourceLabel: string,
): WorkspaceArchiveManifest {
  const archiveType = readRequiredString(value.archiveType, `${sourceLabel}.archiveType`);
  if (archiveType !== 'workspace') {
    throw new Error(`不支持的工作区归档类型: ${archiveType}`);
  }

  const archiveVersion = readRequiredNumber(
    value.archiveVersion,
    `${sourceLabel}.archiveVersion`,
  );
  if (archiveVersion !== WORKSPACE_ARCHIVE_VERSION) {
    throw new Error(`不支持的工作区归档版本: ${archiveVersion}`);
  }

  const workspaceRoot = readRequiredString(
    value.workspaceRoot,
    `${sourceLabel}.workspaceRoot`,
  );
  if (workspaceRoot !== ARCHIVE_WORKSPACE_ROOT) {
    throw new Error(`不支持的工作区归档根目录: ${workspaceRoot}`);
  }

  return {
    archiveType: 'workspace',
    archiveVersion: WORKSPACE_ARCHIVE_VERSION,
    workspaceRoot: ARCHIVE_WORKSPACE_ROOT,
    projectName: readRequiredString(value.projectName, `${sourceLabel}.projectName`),
    exportedAt: readRequiredString(value.exportedAt, `${sourceLabel}.exportedAt`),
    sourceDirectoryName: readRequiredString(
      value.sourceDirectoryName,
      `${sourceLabel}.sourceDirectoryName`,
    ),
    workspaceSchemaVersion: readRequiredNumber(
      value.workspaceSchemaVersion,
      `${sourceLabel}.workspaceSchemaVersion`,
    ),
    projectStateSchemaVersion: readRequiredNumber(
      value.projectStateSchemaVersion,
      `${sourceLabel}.projectStateSchemaVersion`,
    ),
  };
}

function validateSupportedWorkspaceVersions(
  workspaceSchemaVersion: number,
  projectStateSchemaVersion: number,
): void {
  if (workspaceSchemaVersion !== SUPPORTED_WORKSPACE_SCHEMA_VERSION) {
    throw new Error(`不支持的工作区配置版本: ${workspaceSchemaVersion}`);
  }
  if (projectStateSchemaVersion !== SUPPORTED_PROJECT_STATE_SCHEMA_VERSION) {
    throw new Error(`不支持的工作区状态版本: ${projectStateSchemaVersion}`);
  }
}

function normalizeArchiveEntryPath(path: string): string {
  const normalized = normalizePosix(path).replace(/^\/+/, '');
  if (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new Error(`工作区归档中存在非法路径: ${path}`);
  }

  return normalized;
}

function readRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} 必须是非空字符串`);
  }
  return value;
}

function readRequiredNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} 必须是数字`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
