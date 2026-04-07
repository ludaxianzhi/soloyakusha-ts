import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
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
