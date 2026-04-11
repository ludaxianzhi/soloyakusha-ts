import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GlobalConfigManager } from '../../config/manager.ts';
import { ConfigService } from './config-service.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test('setVectorStore keeps config even when connection fails', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((async () => {
    throw new Error('connection refused');
  }) as unknown) as typeof fetch;

  try {
    const rootDir = await mkdtemp(join(tmpdir(), 'soloyakusha-config-service-'));
    tempDirs.push(rootDir);
    const manager = new GlobalConfigManager({
      filePath: join(rootDir, 'config.json'),
    });
    const service = new ConfigService({ manager });

    const result = await service.saveVectorStoreConfig({
      provider: 'qdrant',
      endpoint: 'http://localhost:6333',
      defaultCollection: 'chapters',
      distance: 'cosine',
      timeoutMs: 5_000,
      retries: 0,
    });

    expect(result.connection.state).toBe('error');
    expect(result.connection.error).toContain('Qdrant 连接检查失败');
    expect((await service.getVectorStoreConfig()).config).toMatchObject({
      provider: 'qdrant',
      endpoint: 'http://localhost:6333',
      defaultCollection: 'chapters',
    });

    const listed = await service.getVectorStoreConfig();
    expect(listed.status).toMatchObject({
      state: 'error',
      trigger: 'save',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('initializeVectorStoreConnections and manual connect update statuses without polling', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = ((async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return Response.json({ result: { collections: [] } });
  }) as unknown) as typeof fetch;

  try {
    const rootDir = await mkdtemp(join(tmpdir(), 'soloyakusha-config-service-'));
    tempDirs.push(rootDir);
    const manager = new GlobalConfigManager({
      filePath: join(rootDir, 'config.json'),
    });
    await manager.setVectorStore('memory', {
      provider: 'qdrant',
      endpoint: 'http://localhost:6333',
      defaultCollection: 'chapters',
      distance: 'cosine',
      timeoutMs: 5_000,
      retries: 0,
    });

    const service = new ConfigService({ manager });
    await service.initializeVectorStoreConnections();

    let listed = await service.getVectorStoreConfig();
    expect(listed.status).toMatchObject({
      state: 'connected',
      trigger: 'startup',
    });

    const manual = await service.connectVectorStoreConfig({
      config: {
        provider: 'qdrant',
        endpoint: 'http://localhost:6333',
        defaultCollection: 'chapters',
        distance: 'cosine',
        timeoutMs: 5_000,
        retries: 0,
      },
    });
    expect(manual).toMatchObject({
      state: 'connected',
      trigger: 'manual',
    });

    listed = await service.getVectorStoreConfig();
    expect(listed.status).toMatchObject({
      state: 'connected',
      trigger: 'manual',
    });
    expect(requests).toEqual([
      'http://localhost:6333/collections',
      'http://localhost:6333/collections',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
