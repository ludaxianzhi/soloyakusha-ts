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
      supportsStructuredOutput: true,
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
      supportsStructuredOutput: true,
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
      supportsStructuredOutput: false,
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
        supportsStructuredOutput: true,
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
    expect(normalized.supportsStructuredOutput).toBe(true);
  });

  test("accepts snake_case aliases in sparse request config", () => {
    const normalized = normalizeTranslationProcessorConfig(
      {
        modelNames: ["translator"],
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

  test("accepts multi-stage step configs with per-step request options", () => {
    const normalized = normalizeTranslationProcessorConfig(
      {
        modelNames: ["fallback-chat"],
        steps: {
          analyzer: {
            modelNames: ["analysis-chat", "analysis-fallback"],
            requestOptions: {
              requestConfig: {
                temperature: 0.15,
              },
            },
          },
          translator: {
            modelName: "translator-chat",
            requestOptions: {
              requestConfig: {
                top_p: 0.75,
              },
            },
          },
        },
      },
      "translation.translationProcessor",
    );

    expect(normalized.steps).toMatchObject({
      analyzer: {
        modelNames: ["analysis-chat", "analysis-fallback"],
        requestOptions: {
          requestConfig: {
            temperature: 0.15,
          },
        },
      },
      translator: {
        modelNames: ["translator-chat"],
        requestOptions: {
          requestConfig: {
            topP: 0.75,
          },
        },
      },
    });
  });

  test("migrates legacy multi-stage workflow and reviser step to style-transfer", () => {
    const normalized = normalizeTranslationProcessorConfig(
      {
        workflow: "multi-stage",
        modelNames: ["fallback-chat"],
        steps: {
          analyzer: {
            modelNames: ["analysis-chat"],
          },
          translator: {
            modelNames: ["translator-chat"],
          },
          reviser: {
            modelNames: ["style-chat"],
            requestOptions: {
              requestConfig: {
                system_prompt: "keep style",
              },
            },
          },
        },
      },
      "translation.translationProcessor",
    );

    expect(normalized.workflow).toBe("style-transfer");
    expect(normalized.steps).toEqual({
      analyzer: {
        modelNames: ["analysis-chat"],
        requestOptions: undefined,
      },
      translator: {
        modelNames: ["translator-chat"],
        requestOptions: undefined,
      },
      styleTransfer: {
        modelNames: ["style-chat"],
        requestOptions: {
          requestConfig: {
            systemPrompt: "keep style",
          },
          outputValidationContext: undefined,
        },
      },
    });
  });

  test("accepts legacy single modelName fields when reading existing translation config", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "soloyakusha-global-config-legacy-"));
    cleanupTargets.push(rootDir);

    const filePath = join(rootDir, "settings.json");
    await Bun.write(
      filePath,
      JSON.stringify(
        {
          version: 1,
          llm: {
            profiles: {},
          },
          translation: {
            translators: {
              default: {
                type: "default",
                modelName: "legacy-chat",
              },
            },
            glossaryExtractor: {
              modelName: "legacy-chat",
              maxCharsPerBatch: 100,
            },
            glossaryUpdater: {
              modelName: "legacy-chat",
            },
            plotSummary: {
              modelName: "legacy-chat",
              fragmentsPerBatch: 2,
            },
            alignmentRepair: {
              modelName: "legacy-chat",
            },
          },
        },
        null,
        2,
      ),
    );

    const manager = new GlobalConfigManager({ filePath });
    await manager.setLlmProfile("writer", {
      provider: "openai",
      modelType: "chat",
      modelName: "gpt-4.1",
      endpoint: "https://example.com/v1",
      apiKey: "secret",
      retries: 3,
    });

    expect(await manager.getTranslator("default")).toMatchObject({
      sourceLanguage: "ja",
      targetLanguage: "zh-CN",
      promptSet: "ja-zhCN",
      modelNames: ["legacy-chat"],
    });
    expect(await manager.getGlossaryExtractorConfig()).toMatchObject({
      modelNames: ["legacy-chat"],
    });
    expect(await manager.getGlossaryUpdaterConfig()).toMatchObject({
      modelNames: ["legacy-chat"],
    });
    expect(await manager.getPlotSummaryConfig()).toMatchObject({
      modelNames: ["legacy-chat"],
    });
    expect(await manager.getAlignmentRepairConfig()).toMatchObject({
      modelNames: ["legacy-chat"],
    });
  });

  test("synthesizes multi-stage steps from legacy overrides", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "soloyakusha-global-config-legacy-"));
    cleanupTargets.push(rootDir);

    const filePath = join(rootDir, "settings.json");
    await Bun.write(
      filePath,
      JSON.stringify(
        {
          version: 1,
          llm: {
            profiles: {},
          },
          translation: {
            translators: {
              multi: {
                type: "multi-stage",
                modelNames: ["shared-chat"],
                models: {
                  analyzer: "analysis-chat",
                  translator: "translate-chat",
                },
                requestOptions: {
                  requestConfig: {
                    temperature: 0.3,
                  },
                },
              },
            },
          },
        },
        null,
        2,
      ),
    );

    const manager = new GlobalConfigManager({ filePath });
    const translator = await manager.getTranslator("multi");

    expect(translator?.steps).toMatchObject({
      analyzer: {
        modelNames: ["analysis-chat"],
        requestOptions: {
          requestConfig: {
            temperature: 0.3,
          },
        },
      },
      translator: {
        modelNames: ["translate-chat"],
        requestOptions: {
          requestConfig: {
            temperature: 0.3,
          },
        },
      },
      styleTransfer: {
        modelNames: ["shared-chat"],
        requestOptions: {
          requestConfig: {
            temperature: 0.3,
          },
        },
      },
    });
  });

  test("resolves env-based llm profile to runtime config", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "soloyakusha-global-config-"));
    cleanupTargets.push(rootDir);

    process.env.SOLOYAKUSHA_GLOBAL_TEST_KEY = "env-secret";
    process.env.SOLOYAKUSHA_VECTOR_TEST_KEY = "vector-env-secret";

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

    await manager.setVectorStore("memory", {
      provider: "qdrant",
      endpoint: "https://vector.example.com",
      apiKeyEnv: "SOLOYAKUSHA_VECTOR_TEST_KEY",
      defaultCollection: "chapters",
      distance: "cosine",
      timeoutMs: 15_000,
      retries: 4,
    });

    const resolvedVector = await manager.getResolvedVectorStoreConfig("memory");
    expect(resolvedVector.apiKey).toBe("vector-env-secret");
    expect(resolvedVector.defaultCollection).toBe("chapters");
    expect(resolvedVector.distance).toBe("cosine");

    delete process.env.SOLOYAKUSHA_GLOBAL_TEST_KEY;
    delete process.env.SOLOYAKUSHA_VECTOR_TEST_KEY;
  });

  test("persists embedding PCA config", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "soloyakusha-global-config-"));
    cleanupTargets.push(rootDir);

    const weightsPath = join(rootDir, "pca-weights.json");
    const componentsBase64 = Buffer.from(
      new Uint8Array(new Float32Array([1, 0]).buffer),
    ).toString("base64");
    const meanBase64 = Buffer.from(
      new Uint8Array(new Float32Array([0, 0]).buffer),
    ).toString("base64");

    await Bun.write(
      weightsPath,
      JSON.stringify({
        pca: {
          target_dim: 1,
          input_dim: 2,
          components: {
            dtype: "float32",
            shape: [1, 2],
            data: componentsBase64,
          },
          mean: {
            dtype: "float32",
            shape: [2],
            data: meanBase64,
          },
        },
      }),
    );

    const manager = new GlobalConfigManager({
      filePath: join(rootDir, "settings.json"),
    });

    await manager.setEmbeddingConfig({
      provider: "openai",
      modelType: "embedding",
      modelName: "text-embedding-3-small",
      endpoint: "https://example.com/v1",
      apiKey: "secret",
      retries: 3,
      pca: {
        enabled: true,
        weightsFilePath: weightsPath,
      },
    });

    expect(await manager.getEmbeddingConfig()).toMatchObject({
      modelType: "embedding",
      pca: {
        enabled: true,
        weightsFilePath: weightsPath,
      },
    });

    expect((await manager.getResolvedEmbeddingConfig()).pca).toEqual({
      enabled: true,
      weightsFilePath: weightsPath,
    });
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
    await manager.setVectorStore("memory", {
      provider: "qdrant",
      endpoint: "https://vector.example.com",
      apiKey: "vector-secret",
      defaultCollection: "chapters",
      distance: "dot",
      timeoutMs: 20_000,
      retries: 5,
      extraHeaders: {
        "x-trace-id": "trace-1",
      },
      options: {
        shard_number: 2,
      },
    });
    await manager.setDefaultVectorStoreName("memory");

    await manager.setTranslationProcessorConfig({
      modelNames: ["translator"],
      slidingWindow: { overlapChars: 12 },
      requestOptions: {
        requestConfig: {
          temperature: 0.2,
          maxTokens: 1234,
        },
      },
    });
    await manager.setProofreadProcessorConfig({
      workflow: "proofread-multi-stage",
      modelNames: ["reviewer"],
      reviewIterations: 1,
      steps: {
        editor: {
          modelNames: ["reviewer"],
        },
        proofreader: {
          modelNames: ["reviewer"],
        },
        reviser: {
          modelNames: ["reviewer"],
        },
      },
    });
    await manager.setGlossaryExtractorConfig({
      modelNames: ["glossary", "summary"],
      maxCharsPerBatch: 4096,
      occurrenceTopK: 128,
      occurrenceTopP: 0.25,
    });
    await manager.setGlossaryUpdaterConfig({
      modelNames: ["glossary"],
      requestOptions: {
        requestConfig: {
          topP: 0.4,
        },
      },
    });
    await manager.setPlotSummaryConfig({
      modelNames: ["summary", "translator"],
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
      supportsStructuredOutput: false,
    });
    expect(await reloaded.getVectorStore("memory")).toEqual({
      provider: "qdrant",
      endpoint: "https://vector.example.com",
      apiKey: "vector-secret",
      apiKeyEnv: undefined,
      defaultCollection: "chapters",
      distance: "dot",
      timeoutMs: 20_000,
      retries: 5,
      extraHeaders: {
        "x-trace-id": "trace-1",
      },
      options: {
        shard_number: 2,
      },
    });
    expect(await reloaded.getDefaultVectorStoreName()).toBe("memory");
    expect(await reloaded.getTranslationProcessorConfig()).toEqual({
      modelNames: ["translator"],
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
    expect(await reloaded.getProofreadProcessorConfig()).toEqual({
      workflow: "proofread-multi-stage",
      modelNames: ["reviewer"],
      reviewIterations: 1,
      steps: {
        editor: {
          modelNames: ["reviewer"],
          requestOptions: undefined,
        },
        proofreader: {
          modelNames: ["reviewer"],
          requestOptions: undefined,
        },
        reviser: {
          modelNames: ["reviewer"],
          requestOptions: undefined,
        },
      },
      slidingWindow: undefined,
      requestOptions: undefined,
      models: undefined,
      maxConcurrentWorkItems: undefined,
    });
    expect(await reloaded.getGlossaryExtractorConfig()).toEqual({
      modelNames: ["glossary", "summary"],
      maxCharsPerBatch: 4096,
      occurrenceTopK: 128,
      occurrenceTopP: 0.25,
      requestOptions: undefined,
    });
    expect(await reloaded.getGlossaryUpdaterConfig()).toEqual({
      modelNames: ["glossary"],
      workflow: undefined,
      requestOptions: {
        requestConfig: {
          topP: 0.4,
        },
        outputValidationContext: undefined,
      },
    });
    expect(await reloaded.getPlotSummaryConfig()).toEqual({
      modelNames: ["summary", "translator"],
      fragmentsPerBatch: 8,
      maxContextSummaries: 10,
      requestOptions: undefined,
    });

    const translationGlobalConfig = await reloaded.getTranslationGlobalConfig();
    expect(translationGlobalConfig).toBeInstanceOf(TranslationGlobalConfig);
    expect(translationGlobalConfig.getTranslationProcessorConfig().modelNames).toEqual(["translator"]);
    expect(translationGlobalConfig.getProofreadProcessorConfig().modelNames).toEqual(["reviewer"]);
    expect(translationGlobalConfig.getEmbeddingConfig()?.modelName).toBe("text-embedding-3-small");
    expect(translationGlobalConfig.getGlossaryExtractorConfig()).toMatchObject({
      modelNames: ["glossary", "summary"],
      occurrenceTopK: 128,
      occurrenceTopP: 0.25,
    });
    expect(translationGlobalConfig.getGlossaryUpdaterConfig()?.modelNames).toEqual(["glossary"]);
    expect(translationGlobalConfig.getPlotSummaryConfig()?.modelNames).toEqual(["summary", "translator"]);

    const saved = JSON.parse(await readFile(filePath, "utf8")) as {
      llm?: {
        embedding?: { modelName: string };
      };
      vector?: {
        defaultStoreName?: string;
        stores?: {
          memory?: {
            provider?: string;
            defaultCollection?: string;
          };
        };
      };
      translation?: {
        translationProcessor?: { modelNames: string[] };
        proofreadProcessor?: { modelNames: string[] };
        glossaryExtractor?: {
          modelNames: string[];
          occurrenceTopK?: number;
          occurrenceTopP?: number;
        };
        glossaryUpdater?: { modelNames: string[] };
        plotSummary?: { modelNames: string[] };
      };
    };
    expect(saved.llm?.embedding?.modelName).toBe("text-embedding-3-small");
    expect(saved.vector?.defaultStoreName).toBe("memory");
    expect(saved.vector?.stores?.memory?.provider).toBe("qdrant");
    expect(saved.vector?.stores?.memory?.defaultCollection).toBe("chapters");
    expect(saved.translation?.translationProcessor?.modelNames).toEqual(["translator"]);
    expect(saved.translation?.proofreadProcessor?.modelNames).toEqual(["reviewer"]);
    expect(saved.translation?.glossaryExtractor?.modelNames).toEqual(["glossary", "summary"]);
    expect(saved.translation?.glossaryExtractor?.occurrenceTopK).toBe(128);
    expect(saved.translation?.glossaryExtractor?.occurrenceTopP).toBe(0.25);
    expect(saved.translation?.glossaryUpdater?.modelNames).toEqual(["glossary"]);
    expect(saved.translation?.plotSummary?.modelNames).toEqual(["summary", "translator"]);
  });

  test("persists translator step configs in global file", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "soloyakusha-global-config-"));
    cleanupTargets.push(rootDir);

    const filePath = join(rootDir, "settings.json");
    const manager = new GlobalConfigManager({ filePath });

    await manager.setTranslator("multi-stage", {
      sourceLanguage: "ja",
      targetLanguage: "zh-CN",
      promptSet: "ja-zhCN",
      type: "multi-stage",
      modelNames: ["analysis-chat"],
      maxConcurrentWorkItems: 3,
      steps: {
        analyzer: {
          modelNames: ["analysis-chat", "analysis-fallback"],
          requestOptions: {
            requestConfig: {
              temperature: 0.2,
            },
          },
        },
        translator: {
          modelNames: ["translator-chat"],
          requestOptions: {
            requestConfig: {
              topP: 0.8,
            },
          },
        },
      },
    });

    const loaded = await manager.getTranslator("multi-stage");
    expect(loaded?.maxConcurrentWorkItems).toBe(3);
    expect(loaded?.steps).toMatchObject({
      analyzer: {
        modelNames: ["analysis-chat", "analysis-fallback"],
        requestOptions: {
          requestConfig: {
            temperature: 0.2,
          },
        },
      },
      translator: {
        modelNames: ["translator-chat"],
        requestOptions: {
          requestConfig: {
            topP: 0.8,
          },
        },
      },
    });
  });

  test("creates proofread processor from dedicated runtime config", () => {
    const config = new TranslationGlobalConfig({
      llm: {
        profiles: {
          reviewer: {
            provider: "openai",
            modelType: "chat",
            apiKey: "test-key",
            endpoint: "https://example.test/v1",
            modelName: "reviewer-model",
          },
        },
      },
      translation: {
        proofreadProcessor: {
          workflow: "proofread-multi-stage",
          modelNames: ["reviewer"],
          reviewIterations: 1,
          steps: {
            editor: {
              modelNames: ["reviewer"],
            },
            proofreader: {
              modelNames: ["reviewer"],
            },
            reviser: {
              modelNames: ["reviewer"],
            },
          },
        },
      },
    });

    expect(config.createProofreadProcessor()).toBeDefined();
  });
});
