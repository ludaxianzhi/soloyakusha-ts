import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GlobalConfigManager } from '../../config/manager.ts';
import { RequestHistoryService } from './request-history-service.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('RequestHistoryService persists entries in a global store with workspace context', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'soloyakusha-request-history-'));
  tempDirs.push(rootDir);

  const manager = new GlobalConfigManager({
    filePath: join(rootDir, 'config', 'config.json'),
  });
  const service = new RequestHistoryService({ manager });
  const logger = service.createLogger('unit-test', {
    projectName: 'Demo Project',
    workspaceDir: 'C:\\Workspaces\\Demo',
  });

  await logger.logCompletion({
    requestId: 'req-1',
    prompt: 'hello',
    response: 'world',
    meta: {
      label: 'Test Request',
      feature: 'tests',
      operation: 'completion',
      context: {
        chapterId: 1,
      },
    },
    statistics: {
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
    },
    modelName: 'demo-model',
  });

  const digest = await service.getDigest();
  expect(digest.total).toBe(1);

  const page = await service.getPage({ limit: 10 });
  expect(page.items).toHaveLength(1);
  expect(page.items[0]?.source).toBe('unit-test');
  expect(page.items[0]?.meta?.context).toMatchObject({
    chapterId: 1,
    projectName: 'Demo Project',
    workspaceDir: 'C:\\Workspaces\\Demo',
  });

  const detail = await service.getDetail(page.items[0]!.id);
  expect(detail?.response).toBe('world');

  const exported = await service.exportPrettyJson();
  expect(exported).toContain('"projectName": "Demo Project"');
  expect(exported).toContain('"workspaceDir": "C:\\\\Workspaces\\\\Demo"');
});

test('RequestHistoryService deletes entries and can clear the global store', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'soloyakusha-request-history-'));
  tempDirs.push(rootDir);

  const manager = new GlobalConfigManager({
    filePath: join(rootDir, 'config', 'config.json'),
  });
  const service = new RequestHistoryService({ manager });
  const logger = service.createLogger('unit-test', {
    projectName: 'Demo Project',
  });

  await logger.logError({
    requestId: 'req-1',
    prompt: 'broken',
    errorMessage: 'boom',
    meta: {
      label: 'Broken Request',
      feature: 'tests',
      operation: 'error',
    },
  });
  await logger.logCompletion({
    requestId: 'req-2',
    prompt: 'hello',
    response: 'world',
    meta: {
      label: 'Healthy Request',
      feature: 'tests',
      operation: 'completion',
    },
  });

  const firstPage = await service.getPage({ limit: 10 });
  expect(firstPage.items).toHaveLength(2);

  const deleted = await service.deleteEntry(firstPage.items[0]!.id);
  expect(deleted).toBe(true);
  expect((await service.getDigest()).total).toBe(1);

  const deletedCount = await service.clear();
  expect(deletedCount).toBe(1);
  expect(await service.getDigest()).toEqual({
    total: 0,
    latestId: 0,
  });
});
