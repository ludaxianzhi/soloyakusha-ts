import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

test('uploadEmbeddingPcaWeights stores json under user config directory', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'soloyakusha-config-service-'));
  tempDirs.push(rootDir);
  const manager = new GlobalConfigManager({
    filePath: join(rootDir, 'config.json'),
  });
  const service = new ConfigService({ manager });

  const componentsBase64 = Buffer.from(
    new Uint8Array(new Float32Array([1, 0]).buffer),
  ).toString('base64');
  const meanBase64 = Buffer.from(
    new Uint8Array(new Float32Array([0, 0]).buffer),
  ).toString('base64');

  const payload = JSON.stringify({
    pca: {
      target_dim: 1,
      input_dim: 2,
      components: {
        dtype: 'float32',
        shape: [1, 2],
        data: componentsBase64,
      },
      mean: {
        dtype: 'float32',
        shape: [2],
        data: meanBase64,
      },
    },
  });

  const result = await service.uploadEmbeddingPcaWeights({
    fileName: 'weights.json',
    content: new TextEncoder().encode(payload),
  });

  expect(result.filePath).toContain('pca-weights');
  expect(result.filePath).toContain(rootDir);
  const saved = await readFile(result.filePath, 'utf8');
  expect(JSON.parse(saved)).toMatchObject({
    pca: {
      target_dim: 1,
      input_dim: 2,
    },
  });
});

test('proofread processor config can be listed and persisted', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'soloyakusha-config-service-'));
  tempDirs.push(rootDir);
  const manager = new GlobalConfigManager({
    filePath: join(rootDir, 'config.json'),
  });
  const service = new ConfigService({ manager });

  expect(service.listProofreadProcessorWorkflows()).toContainEqual(
    expect.objectContaining({ workflow: 'proofread-multi-stage' }),
  );

  await service.setProofreadProcessorConfig({
    workflow: 'proofread-multi-stage',
    modelNames: ['editor-primary'],
    reviewIterations: 2,
    steps: {
      editor: {
        modelNames: ['editor-primary'],
      },
      proofreader: {
        modelNames: ['proofreader-primary'],
      },
      reviser: {
        modelNames: ['reviser-primary'],
      },
    },
  });

  expect(await service.getProofreadProcessorConfig()).toEqual({
    workflow: 'proofread-multi-stage',
    modelNames: ['editor-primary'],
    reviewIterations: 2,
    steps: {
      editor: {
        modelNames: ['editor-primary'],
      },
      proofreader: {
        modelNames: ['proofreader-primary'],
      },
      reviser: {
        modelNames: ['reviser-primary'],
      },
    },
  });
});
