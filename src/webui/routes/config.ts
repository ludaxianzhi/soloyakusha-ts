/**
 * 全局配置 REST API：LLM Profile、翻译器、辅助功能配置。
 */

import { Hono } from 'hono';
import type { ConfigService } from '../services/config-service.ts';

export function createConfigRoutes(configService: ConfigService): Hono {
  const app = new Hono();

  // ─── LLM Profiles ──────────────────────────────

  app.get('/llm', async (c) => {
    const { names, defaultName } = await configService.listLlmProfiles();
    const profiles: Record<string, unknown> = {};
    for (const name of names) {
      profiles[name] = await configService.getLlmProfile(name);
    }
    return c.json({ profiles, defaultName });
  });

  app.get('/llm/:name', async (c) => {
    const profile = await configService.getLlmProfile(c.req.param('name'));
    if (!profile) return c.json({ error: '未找到' }, 404);
    return c.json(profile);
  });

  app.put('/llm/:name', async (c) => {
    const body = await c.req.json();
    await configService.setLlmProfile(c.req.param('name'), body);
    return c.json({ ok: true });
  });

  app.delete('/llm/:name', async (c) => {
    const removed = await configService.removeLlmProfile(c.req.param('name'));
    return c.json({ ok: removed });
  });

  app.put('/llm-default', async (c) => {
    const body = await c.req.json<{ name?: string }>();
    await configService.setDefaultLlmProfile(body.name);
    return c.json({ ok: true });
  });

  // ─── Embedding ──────────────────────────────────

  app.get('/embedding', async (c) => {
    const config = await configService.getEmbeddingConfig();
    return c.json(config ?? null);
  });

  app.put('/embedding', async (c) => {
    const body = await c.req.json();
    await configService.setEmbeddingConfig(body);
    return c.json({ ok: true });
  });

  app.post('/embedding/pca/upload', async (c) => {
    const formData = await c.req.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) {
      return c.json({ error: '缺少文件字段 file' }, 400);
    }

    const content = new Uint8Array(await file.arrayBuffer());
    const result = await configService.uploadEmbeddingPcaWeights({
      fileName: file.name,
      content,
    });
    return c.json(result);
  });

  // ─── Vector Stores ───────────────────────────────

  app.get('/vector', async (c) => {
    const result = await configService.getVectorStoreConfig();
    return c.json(result);
  });

  app.put('/vector', async (c) => {
    const body = await c.req.json();
    const result = await configService.saveVectorStoreConfig(body);
    return c.json({ ok: true, connection: result.connection });
  });

  app.delete('/vector', async (c) => {
    const removed = await configService.clearVectorStoreConfig();
    return c.json({ ok: removed });
  });

  app.post('/vector/connect', async (c) => {
    const body = await c.req.json<{
      config?: unknown;
    }>();
    const connection = await configService.connectVectorStoreConfig({
      config: body.config as Parameters<ConfigService['saveVectorStoreConfig']>[0],
    });
    return c.json({ ok: true, connection });
  });

  // ─── Translators ────────────────────────────────

  app.get('/translators', async (c) => {
    const { names } = await configService.listTranslators();
    const translators: Record<string, unknown> = {};
    for (const name of names) {
      translators[name] = await configService.getTranslator(name);
    }
    return c.json({ translators });
  });

  app.get('/translator-workflows', (c) => {
    return c.json({ workflows: configService.listTranslatorWorkflows() });
  });

  app.get('/proofread-workflows', (c) => {
    return c.json({ workflows: configService.listProofreadProcessorWorkflows() });
  });

  app.get('/translators/:name', async (c) => {
    const translator = await configService.getTranslator(c.req.param('name'));
    if (!translator) return c.json({ error: '未找到' }, 404);
    return c.json(translator);
  });

  app.put('/translators/:name', async (c) => {
    const body = await c.req.json();
    await configService.setTranslator(c.req.param('name'), body);
    return c.json({ ok: true });
  });

  app.delete('/translators/:name', async (c) => {
    const removed = await configService.removeTranslator(
      c.req.param('name'),
    );
    return c.json({ ok: removed });
  });

  app.get('/proofread-processor', async (c) => {
    return c.json((await configService.getProofreadProcessorConfig()) ?? null);
  });

  app.put('/proofread-processor', async (c) => {
    const body = await c.req.json();
    await configService.setProofreadProcessorConfig(body);
    return c.json({ ok: true });
  });

  // ─── Auxiliary ──────────────────────────────────

  app.get('/auxiliary/glossary-extractor', async (c) => {
    return c.json(
      (await configService.getGlossaryExtractorConfig()) ?? null,
    );
  });

  app.put('/auxiliary/glossary-extractor', async (c) => {
    const body = await c.req.json();
    await configService.setGlossaryExtractorConfig(body);
    return c.json({ ok: true });
  });

  app.get('/auxiliary/glossary-updater', async (c) => {
    return c.json(
      (await configService.getGlossaryUpdaterConfig()) ?? null,
    );
  });

  app.put('/auxiliary/glossary-updater', async (c) => {
    const body = await c.req.json();
    await configService.setGlossaryUpdaterConfig(body);
    return c.json({ ok: true });
  });

  app.get('/auxiliary/plot-summary', async (c) => {
    return c.json((await configService.getPlotSummaryConfig()) ?? null);
  });

  app.put('/auxiliary/plot-summary', async (c) => {
    const body = await c.req.json();
    await configService.setPlotSummaryConfig(body);
    return c.json({ ok: true });
  });

  app.get('/auxiliary/alignment-repair', async (c) => {
    return c.json(
      (await configService.getAlignmentRepairConfig()) ?? null,
    );
  });

  app.put('/auxiliary/alignment-repair', async (c) => {
    const body = await c.req.json();
    await configService.setAlignmentRepairConfig(body);
    return c.json({ ok: true });
  });

  return app;
}
