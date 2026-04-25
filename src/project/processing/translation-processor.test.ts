import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AlignmentRepairResult } from "../../utils/alignment-repair.ts";
import { Glossary } from "../../glossary/glossary.ts";
import { ChatClient, EmbeddingClient } from "../../llm/base.ts";
import { LlmClientProvider } from "../../llm/provider.ts";
import type { ChatRequestOptions, LlmClientConfig } from "../../llm/types.ts";
import { GlobalConfigManager } from "../../config/manager.ts";
import { TranslationGlobalConfig } from "../config.ts";
import { DefaultTranslationProcessor } from "./default-translation-processor.ts";
import { MultiStageTranslationProcessor } from "./multi-stage-translation-processor.ts";
import { DefaultTextSplitter } from "../document/translation-document-manager.ts";
import type { TranslationOutputRepairer } from "./translation-output-repair.ts";
import type { Logger, LoggerMetadata } from "../logger.ts";
import { TranslationProject } from "../pipeline/translation-project.ts";

const cleanupTargets: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupTargets.splice(0, cleanupTargets.length).map((target) =>
      rm(target, { recursive: true, force: true }),
    ),
  );
});

describe("TranslationProcessor", () => {
  test("renders translation and glossary update prompts with separate LLM requests", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-translation-processor-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    const dataDir = join(workspaceDir, "Data");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(sourceDir, "chapter-1.txt"),
      "前文原文标记\n勇者看着王都\n",
      "utf8",
    );
    await writeFile(
      join(dataDir, "plot-summaries.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          entries: [
            {
              chapterId: 1,
              startFragmentIndex: 0,
              endFragmentIndex: 1,
              summary: {
                mainEvents: "前文原文标记对应的情节总结",
                keyCharacters: "叙述者",
                setting: "序章",
                notes: "这是前序情节",
              },
              createdAt: "2025-01-01T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const glossary = new Glossary([
      { term: "勇者", translation: "Hero" },
      { term: "王都", translation: "", description: "城市名" },
    ]);

    const project = new TranslationProject(
      {
        projectName: "processor",
        projectDir: workspaceDir,
        chapters: [{ id: 1, filePath: "sources\\chapter-1.txt" }],
        glossary: {
          path: "glossary.csv",
          autoFilter: true,
        },
        customRequirements: ["保持术语一致"],
      },
      {
        glossary,
        textSplitter: {
          split(units) {
            return units.map((unit) => [unit]);
          },
        },
      },
    );

    await project.initialize();
    await project.startTranslation();

    const queue = project.getWorkQueue("translation");
    const firstBatch = await queue.dispatchReadyItems();
    await project.submitWorkResult({
      runId: firstBatch[0]!.runId,
      stepId: "translation",
      chapterId: 1,
      fragmentIndex: 0,
      outputText: "Previous translated line",
    });

    const secondBatch = await queue.dispatchReadyItems();
    const secondItem = secondBatch[0]!;
    const glossaryContext = secondItem.contextView?.getGlossaryContext();
    expect(glossaryContext?.type).toBe("glossary");
    if (glossaryContext?.type === "glossary") {
      expect(glossaryContext.content).not.toContain("王都");
    }
    const plotSummaryContext = secondItem.contextView?.getContext("plotSummary");
    expect(plotSummaryContext?.type).toBe("plotSummary");
    if (plotSummaryContext?.type === "plotSummary") {
      expect(plotSummaryContext.summaries).toHaveLength(1);
      expect(plotSummaryContext.summaries[0]).toContain("前文原文标记对应的情节总结");
    }

    const client = new FakeChatClient([
      JSON.stringify({
        translations: [{ id: "1", translation: "Hero gazed at the Royal Capital" }],
      }),
      JSON.stringify({
        glossaryUpdates: [{ term: "王都", translation: "Royal Capital" }],
      }),
    ]);
    const processor = new DefaultTranslationProcessor(client);

    const result = await processor.processWorkItem(secondItem, { glossary });

    expect(result.outputText).toBe("Hero gazed at the Royal Capital");
    expect(result.glossaryUpdates).toEqual([
      { term: "王都", translation: "Royal Capital" },
    ]);
    expect(glossary.getTerm("王都")).toMatchObject({
      translation: "Royal Capital",
      status: "translated",
    });
    expect(client.requests[0]?.prompt).toContain("保持术语一致");
    expect(client.requests[0]?.prompt).toContain("Previous translated line");
    expect(client.requests[0]?.prompt).toContain("前序情节总结参考");
    expect(client.requests[0]?.prompt).toContain("前文原文标记对应的情节总结");
    expect(client.requests[0]?.prompt).not.toContain("text: 前文原文标记");
    expect(client.requests[0]?.prompt).toContain("Hero");
    expect(client.requests[0]?.prompt).not.toContain("term: 王都");
    expect(client.requests[0]?.options?.requestConfig?.systemPrompt).toContain("JSON Schema");
    expect(client.requests[0]?.options?.requestConfig?.extraBody).toEqual({
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "translation_pipeline_result",
          strict: true,
          schema: result.responseSchema,
        },
      },
    });
    expect(client.requests[0]?.options?.meta).toMatchObject({
      label: "翻译-最终翻译",
      feature: "翻译",
      operation: "最终翻译",
      component: "DefaultTranslationProcessor",
      workflow: "default",
      context: {
        chapterId: 1,
        fragmentIndex: 1,
        stepId: "translation",
      },
    });
    expect(client.requests[1]?.prompt).toContain("term: 王都");
    expect(client.requests[1]?.prompt).toContain("translatedText: Hero gazed at the Royal Capital");
    expect(client.requests[1]?.options?.meta).toMatchObject({
      label: "术语更新",
      feature: "术语",
      operation: "术语更新",
      component: "DefaultGlossaryUpdater",
      workflow: "default",
    });
    expect(result.glossaryUpdateResult?.responseSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        glossaryUpdates: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              term: {
                type: "string",
                enum: ["王都"],
              },
              translation: {
                type: "string",
                minLength: 1,
              },
            },
            required: ["term", "translation"],
          },
        },
      },
      required: ["glossaryUpdates"],
    });

    await project.submitWorkResult({
      runId: secondItem.runId,
      stepId: secondItem.stepId,
      chapterId: secondItem.chapterId,
      fragmentIndex: secondItem.fragmentIndex,
      outputText: result.outputText,
    });
    await project.saveProgress();

    const savedGlossary = await readFile(join(workspaceDir, "glossary.csv"), "utf8");
    expect(savedGlossary).toContain("Royal Capital");
  });

  test("supports sliding window translation with provider-based initialization", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-window-translator-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "aaaa\nbbbb\ncccc\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "window",
        projectDir: workspaceDir,
        chapters: [{ id: 1, filePath: "sources\\chapter-1.txt" }],
      },
      {
        textSplitter: new DefaultTextSplitter(4),
      },
    );
    await project.initialize();
    await project.startTranslation();

    const queue = project.getWorkQueue("translation");
    const firstBatch = await queue.dispatchReadyItems();
    await project.submitWorkResult({
      runId: firstBatch[0]!.runId,
      stepId: "translation",
      chapterId: 1,
      fragmentIndex: 0,
      outputText: "A1",
    });

    const secondBatch = await queue.dispatchReadyItems();
    const secondItem = secondBatch[0]!;
    const client = new FakeChatClient([
      JSON.stringify({
        translations: [
          { id: "1", translation: "A_ctx" },
          { id: "2", translation: "B1" },
          { id: "3", translation: "C_ctx" },
        ],
      }),
    ]);
    const provider = new FakeLlmClientProvider({ "window-model": client });
    const logger = new MemoryLogger();
    const processor = new DefaultTranslationProcessor(
      {
        provider,
        modelName: "window-model",
      },
      {
        defaultSlidingWindow: { overlapChars: 4 },
        defaultRequestOptions: {
          requestConfig: {
            temperature: 0.2,
            maxTokens: 321,
          },
        },
        logger,
        processorName: "window-translator",
      },
    );

    const result = await processor.processWorkItem(secondItem, {
      documentManager: project.getDocumentManager(),
    });

    expect(result.window?.source.lines).toEqual(["aaaa", "bbbb", "cccc"]);
    expect(result.outputText).toBe("B1");
    expect(client.requests[0]?.prompt).toContain("text: aaaa");
    expect(client.requests[0]?.prompt).toContain("text: bbbb");
    expect(client.requests[0]?.prompt).toContain("text: cccc");
    expect(client.requests[0]?.options?.requestConfig?.temperature).toBe(0.2);
    expect(client.requests[0]?.options?.requestConfig?.maxTokens).toBe(321);
    expect(logger.entries.some((entry) => entry.message === "开始执行翻译处理")).toBe(true);
    expect(logger.entries.some((entry) => entry.message === "翻译处理完成")).toBe(true);
  });

  test("repairs minor output line mismatch using alignment repair from global config", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-alignment-runtime-"));
    cleanupTargets.push(workspaceDir);

    const configPath = join(workspaceDir, "config.json");
    const manager = new GlobalConfigManager({ filePath: configPath });
    await manager.setLlmProfile("shared-chat", {
      provider: "openai",
      modelType: "chat",
      modelName: "gpt-4.1",
      endpoint: "https://example.com/v1",
      apiKey: "test-key",
      retries: 3,
    });
    await manager.setLlmProfile("repair-chat", {
      provider: "openai",
      modelType: "chat",
      modelName: "gpt-4.1-mini",
      endpoint: "https://example.com/v1",
      apiKey: "test-key",
      retries: 3,
    });
    await manager.setEmbeddingConfig({
      provider: "openai",
      modelType: "embedding",
      modelName: "text-embedding-3-small",
      endpoint: "https://example.com/v1",
      apiKey: "test-key",
      retries: 3,
    });
    await manager.setTranslationProcessorConfig({
      modelNames: ["shared-chat"],
    });
    await manager.setAlignmentRepairConfig({
      modelNames: ["repair-chat"],
    });

    const config = await manager.getTranslationGlobalConfig();
    const translationClient = new FakeChatClient([
      JSON.stringify({
        translations: createSequentialTranslations(7, {
          3: "T3\nEXTRA",
        }),
      }),
    ]);
    const repairClient = new FakeChatClient([]);
    const fakeProvider = new FakeLlmClientProvider(
      {
        "shared-chat": translationClient,
        "repair-chat": repairClient,
      },
      {
        "__global_embedding__": new FakeEmbeddingClient(),
      },
    );

    const translator = config.createTranslationProcessor({
      provider: fakeProvider,
    });
    const result = await translator.process({
      sourceText: createSequentialLines("S", 7),
    });

    expect(result.outputText).toBe(createSequentialLines("T", 7));
    expect(result.translations.map((entry) => entry.translation)).toEqual(
      createSequentialLineArray("T", 7),
    );
    expect(repairClient.requests).toHaveLength(0);
  });

  test("throws when output line difference exceeds fifteen percent", async () => {
    const client = new FakeChatClient([
      JSON.stringify({
        translations: createSequentialTranslations(6, {
          3: "T3\nEXTRA",
        }),
      }),
    ]);
    const processor = new DefaultTranslationProcessor(client);

    await expect(
      processor.process({
        sourceText: createSequentialLines("S", 6),
      }),
    ).rejects.toThrow("译文与原文行数差异过大");
  });

  test("multi-stage processor repairs minor output line mismatch", async () => {
    const client = new FakeChatClient([
      "分析结果",
      JSON.stringify({
        translations: createSequentialTranslations(7, {
          4: "T4\nEXTRA",
        }),
      }),
    ]);
    const outputRepairer = new FakeOutputRepairer([
      createResolvedRepairResult(createSequentialLineArray("T", 7), 7, 8),
    ]);
    const processor = new MultiStageTranslationProcessor(client, {}, {
      reviewIterations: 0,
      outputRepairer,
    });

    const result = await processor.process({
      sourceText: createSequentialLines("S", 7),
    });

    expect(result.outputText).toBe(createSequentialLines("T", 7));
    expect(outputRepairer.requests).toHaveLength(1);
    expect(outputRepairer.requests[0]?.sourceLines).toEqual(createSequentialLineArray("S", 7));
    expect(outputRepairer.requests[0]?.targetLines).toEqual([
      "T1",
      "T2",
      "T3",
      "T4",
      "EXTRA",
      "T5",
      "T6",
      "T7",
    ]);
    expect(client.requests.map((entry) => entry.options?.meta?.label)).toEqual([
      "翻译-分析",
      "翻译-初步翻译",
    ]);
  });

  test("multi-stage processor applies per-step request options", async () => {
    const client = new FakeChatClient([
      "分析结果",
      JSON.stringify({
        translations: createSequentialTranslations(7),
      }),
    ]);
    const processor = new MultiStageTranslationProcessor(client, {}, {
      reviewIterations: 0,
      stepRequestOptions: {
        analyzer: {
          requestConfig: {
            temperature: 0.1,
          },
        },
        translator: {
          requestConfig: {
            maxTokens: 1024,
          },
        },
      },
    });

    await processor.process({
      sourceText: createSequentialLines("S", 7),
    });

    expect(client.requests[0]?.options?.requestConfig?.temperature).toBe(0.1);
    expect(client.requests[1]?.options?.requestConfig?.maxTokens).toBe(1024);
  });

  test("creates processor from user global config and merges processor/updater request parameters", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-global-config-"));
    cleanupTargets.push(workspaceDir);

    const configPath = join(workspaceDir, "config.json");
    const manager = new GlobalConfigManager({ filePath: configPath });
    await manager.setLlmProfile("shared-chat", {
      provider: "openai",
      modelType: "chat",
      modelName: "gpt-4.1",
      endpoint: "https://example.com/v1",
      apiKey: "test-key",
      retries: 3,
    });
    await manager.setLlmProfile("glossary-chat", {
      provider: "openai",
      modelType: "chat",
      modelName: "gpt-4.1-mini",
      endpoint: "https://example.com/v1",
      apiKey: "test-key",
      retries: 3,
    });
    await manager.setTranslationProcessorConfig({
      modelNames: ["shared-chat", "backup-chat"],
      slidingWindow: {
        overlapChars: 8,
      },
      requestOptions: {
        requestConfig: {
          temperature: 0.1,
          maxTokens: 222,
        },
      },
    });
    await manager.setGlossaryUpdaterConfig({
      modelNames: ["glossary-chat"],
      requestOptions: {
        requestConfig: {
          topP: 0.4,
        },
      },
    });

    const config = await manager.getTranslationGlobalConfig();
    expect(config.getTranslationProcessorConfig().modelNames).toEqual([
      "shared-chat",
      "backup-chat",
    ]);
    const providerFromConfig = config.createProvider();
    expect(providerFromConfig).toBeInstanceOf(LlmClientProvider);

    const translationClient = new FakeChatClient([
      JSON.stringify({
        translations: [{ id: "1", translation: "Line 1" }],
      }),
    ]);
    const glossaryClient = new FakeChatClient([
      JSON.stringify({
        glossaryUpdates: [{ term: "第一行", translation: "Line 1" }],
      }),
    ]);
    const fakeProvider = new FakeLlmClientProvider({
      "shared-chat": translationClient,
      "backup-chat": new FakeChatClient([]),
      "glossary-chat": glossaryClient,
    });
    const logger = new MemoryLogger();
    const translator = config.createTranslationProcessor({
      provider: fakeProvider,
      logger,
    });
    const glossary = new Glossary([{ term: "第一行", translation: "" }]);
    const result = await translator.process({
      sourceText: "第一行",
      glossary,
      requestOptions: {
        requestConfig: {
          topP: 0.5,
        },
      },
    });

    expect(result.outputText).toBe("Line 1");
    expect(translationClient.requests[0]?.options?.requestConfig?.temperature).toBe(0.1);
    expect(translationClient.requests[0]?.options?.requestConfig?.maxTokens).toBe(222);
    expect(translationClient.requests[0]?.options?.requestConfig?.topP).toBe(0.5);
    expect(glossaryClient.requests[0]?.options?.requestConfig?.topP).toBe(0.5);
    expect(glossaryClient.requests[0]?.options?.requestConfig?.temperature).toBe(0.7);
    expect(glossaryClient.requests[0]?.options?.requestConfig?.maxTokens).toBeUndefined();
    expect(glossaryClient.requests[0]?.options?.requestConfig?.topP).toBe(0.5);
    expect(glossary.getTerm("第一行")).toMatchObject({
      translation: "Line 1",
      status: "translated",
    });
  });

  test("uses ordered fallback model chain from global config", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-global-config-fallback-"));
    cleanupTargets.push(workspaceDir);

    const configPath = join(workspaceDir, "config.json");
    const manager = new GlobalConfigManager({ filePath: configPath });
    await manager.setLlmProfile("primary-chat", {
      provider: "openai",
      modelType: "chat",
      modelName: "gpt-4.1",
      endpoint: "https://example.com/v1",
      apiKey: "test-key",
      retries: 0,
    });
    await manager.setLlmProfile("secondary-chat", {
      provider: "openai",
      modelType: "chat",
      modelName: "gpt-4.1-mini",
      endpoint: "https://example.com/v1",
      apiKey: "test-key",
      retries: 0,
    });
    await manager.setTranslationProcessorConfig({
      modelNames: ["primary-chat", "secondary-chat"],
    });

    const config = await manager.getTranslationGlobalConfig();
    const primaryClient = new FakeChatClient([new Error("primary failed")]);
    const secondaryClient = new FakeChatClient([
      JSON.stringify({
        translations: [{ id: "1", translation: "Line 1" }],
      }),
    ]);
    const fakeProvider = new FakeLlmClientProvider({
      "primary-chat": primaryClient,
      "secondary-chat": secondaryClient,
    });

    const translator = config.createTranslationProcessor({
      provider: fakeProvider,
      logger: new MemoryLogger(),
    });
    const result = await translator.process({
      sourceText: "第一行",
    });

    expect(result.outputText).toBe("Line 1");
    expect(primaryClient.requests).toHaveLength(1);
    expect(secondaryClient.requests).toHaveLength(1);
  });

  test("loads translation settings from nested global config document file", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-global-config-file-"));
    cleanupTargets.push(workspaceDir);

    const configPath = join(workspaceDir, "config.yaml");
    await writeFile(
      configPath,
      [
        "version: 1",
        "llm:",
        "  profiles:",
        "    shared-chat:",
        '      provider: "openai"',
        '      modelType: "chat"',
        '      modelName: "gpt-4.1"',
        '      endpoint: "https://example.com/v1"',
        '      apiKey: "test-key"',
        "      retries: 3",
        "translation:",
        "  translationProcessor:",
        '    modelNames:',
        '      - "shared-chat"',
        "    slidingWindow:",
        "      overlapChars: 8",
        "  glossaryUpdater:",
        '    modelNames:',
        '      - "shared-chat"',
      ].join("\n"),
      "utf8",
    );

    const config = await TranslationGlobalConfig.loadFromFile(configPath);
    expect(config.getTranslationProcessorConfig()).toEqual({
      workflow: undefined,
      modelNames: ["shared-chat"],
      slidingWindow: { overlapChars: 8 },
      requestOptions: undefined,
    });
    expect(config.getGlossaryUpdaterConfig()).toEqual({
      workflow: undefined,
      modelNames: ["shared-chat"],
      requestOptions: undefined,
    });
  });
});

