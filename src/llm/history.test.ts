import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FileRequestHistoryLogger,
  readHistoryDetailFromLogDir,
  readHistoryDigestFromLogDir,
  readHistoryEntriesFromLogDir,
  readHistoryPageFromLogDir,
} from './history.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test('FileRequestHistoryLogger persists structured SQLite history entries', async () => {
  const logDir = await mkdtemp(join(tmpdir(), 'soloyakusha-history-'));
  tempDirs.push(logDir);

  const logger = new FileRequestHistoryLogger(logDir, 'plot_summary_requests');
  await logger.logCompletion({
    requestId: 'req-1',
    prompt: 'user prompt',
    response: 'assistant response',
    modelName: 'gpt-test',
    durationSeconds: 1.25,
    requestConfig: {
      systemPrompt: 'system prompt',
      temperature: 0.3,
      maxTokens: 2048,
      topP: 0.9,
    },
    meta: {
      label: '情节总结',
      feature: '情节总结',
      operation: '批次总结',
      component: 'PlotSummarizer',
      context: {
        chapterId: 3,
        startFragmentIndex: 10,
      },
    },
    statistics: {
      promptTokens: 12,
      completionTokens: 34,
      totalTokens: 46,
    },
    reasoning: '先分析，再回答',
  });
  await logger.logError({
    requestId: 'req-2',
    prompt: 'failed prompt',
    errorMessage: 'rate limited',
    responseBody: '{"error":"slow down"}',
    modelName: 'gpt-test',
    meta: {
      label: '情节总结',
      feature: '情节总结',
      operation: '批次总结',
    },
  });

  const entries = await readHistoryEntriesFromLogDir(logDir);

  expect(entries).toHaveLength(2);
  expect(entries[0]).toMatchObject({
    type: 'error',
    source: 'plot_summary_requests',
    requestId: 'req-2',
    errorMessage: 'rate limited',
  });
  expect(entries[1]).toMatchObject({
    type: 'completion',
    source: 'plot_summary_requests',
    requestId: 'req-1',
    prompt: 'user prompt',
    response: 'assistant response',
    requestConfig: {
      systemPrompt: 'system prompt',
      temperature: 0.3,
      maxTokens: 2048,
      topP: 0.9,
    },
    meta: {
      label: '情节总结',
      feature: '情节总结',
      operation: '批次总结',
      component: 'PlotSummarizer',
      context: {
        chapterId: 3,
        startFragmentIndex: 10,
      },
    },
    statistics: {
      promptTokens: 12,
      completionTokens: 34,
      totalTokens: 46,
    },
    reasoning: '先分析，再回答',
  });
});

test('history helpers expose digest, paged summaries, and detail records', async () => {
  const logDir = await mkdtemp(join(tmpdir(), 'soloyakusha-history-page-'));
  tempDirs.push(logDir);

  const logger = new FileRequestHistoryLogger(logDir, 'translation_requests');
  for (const requestId of ['req-1', 'req-2', 'req-3']) {
    await logger.logCompletion({
      requestId,
      prompt: `prompt ${requestId}`,
      response: `response ${requestId}`,
      modelName: 'gpt-test',
      meta: {
        label: '批量翻译',
        feature: '翻译',
        operation: '章节处理',
      },
    });
  }

  const digest = await readHistoryDigestFromLogDir(logDir);
  expect(digest).toMatchObject({
    total: 3,
    latestId: 3,
  });

  const firstPage = await readHistoryPageFromLogDir(logDir, { limit: 2 });
  expect(firstPage.items.map((item) => item.requestId)).toEqual(['req-3', 'req-2']);
  expect(firstPage.items[0]).not.toHaveProperty('prompt');
  expect(firstPage.nextBeforeId).toBe(2);

  const secondPage = await readHistoryPageFromLogDir(logDir, {
    limit: 2,
    beforeId: firstPage.nextBeforeId,
  });
  expect(secondPage.items.map((item) => item.requestId)).toEqual(['req-1']);

  const detail = await readHistoryDetailFromLogDir(logDir, firstPage.items[0]!.id);
  expect(detail).toMatchObject({
    id: firstPage.items[0]!.id,
    requestId: 'req-3',
    prompt: 'prompt req-3',
    response: 'response req-3',
  });
});
