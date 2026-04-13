import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GlobalConfigManager } from '../../config/manager.ts';
import { UsageStatsService } from './usage-stats-service.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('UsageStatsService aggregates model calls, tokens, and translated blocks', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'soloyakusha-usage-stats-'));
  tempDirs.push(rootDir);

  const manager = new GlobalConfigManager({
    filePath: join(rootDir, 'config', 'config.json'),
  });
  const service = new UsageStatsService({ manager });

  await service.recordLlmRequest({
    succeeded: true,
    workspaceContext: {
      projectName: 'Demo Project',
      workspaceDir: 'C:\\Workspaces\\Demo',
    },
    entry: {
      requestId: 'req-1',
      prompt: 'hello',
      response: 'world',
      meta: {
        label: 'Translate',
        feature: 'translation',
        operation: 'final',
        context: {
          sourceTextLength: 12,
        },
      },
      statistics: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      },
      modelName: 'demo-model',
    },
  });

  await service.recordLlmRequest({
    succeeded: false,
    workspaceContext: {
      projectName: 'Demo Project',
    },
    entry: {
      requestId: 'req-2',
      prompt: 'broken',
      errorMessage: 'boom',
      meta: {
        label: 'Translate',
        feature: 'translation',
        operation: 'final',
      },
    },
  });

  await service.recordTranslationBlock({
    sourceText: '原文',
    translatedText: '译文',
    chapterId: 1,
    fragmentIndex: 0,
    stepId: 'main',
    processorName: 'DefaultTranslationProcessor',
    workspaceContext: {
      projectName: 'Demo Project',
      workspaceDir: 'C:\\Workspaces\\Demo',
    },
  });

  const snapshot = await service.getSnapshot();
  expect(snapshot.summary).toEqual({
    translatedCharacters: 2,
    translatedBlocks: 1,
    modelCalls: 2,
    failedModelCalls: 1,
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
  });
  expect(snapshot.dailyPoints).toHaveLength(1);
  expect(snapshot.dailyPoints[0]?.translatedBlocks).toBe(1);
  expect(snapshot.dailyPoints[0]?.modelCalls).toBe(2);
});
