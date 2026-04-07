import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FileRequestHistoryLogger,
  readHistoryEntriesFromLogDir,
} from './history.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test('FileRequestHistoryLogger persists structured JSONL history entries', async () => {
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
    statistics: {
      promptTokens: 12,
      completionTokens: 34,
      totalTokens: 46,
    },
  });
  await logger.logError({
    requestId: 'req-2',
    prompt: 'failed prompt',
    errorMessage: 'rate limited',
    responseBody: '{"error":"slow down"}',
    modelName: 'gpt-test',
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
    statistics: {
      promptTokens: 12,
      completionTokens: 34,
      totalTokens: 46,
    },
  });
});
