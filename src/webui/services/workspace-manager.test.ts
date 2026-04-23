import { afterEach, expect, test } from 'bun:test';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GlobalConfigManager } from '../../config/manager.ts';
import { WorkspaceRegistry } from '../../config/workspace-registry.ts';
import { SqliteProjectStorage } from '../../project/storage/sqlite-project-storage.ts';
import {
  buildWorkspaceBootstrapDocument,
  saveWorkspaceBootstrap,
} from '../../project/pipeline/translation-project-workspace.ts';
import { WorkspaceManager } from './workspace-manager.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test('WorkspaceManager lists managed SQLite workspaces discovered from workspace bootstrap', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'soloyakusha-workspace-manager-'));
  tempDirs.push(tempRoot);

  const baseDir = join(tempRoot, 'workspaces');
  const configPath = join(tempRoot, 'config.json');
  const registry = new WorkspaceRegistry(
    new GlobalConfigManager({ filePath: configPath }),
  );
  const manager = new WorkspaceManager(baseDir, registry);

  const workspaceDir = join(baseDir, 'demo-workspace');
  await mkdir(join(workspaceDir, 'Data'), { recursive: true });
  await new SqliteProjectStorage(join(workspaceDir, 'Data', 'project.sqlite')).saveWorkspaceConfig({
    schemaVersion: 1,
    projectName: 'Demo Project',
    chapters: [],
    glossary: {},
    translator: {},
    slidingWindow: {},
    customRequirements: [],
  });
  await saveWorkspaceBootstrap(workspaceDir, buildWorkspaceBootstrapDocument('Demo Project'));

  const workspaces = await manager.listWorkspaces();

  expect(workspaces).toHaveLength(1);
  expect(workspaces[0]).toMatchObject({
    name: 'Demo Project',
    dir: workspaceDir,
    managed: true,
  });
  expect(workspaces[0]?.lastOpenedAt).toBeString();
});

test('WorkspaceManager marks old JSON workspaces as deprecated for deletion', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'soloyakusha-workspace-manager-'));
  tempDirs.push(tempRoot);

  const baseDir = join(tempRoot, 'workspaces');
  const configPath = join(tempRoot, 'config.json');
  const registry = new WorkspaceRegistry(
    new GlobalConfigManager({ filePath: configPath }),
  );
  const manager = new WorkspaceManager(baseDir, registry);

  const workspaceDir = join(baseDir, 'legacy-workspace');
  await mkdir(join(workspaceDir, 'Data'), { recursive: true });
  await writeFile(
    join(workspaceDir, 'Data', 'workspace-config.json'),
    JSON.stringify({
      schemaVersion: 1,
      projectName: 'Legacy Project',
      chapters: [],
      glossary: {},
      translator: {},
      slidingWindow: {},
      customRequirements: [],
    }),
  );

  const workspaces = await manager.listWorkspaces();

  expect(workspaces).toHaveLength(1);
  expect(workspaces[0]).toMatchObject({
    name: 'Legacy Project',
    dir: workspaceDir,
    managed: true,
    deprecated: true,
  });
  expect(workspaces[0]?.deprecationMessage).toContain('请删除该旧工作区');
});

test('WorkspaceManager can import and export complete workspace archives', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'soloyakusha-workspace-manager-'));
  tempDirs.push(tempRoot);

  const baseDir = join(tempRoot, 'workspaces');
  const configPath = join(tempRoot, 'config.json');
  const registry = new WorkspaceRegistry(
    new GlobalConfigManager({ filePath: configPath }),
  );
  const manager = new WorkspaceManager(baseDir, registry);

  const sourceWorkspaceDir = join(tempRoot, 'source-workspace');
  await mkdir(join(sourceWorkspaceDir, 'Data'), { recursive: true });
  await mkdir(join(sourceWorkspaceDir, 'chapters'), { recursive: true });
  await new SqliteProjectStorage(join(sourceWorkspaceDir, 'Data', 'project.sqlite')).saveWorkspaceConfig({
    schemaVersion: 1,
    projectName: 'Roundtrip Workspace',
    chapters: [{ id: 1, filePath: 'chapters/001.txt' }],
    glossary: { path: 'Data/glossary.json', autoFilter: true },
    translator: {},
    slidingWindow: {},
    customRequirements: [],
  });
  await new SqliteProjectStorage(join(sourceWorkspaceDir, 'Data', 'project.sqlite')).saveProjectState({
    schemaVersion: 1,
    pipeline: { stepIds: [], finalStepId: '' },
    lifecycle: { status: 'idle' },
  });
  await saveWorkspaceBootstrap(
    sourceWorkspaceDir,
    buildWorkspaceBootstrapDocument('Roundtrip Workspace'),
  );
  await writeFile(join(sourceWorkspaceDir, 'chapters', '001.txt'), 'hello archive');

  const exported = await manager.exportWorkspaceArchive(sourceWorkspaceDir);
  const imported = await manager.importWorkspaceArchive(
    Uint8Array.from(new Uint8Array(exported.archive.buffer)).buffer,
  );

  expect(imported.manifest.projectName).toBe('Roundtrip Workspace');
  expect(imported.workspaceDir.startsWith(baseDir)).toBe(true);
  expect(await readFile(join(imported.workspaceDir, 'chapters', '001.txt'), 'utf8')).toBe(
    'hello archive',
  );
});

test('WorkspaceManager removes imported source files for external workspaces without deleting unrelated files', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'soloyakusha-workspace-manager-'));
  tempDirs.push(tempRoot);

  const baseDir = join(tempRoot, 'managed-workspaces');
  const configPath = join(tempRoot, 'config.json');
  const registry = new WorkspaceRegistry(
    new GlobalConfigManager({ filePath: configPath }),
  );
  const manager = new WorkspaceManager(baseDir, registry);

  const workspaceDir = join(tempRoot, 'external-workspace');
  const sourcePath = join(workspaceDir, 'sources', 'chapter-1.txt');
  const glossaryPath = join(workspaceDir, 'Data', 'glossary.json');
  const unrelatedFilePath = join(workspaceDir, 'keep-me.txt');
  await mkdir(join(workspaceDir, 'Data'), { recursive: true });
  await mkdir(join(workspaceDir, 'logs'), { recursive: true });
  await mkdir(join(workspaceDir, 'sources'), { recursive: true });
  await writeFile(sourcePath, 'chapter one');
  await writeFile(glossaryPath, '{}');
  await writeFile(unrelatedFilePath, 'preserve');
  await new SqliteProjectStorage(join(workspaceDir, 'Data', 'project.sqlite')).saveWorkspaceConfig({
    schemaVersion: 1,
    projectName: 'External Workspace',
    chapters: [{ id: 1, filePath: 'sources/chapter-1.txt' }],
    glossary: { path: 'Data/glossary.json', autoFilter: true },
    translator: {},
    slidingWindow: {},
    customRequirements: [],
  });
  await saveWorkspaceBootstrap(
    workspaceDir,
    buildWorkspaceBootstrapDocument('External Workspace'),
  );

  await manager.removeWorkspace(workspaceDir);

  expect(await pathExists(join(workspaceDir, 'Data'))).toBe(false);
  expect(await pathExists(join(workspaceDir, 'logs'))).toBe(false);
  expect(await pathExists(sourcePath)).toBe(false);
  expect(await readFile(unrelatedFilePath, 'utf8')).toBe('preserve');
});

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
