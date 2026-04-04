import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GlobalConfigManager,
  getDefaultGlobalConfigFilePath,
} from "./manager.ts";
import {
  normalizePersistedLlmClientConfig,
  normalizeTranslationProcessorConfig,
} from "./document-codec.ts";
import { TranslationGlobalConfig } from "../project/config.ts";

const cleanupTargets: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupTargets.splice(0, cleanupTargets.length).map((target) =>
      rm(target, { recursive: true, force: true }),
    ),
  );
});

describe("getDefaultGlobalConfigFilePath", () => {
  test("uses the user home directory", () => {
    const filePath = getDefaultGlobalConfigFilePath().replace(/\\/g, "/");
    expect(filePath).toEndWith(".soloyakusha-ts/config.json");
  });
});

describe("GlobalConfigManager", () => {
  test("persists llm profiles and reloads them", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "soloyakusha-global-config-"));
    cleanupTargets.push(rootDir);

    const filePath = join(rootDir, "config", "settings.json");
    const manager = new GlobalConfigManager({ filePath });

    await manager.setLlmProfile("writer", {
      provider: "openai",
      modelType: "chat",
      modelName: "gpt-4.1",
      endpoint: "https://example.com/v1",
      apiKey: "secret",
      retries: 5,
      defaultRequestConfig: {
        temperature: 0.2,
        extraBody: {
          response_format: "json_schema",
        },
      },
    });
    await manager.setDefaultLlmProfileName("writer");

    const reloaded = new GlobalConfigManager({ filePath });
    const profile = await reloaded.getRequiredLlmProfile("writer");

    expect(await reloaded.getDefaultLlmProfileName()).toBe("writer");
    expect(await reloaded.listLlmProfileNames()).toEqual(["writer"]);
    expect(profile).toEqual({
      provider: "openai",
      modelType: "chat",
      modelName: "gpt-4.1",
      endpoint: "https://example.com/v1",
      apiKey: "secret",
      retries: 5,
      qps: undefined,
      maxParallelRequests: undefined,
      apiKeyEnv: undefined,
      defaultRequestConfig: {
        systemPrompt: undefined,
        temperature: 0.2,
        maxTokens: undefined,
        topP: undefined,
        extraBody: {
          response_format: "json_schema",
        },
      },
    });

    const saved = JSON.parse(await readFile(filePath, "utf8")) as {
      version: number;
      llm: { defaultProfileName?: string };
    };
    expect(saved.version).toBe(1);
    expect(saved.llm.defaultProfileName).toBe("writer");
  });

  test("updates and removes llm profiles through api", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "soloyakusha-global-config-"));
    cleanupTargets.push(rootDir);

    const filePath = join(rootDir, "settings.json");
    const manager = new GlobalConfigManager({ filePath });

    await manager.setLlmProfile("writer", {
      provider: "openai",
      modelType: "chat",
      modelName: "gpt-4.1-mini",
      endpoint: "https://example.com/v1",
      apiKey: "secret",
      retries: 3,
    });
    await manager.setDefaultLlmProfileName("writer");

    const updated = await manager.updateLlmProfile("writer", (current) => ({
      ...current,
      modelName: "gpt-4.1",
      defaultRequestConfig: {
        systemPrompt: "system",
        maxTokens: 1024,
      },
    }));

    expect(updated.modelName).toBe("gpt-4.1");
    expect(updated.defaultRequestConfig).toEqual({
      systemPrompt: "system",
      temperature: undefined,
      maxTokens: 1024,
      topP: undefined,
      extraBody: undefined,
    });

    expect(await manager.removeLlmProfile("writer")).toBe(true);
    expect(await manager.getDefaultLlmProfileName()).toBeUndefined();
    expect(await manager.listLlmProfileNames()).toEqual([]);
    expect(await manager.removeLlmProfile("writer")).toBe(false);
  });

  test("accepts snake_case aliases in default request config", () => {
    const normalized = normalizePersistedLlmClientConfig(
      {
        provider: "openai",
        modelType: "chat",
        modelName: "gpt-4.1",
        endpoint: "https://example.com/v1",
        apiKey: "secret",
        retries: 3,
        defaultRequestConfig: {
          system_prompt: "system",
          top_p: 0.8,
          max_tokens: 2048,
          extra_body: {
            chat_template_kwargs: {
              enable_thinking: false,
            },
          },
        },
      },
      "llm.profiles.writer",
    );

    expect(normalized.defaultRequestConfig).toEqual({
      systemPrompt: "system",
      temperature: undefined,
      topP: 0.8,
      maxTokens: 2048,
      extraBody: {
        chat_template_kwargs: {
          enable_thinking: false,
        },
      },
    });
  });

  test("accepts snake_case aliases in sparse request config", () => {
    const normalized = normalizeTranslationProcessorConfig(
      {
        modelName: "translator",
        requestOptions: {
          requestConfig: {
            top_p: 0.9,
            max_tokens: 1024,
            extra_body: {
              response_format: {
                type: "json_schema",
              },
            },
          },
        },
      },
      "translation.translationProcessor",
    );

    expect(normalized.requestOptions).toEqual({
      requestConfig: {
        topP: 0.9,
        maxTokens: 1024,
        extraBody: {
          response_format: {
            type: "json_schema",
          },
        },
      },
      outputValidationContext: undefined,
    });
  });

  test("resolves env-based llm profile to runtime config", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "soloyakusha-global-config-"));
    cleanupTargets.push(rootDir);

    process.env.SOLOYAKUSHA_GLOBAL_TEST_KEY = "env-secret";

    const manager = new GlobalConfigManager({
      filePath: join(rootDir, "settings.json"),
    });

    await manager.setEmbeddingConfig({
      provider: "openai",
      modelType: "embedding",
      modelName: "text-embedding-3-small",
      endpoint: "https://example.com/v1",
      apiKeyEnv: "SOLOYAKUSHA_GLOBAL_TEST_KEY",
      retries: 3,
    });

    const resolved = await manager.getResolvedEmbeddingConfig();
    expect(resolved.apiKey).toBe("env-secret");
    expect(resolved.modelType).toBe("embedding");

    delete process.env.SOLOYAKUSHA_GLOBAL_TEST_KEY;
  });

  test("persists embedding and feature configs in global file", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "soloyakusha-global-config-"));
    cleanupTargets.push(rootDir);

    const filePath = join(rootDir, "settings.json");
    const manager = new GlobalConfigManager({ filePath });

    await manager.setLlmProfile("translator", {
      provider: "openai",
      modelType: "chat",
      modelName: "gpt-4.1",
      endpoint: "https://example.com/v1",
      apiKey: "secret",
      retries: 3,
    });
    await manager.setLlmProfile("glossary", {
      provider: "openai",
      modelType: "chat",
      modelName: "gpt-4.1-mini",
      endpoint: "https://example.com/v1",
      apiKey: "secret",
      retries: 3,
    });
    await manager.setLlmProfile("summary", {
      provider: "openai",
      modelType: "chat",
      modelName: "gpt-4.1-nano",
      endpoint: "https://example.com/v1",
      apiKey: "secret",
      retries: 3,
    });
    await manager.setEmbeddingConfig({
      provider: "openai",
      modelType: "embedding",
      modelName: "text-embedding-3-small",
      endpoint: "https://example.com/v1",
      apiKey: "secret",
      retries: 3,
    });

    await manager.setTranslationProcessorConfig({
      modelName: "translator",
      slidingWindow: { overlapChars: 12 },
      requestOptions: {
        requestConfig: {
          temperature: 0.2,
          maxTokens: 1234,
        },
      },
    });
    await manager.setGlossaryExtractorConfig({
      modelName: "glossary",
      maxCharsPerBatch: 4096,
      occurrenceTopK: 128,
      occurrenceTopP: 0.25,
    });
    await manager.setGlossaryUpdaterConfig({
      modelName: "glossary",
      requestOptions: {
        requestConfig: {
          topP: 0.4,
        },
      },
    });
    await manager.setPlotSummaryConfig({
      modelName: "summary",
      fragmentsPerBatch: 8,
      maxContextSummaries: 10,
    });

    const reloaded = new GlobalConfigManager({ filePath });
    expect(await reloaded.getEmbeddingConfig()).toEqual({
      provider: "openai",
      modelType: "embedding",
      modelName: "text-embedding-3-small",
      endpoint: "https://example.com/v1",
      apiKey: "secret",
      retries: 3,
      qps: undefined,
      maxParallelRequests: undefined,
      apiKeyEnv: undefined,
      defaultRequestConfig: undefined,
    });
    expect(await reloaded.getTranslationProcessorConfig()).toEqual({
      modelName: "translator",
      workflow: undefined,
      slidingWindow: { overlapChars: 12 },
      requestOptions: {
        requestConfig: {
          temperature: 0.2,
          maxTokens: 1234,
        },
        outputValidationContext: undefined,
      },
    });
    expect(await reloaded.getGlossaryExtractorConfig()).toEqual({
      modelName: "glossary",
      maxCharsPerBatch: 4096,
      occurrenceTopK: 128,
      occurrenceTopP: 0.25,
      requestOptions: undefined,
    });
    expect(await reloaded.getGlossaryUpdaterConfig()).toEqual({
      modelName: "glossary",
      workflow: undefined,
      requestOptions: {
        requestConfig: {
          topP: 0.4,
        },
        outputValidationContext: undefined,
      },
    });
    expect(await reloaded.getPlotSummaryConfig()).toEqual({
      modelName: "summary",
      fragmentsPerBatch: 8,
      maxContextSummaries: 10,
      requestOptions: undefined,
    });

    const translationGlobalConfig = await reloaded.getTranslationGlobalConfig();
    expect(translationGlobalConfig).toBeInstanceOf(TranslationGlobalConfig);
    expect(translationGlobalConfig.getTranslationProcessorConfig().modelName).toBe("translator");
    expect(translationGlobalConfig.getEmbeddingConfig()?.modelName).toBe("text-embedding-3-small");
    expect(translationGlobalConfig.getGlossaryExtractorConfig()).toMatchObject({
      modelName: "glossary",
      occurrenceTopK: 128,
      occurrenceTopP: 0.25,
    });
    expect(translationGlobalConfig.getGlossaryUpdaterConfig()?.modelName).toBe("glossary");
    expect(translationGlobalConfig.getPlotSummaryConfig()?.modelName).toBe("summary");

    const saved = JSON.parse(await readFile(filePath, "utf8")) as {
      llm?: {
        embedding?: { modelName: string };
      };
      translation?: {
        translationProcessor?: { modelName: string };
        glossaryExtractor?: {
          modelName: string;
          occurrenceTopK?: number;
          occurrenceTopP?: number;
        };
        glossaryUpdater?: { modelName: string };
        plotSummary?: { modelName: string };
      };
    };
    expect(saved.llm?.embedding?.modelName).toBe("text-embedding-3-small");
    expect(saved.translation?.translationProcessor?.modelName).toBe("translator");
    expect(saved.translation?.glossaryExtractor?.modelName).toBe("glossary");
    expect(saved.translation?.glossaryExtractor?.occurrenceTopK).toBe(128);
    expect(saved.translation?.glossaryExtractor?.occurrenceTopP).toBe(0.25);
    expect(saved.translation?.glossaryUpdater?.modelName).toBe("glossary");
    expect(saved.translation?.plotSummary?.modelName).toBe("summary");
  });
});