class FakeChatClient extends ChatClient {
  readonly requests: Array<{ prompt: string; options?: ChatRequestOptions }> = [];
  private readonly responses: Array<string | Error>;

  constructor(responses: Array<string | Error>) {
    super(createFakeChatConfig());
    this.responses = [...responses];
  }

  override async singleTurnRequest(
    prompt: string,
    options?: ChatRequestOptions,
  ): Promise<string> {
    this.requests.push({ prompt, options });
    const next = this.responses.shift() ?? '{"translations":[],"glossaryUpdates":[]}';
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

function createFakeChatConfig(): LlmClientConfig {
  return {
    provider: "openai",
    modelName: "fake-model",
    apiKey: "test-key",
    endpoint: "https://example.com",
    modelType: "chat",
    retries: 0,
    supportsStructuredOutput: true,
  };
}

class FakeLlmClientProvider extends LlmClientProvider {
  constructor(
    private readonly clients: Record<string, ChatClient>,
    private readonly embeddingClients: Record<string, EmbeddingClient> = {},
  ) {
    super();
  }

  override getChatClient(name: string): ChatClient {
    const client = this.clients[name];
    if (!client) {
      throw new Error(`未找到测试 ChatClient: ${name}`);
    }

    return client;
  }

  override getEmbeddingClient(name: string): EmbeddingClient {
    const client = this.embeddingClients[name];
    if (!client) {
      throw new Error(`未找到测试 EmbeddingClient: ${name}`);
    }

    return client;
  }
}

class FakeEmbeddingClient extends EmbeddingClient {
  constructor() {
    super(createFakeEmbeddingConfig());
  }

  override async getEmbedding(text: string): Promise<number[]> {
    return [extractNumericSignal(text)];
  }

  override async getEmbeddings(texts: string[]): Promise<number[][]> {
    return texts.map((text) => [extractNumericSignal(text)]);
  }
}

class FakeOutputRepairer implements TranslationOutputRepairer {
  readonly requests: Array<{
    sourceLines: ReadonlyArray<string>;
    targetLines: ReadonlyArray<string>;
  }> = [];

  constructor(private readonly results: AlignmentRepairResult[]) {}

  async repairMissingTranslations(
    sourceLines: ReadonlyArray<string>,
    targetLines: ReadonlyArray<string>,
  ): Promise<AlignmentRepairResult> {
    this.requests.push({
      sourceLines: [...sourceLines],
      targetLines: [...targetLines],
    });
    const result = this.results.shift();
    if (!result) {
      throw new Error("缺少测试用对齐补翻结果");
    }

    return result;
  }
}

class MemoryLogger implements Logger {
  readonly entries: Array<{
    level: "debug" | "info" | "warn" | "error";
    message: string;
    metadata?: LoggerMetadata;
  }> = [];

  debug(message: string, metadata?: LoggerMetadata): void {
    this.entries.push({ level: "debug", message, metadata });
  }

  info(message: string, metadata?: LoggerMetadata): void {
    this.entries.push({ level: "info", message, metadata });
  }

  warn(message: string, metadata?: LoggerMetadata): void {
    this.entries.push({ level: "warn", message, metadata });
  }

  error(message: string, metadata?: LoggerMetadata): void {
    this.entries.push({ level: "error", message, metadata });
  }
}

function createFakeEmbeddingConfig(): LlmClientConfig {
  return {
    provider: "openai",
    modelName: "fake-embedding-model",
    apiKey: "test-key",
    endpoint: "https://example.com",
    modelType: "embedding",
    retries: 0,
  };
}

function createSequentialLines(prefix: string, count: number): string {
  return createSequentialLineArray(prefix, count).join("\n");
}

function createSequentialLineArray(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);
}

function createSequentialTranslations(
  count: number,
  overrides: Record<number, string> = {},
): Array<{ id: string; translation: string }> {
  return Array.from({ length: count }, (_, index) => ({
    id: String(index + 1),
    translation: overrides[index + 1] ?? `T${index + 1}`,
  }));
}

function createResolvedRepairResult(
  alignedTranslations: string[],
  sourceLineCount: number,
  targetLineCount: number,
): AlignmentRepairResult {
  const units = alignedTranslations.map((translation, index) => ({
    id: `u${String(index + 1).padStart(4, "0")}`,
    sourceIndex: index,
    sourceText: `S${index + 1}`,
    alignedTranslation: translation,
    missing: false,
  }));

  return {
    analysis: {
      sourceLineCount,
      targetLineCount,
      lineCountMatches: sourceLineCount === targetLineCount,
      missingUnitCount: 0,
      missingUnitIds: [],
      comparisonText: "",
      units,
    },
    repairs: [],
    unresolvedIds: [],
  };
}

function extractNumericSignal(text: string): number {
  if (text.includes("EXTRA")) {
    return 999;
  }

  const matched = text.match(/\d+/);
  return matched ? Number(matched[0]) : 999;
}
