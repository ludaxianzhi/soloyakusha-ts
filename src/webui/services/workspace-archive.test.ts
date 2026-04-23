import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { SqliteProjectStorage } from '../../project/storage/sqlite-project-storage.ts';
import {
  WORKSPACE_BOOTSTRAP_SCHEMA_VERSION,
  buildWorkspaceBootstrapDocument,
  saveWorkspaceBootstrap,
} from '../../project/pipeline/translation-project-workspace.ts';
import {
  exportWorkspaceArchive,
  importWorkspaceArchive,
  WORKSPACE_ARCHIVE_VERSION,
} from './workspace-archive.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test('exportWorkspaceArchive writes manifest and full workspace files into zip', async () => {
  const workspaceDir = await createWorkspaceFixture('Archive Demo');

  const { archive, manifest } = await exportWorkspaceArchive(workspaceDir);
  const zip = await JSZip.loadAsync(copyArrayBuffer(archive.buffer));

  expect(manifest).toMatchObject({
    archiveType: 'workspace',
    archiveVersion: WORKSPACE_ARCHIVE_VERSION,
    workspaceRoot: 'workspace',
    projectName: 'Archive Demo',
    workspaceSchemaVersion: 1,
    projectStateSchemaVersion: 1,
  });

  const manifestDocument = JSON.parse(
    await zip.file('soloyakusha-workspace.json')!.async('string'),
  ) as Record<string, unknown>;
  expect(manifestDocument.projectName).toBe('Archive Demo');
  expect(await zip.file('workspace/Data/workspace-config.json')!.async('string')).toContain(
    '"projectName": "Archive Demo"',
  );
  expect(await zip.file('workspace/chapters/001.txt')!.async('string')).toBe('source text');
});

test('importWorkspaceArchive restores workspace files after validation', async () => {
  const sourceWorkspaceDir = await createWorkspaceFixture('Import Demo');
  const targetRoot = await mkdtemp(join(tmpdir(), 'soloyakusha-workspace-archive-import-'));
  tempDirs.push(targetRoot);

  const { archive } = await exportWorkspaceArchive(sourceWorkspaceDir);
  const imported = await importWorkspaceArchive(copyArrayBuffer(archive.buffer), targetRoot);

  expect(imported.manifest.projectName).toBe('Import Demo');
  expect(imported.extractedFiles).toContain('Data/workspace-config.json');
  expect(await readFile(join(targetRoot, 'chapters', '001.txt'), 'utf8')).toBe('source text');
});

test('importWorkspaceArchive rejects unsupported archive versions', async () => {
  const zip = new JSZip();
  zip.file(
    'soloyakusha-workspace.json',
    JSON.stringify({
      archiveType: 'workspace',
      archiveVersion: 999,
      workspaceRoot: 'workspace',
      projectName: 'Broken',
      exportedAt: new Date().toISOString(),
      sourceDirectoryName: 'broken',
      workspaceSchemaVersion: 1,
      projectStateSchemaVersion: 1,
    }),
  );
  zip.file(
    'workspace/Data/workspace-config.json',
    JSON.stringify({
      schemaVersion: WORKSPACE_BOOTSTRAP_SCHEMA_VERSION,
      storage: 'sqlite',
      projectName: 'Broken',
      databasePath: 'Data/project.sqlite',
    }),
  );
  zip.file('workspace/Data/project.sqlite', 'not-a-real-db');

  const targetRoot = await mkdtemp(join(tmpdir(), 'soloyakusha-workspace-archive-bad-version-'));
  tempDirs.push(targetRoot);

  await expect(
    importWorkspaceArchive(
      copyArrayBuffer((await zip.generateAsync({ type: 'uint8array' })).buffer),
      targetRoot,
    ),
  ).rejects.toThrow('不支持的工作区归档版本');
});

test('importWorkspaceArchive rejects archives with unsupported workspace schema versions', async () => {
  const zip = new JSZip();
  zip.file(
    'soloyakusha-workspace.json',
    JSON.stringify({
      archiveType: 'workspace',
      archiveVersion: WORKSPACE_ARCHIVE_VERSION,
      workspaceRoot: 'workspace',
      projectName: 'Broken',
      exportedAt: new Date().toISOString(),
      sourceDirectoryName: 'broken',
      workspaceSchemaVersion: 2,
      projectStateSchemaVersion: 1,
    }),
  );
  zip.file(
    'workspace/Data/workspace-config.json',
    JSON.stringify({
      schemaVersion: 2,
      storage: 'sqlite',
      projectName: 'Broken',
      databasePath: 'Data/project.sqlite',
    }),
  );
  zip.file('workspace/Data/project.sqlite', 'not-a-real-db');

  const targetRoot = await mkdtemp(join(tmpdir(), 'soloyakusha-workspace-archive-bad-schema-'));
  tempDirs.push(targetRoot);

  await expect(
    importWorkspaceArchive(
      copyArrayBuffer((await zip.generateAsync({ type: 'uint8array' })).buffer),
      targetRoot,
    ),
  ).rejects.toThrow('不支持的工作区配置版本');
});

async function createWorkspaceFixture(projectName: string): Promise<string> {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'soloyakusha-workspace-archive-'));
  tempDirs.push(workspaceDir);

  await mkdir(join(workspaceDir, 'Data'), { recursive: true });
  await mkdir(join(workspaceDir, 'chapters'), { recursive: true });
  await new SqliteProjectStorage(join(workspaceDir, 'Data', 'project.sqlite')).saveWorkspaceConfig({
    schemaVersion: 1,
    projectName,
    chapters: [{ id: 1, filePath: 'chapters/001.txt' }],
    glossary: { path: 'Data/glossary.json', autoFilter: true },
    translator: {},
    slidingWindow: {},
    customRequirements: [],
  });
  await new SqliteProjectStorage(join(workspaceDir, 'Data', 'project.sqlite')).saveProjectState({
    schemaVersion: 1,
    pipeline: { stepIds: [], finalStepId: '' },
    lifecycle: { status: 'idle' },
  });
  await saveWorkspaceBootstrap(workspaceDir, buildWorkspaceBootstrapDocument(projectName));
  await writeFile(join(workspaceDir, 'chapters', '001.txt'), 'source text');

  return workspaceDir;
}

function copyArrayBuffer(buffer: ArrayBufferLike): ArrayBuffer {
  return Uint8Array.from(new Uint8Array(buffer)).buffer;
}
