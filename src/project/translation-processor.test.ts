import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glossary } from "../glossary/glossary.ts";
import { ChatClient } from "../llm/base.ts";
import { LlmClientProvider } from "../llm/provider.ts";
import type { ChatRequestOptions, LlmClientConfig } from "../llm/types.ts";
import { GlobalConfigManager } from "../config/manager.ts";
import { TranslationGlobalConfig } from "./config.ts";
import { DefaultTranslationProcessor } from "./default-translation-processor.ts";
import { DefaultTextSplitter } from "./translation-document-manager.ts";
import type { Logger, LoggerMetadata } from "./logger.ts";
import { TranslationProject } from "./translation-project.ts";

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
      { term: "勇者", translation: "Hero", status: "translated" },
      { term: "王都", translation: "", status: "untranslated", description: "城市名" },
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
    expect(client.requests[1]?.prompt).toContain("term: 王都");
    expect(client.requests[1]?.prompt).toContain("translatedText: Hero gazed at the Royal Capital");
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
      modelName: "shared-chat",
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
      modelName: "glossary-chat",
      requestOptions: {
        requestConfig: {
          topP: 0.4,
        },
      },
    });

    const config = await manager.getTranslationGlobalConfig();
    expect(config.getTranslationProcessorConfig().modelName).toBe("shared-chat");
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
      "glossary-chat": glossaryClient,
    });
    const logger = new MemoryLogger();
    const translator = config.createTranslationProcessor({
      provider: fakeProvider,
      logger,
    });
    const glossary = new Glossary([{ term: "第一行", translation: "", status: "untranslated" }]);
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
    expect(glossaryClient.requests[0]?.options?.requestConfig?.maxTokens).toBe(4096);
    expect(glossaryClient.requests[0]?.options?.requestConfig?.topP).toBe(0.5);
    expect(glossary.getTerm("第一行")).toMatchObject({
      translation: "Line 1",
      status: "translated",
    });
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
        '    modelName: "shared-chat"',
        "    slidingWindow:",
        "      overlapChars: 8",
        "  glossaryUpdater:",
        '    modelName: "shared-chat"',
      ].join("\n"),
      "utf8",
    );

    const config = await TranslationGlobalConfig.loadFromFile(configPath);
    expect(config.getTranslationProcessorConfig()).toEqual({
      workflow: undefined,
      modelName: "shared-chat",
      slidingWindow: { overlapChars: 8 },
      requestOptions: undefined,
    });
    expect(config.getGlossaryUpdaterConfig()).toEqual({
      workflow: undefined,
      modelName: "shared-chat",
      requestOptions: undefined,
    });
  });
});

class FakeChatClient extends ChatClient {
  readonly requests: Array<{ prompt: string; options?: ChatRequestOptions }> = [];
  private readonly responses: string[];

  constructor(responses: string[]) {
    super(createFakeChatConfig());
    this.responses = [...responses];
  }

  override async singleTurnRequest(
    prompt: string,
    options?: ChatRequestOptions,
  ): Promise<string> {
    this.requests.push({ prompt, options });
    return this.responses.shift() ?? '{"translations":[],"glossaryUpdates":[]}';
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
  };
}

class FakeLlmClientProvider extends LlmClientProvider {
  constructor(private readonly clients: Record<string, ChatClient>) {
    super();
  }

  override getChatClient(name: string): ChatClient {
    const client = this.clients[name];
    if (!client) {
      throw new Error(`未找到测试 ChatClient: ${name}`);
    }

    return client;
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
