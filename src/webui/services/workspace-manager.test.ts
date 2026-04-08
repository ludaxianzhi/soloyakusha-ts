import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GlobalConfigManager } from '../../config/manager.ts';
import { WorkspaceRegistry } from '../../config/workspace-registry.ts';
import { WorkspaceManager } from './workspace-manager.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test('WorkspaceManager lists managed workspaces discovered from workspace config', async () => {
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
  await Bun.write(
    join(workspaceDir, 'Data', 'workspace-config.json'),
    JSON.stringify({
      projectName: 'Demo Project',
      chapters: [],
      glossary: {},
      translator: {},
      customRequirements: [],
    }),
  );

  const workspaces = await manager.listWorkspaces();

  expect(workspaces).toHaveLength(1);
  expect(workspaces[0]).toMatchObject({
    name: 'Demo Project',
    dir: workspaceDir,
    managed: true,
  });
  expect(workspaces[0]?.lastOpenedAt).toBeString();
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
  await writeFile(
    join(sourceWorkspaceDir, 'Data', 'workspace-config.json'),
    JSON.stringify({
      schemaVersion: 1,
      projectName: 'Roundtrip Workspace',
      chapters: [{ id: 1, filePath: 'chapters/001.txt' }],
      glossary: { path: 'Data/glossary.json', autoFilter: true },
      translator: {},
      slidingWindow: {},
      customRequirements: [],
    }),
  );
  await writeFile(
    join(sourceWorkspaceDir, 'Data', 'project-state.json'),
    JSON.stringify({
      schemaVersion: 1,
      pipeline: { stepIds: [], finalStepId: '' },
      lifecycle: { status: 'idle' },
    }),
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
