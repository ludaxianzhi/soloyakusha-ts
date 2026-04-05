import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatClient } from "../llm/base.ts";
import { LlmClientProvider } from "../llm/provider.ts";
import type { ChatRequestOptions, LlmClientConfig } from "../llm/types.ts";
import { retryAsync } from "../llm/utils.ts";
import type {
  GlossaryExtractorConfig,
  GlossaryUpdaterConfig,
  PlotSummaryConfig,
} from "../project/config.ts";
import type { Logger, LoggerMetadata } from "../project/logger.ts";
import { generateTrainingDataset } from "./dataset-generator.ts";

const cleanupTargets: string[] = [];
type FakeChatResponse = string | Error;

afterEach(async () => {
  await Promise.all(
    cleanupTargets.splice(0, cleanupTargets.length).map((target) =>
      rm(target, { recursive: true, force: true }),
    ),
  );
});

describe("generateTrainingDataset", () => {
  test("builds prompt-answer pairs with previous translations, plot summaries, and glossary context", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-dataset-cli-"));
    cleanupTargets.push(workspaceDir);

    const inputDir = join(workspaceDir, "input");
    await mkdir(inputDir, { recursive: true });
    const filePath = join(inputDir, "scene.txt");
    await writeFile(
      filePath,
      [
        "○ 勇者来到王都",
        "● The Hero arrived at the Royal Capital",
        "",
        "○ 王都很安静",
        "● The Royal Capital was quiet",
        "",
      ].join("\n"),
      "utf8",
    );

    const dictionaryClient = new FakeChatClient("dict-model", [
      JSON.stringify({
        entities: [
          {
            term: "王都",
            category: "placeName",
            description: "首都",
          },
        ],
      }),
      JSON.stringify({
        glossaryUpdates: [
          {
            term: "王都",
            translation: "Royal Capital",
          },
        ],
      }),
    ]);
    const outlineClient = new FakeChatClient("outline-model", [
      JSON.stringify({
        summary: {
          mainEvents: "勇者抵达王都",
          keyCharacters: "勇者",
          setting: "王都",
          notes: "",
        },
      }),
      JSON.stringify({
        summary: {
          mainEvents: "王都保持安静",
          keyCharacters: "",
          setting: "王都",
          notes: "",
        },
      }),
    ]);
    const logger = new MemoryLogger();

    const dataset = await generateTrainingDataset(
      {
        inputPattern: join(inputDir, "**", "*.txt"),
        format: "naturedialog",
        dictionaryModels: ["dict-model"],
        outlineModels: ["outline-model"],
        maxSplitLength: 8,
      },
      {
        logger,
        configManager: createFakeConfigManager({
          glossaryExtractorConfig: {
            modelName: "dict-model",
            maxCharsPerBatch: 100,
          },
          glossaryUpdaterConfig: {
            modelName: "dict-model",
          },
          plotSummaryConfig: {
            modelName: "outline-model",
            fragmentsPerBatch: 1,
            maxContextSummaries: 20,
          },
        }),
        createProvider() {
          return new FakeDatasetProvider({
            "dict-model": dictionaryClient,
            "outline-model": outlineClient,
          });
        },
      },
    );

    expect(dataset).toHaveLength(2);
    expect(dataset[0]?.SystemPrompt).toBeTruthy();
    expect(dataset[0]?.UserPrompt).toBeTruthy();
    expect(dataset[0]?.Answer).toContain("The Hero arrived at the Royal Capital");

    expect(dataset[1]?.UserPrompt).toContain("依赖文本块译文参考");
    expect(dataset[1]?.UserPrompt).toContain("The Hero arrived at the Royal Capital");
    expect(dataset[1]?.UserPrompt).toContain("前序情节总结参考");
    expect(dataset[1]?.UserPrompt).toContain("勇者抵达王都");
    expect(dataset[1]?.UserPrompt).toContain("术语表：");
    expect(dataset[1]?.UserPrompt).toContain("translation: Royal Capital");
    expect(dataset[1]?.Answer).toContain("The Royal Capital was quiet");
    expect(dictionaryClient.requests).toHaveLength(2);
    expect(dictionaryClient.requests[1]?.prompt).toContain(
      "translatedText: The Hero arrived at the Royal Capital",
    );
    expect(dictionaryClient.requests[1]?.prompt).toContain(
      "translatedText: The Royal Capital was quiet",
    );
    expect(outlineClient.requests).toHaveLength(2);
    expect(
      logger.entries.some(
        (entry) =>
          entry.message === "加载输入文件并切分文本块" &&
          entry.metadata?.splitMode === "random-left-half-normal" &&
          entry.metadata?.maxSplitLength === 8,
      ),
    ).toBe(true);
    expect(logger.entries.some((entry) => entry.message === "训练数据集构建完成")).toBe(true);
  });

  test("batches glossary translation completion in groups of five fragments without affecting dataset prompts", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-dataset-cli-glossary-batch-"));
    cleanupTargets.push(workspaceDir);

    const filePath = join(workspaceDir, "scene.txt");
    await writeFile(
      filePath,
      [
        "○ 王都出场一",
        "● Royal Capital One",
        "",
        "○ 王都出场二",
        "● Royal Capital Two",
        "",
        "○ 普通三",
        "● Plain Three",
        "",
        "○ 普通四",
        "● Plain Four",
        "",
        "○ 普通五",
        "● Plain Five",
        "",
        "○ 圣剑出场六",
        "● Holy Sword Six",
        "",
        "○ 圣剑出场七",
        "● Holy Sword Seven",
        "",
        "○ 普通八",
        "● Plain Eight",
        "",
        "○ 普通九",
        "● Plain Nine",
        "",
        "○ 普通十",
        "● Plain Ten",
        "",
      ].join("\n"),
      "utf8",
    );

    const dictionaryClient = new FakeChatClient("dict-model", [
      JSON.stringify({
        entities: [
          {
            term: "王都",
            category: "placeName",
            description: "地点",
          },
          {
            term: "圣剑",
            category: "properNoun",
            description: "道具",
          },
        ],
      }),
      JSON.stringify({
        glossaryUpdates: [
          {
            term: "王都",
            translation: "Royal Capital",
          },
        ],
      }),
      JSON.stringify({
        glossaryUpdates: [
          {
            term: "圣剑",
            translation: "Holy Sword",
          },
        ],
      }),
    ]);
    const outlineClient = new FakeChatClient("outline-model", [
      JSON.stringify({
        summary: {
          mainEvents: "前五块",
          keyCharacters: "",
          setting: "",
          notes: "",
        },
      }),
      JSON.stringify({
        summary: {
          mainEvents: "第六块",
          keyCharacters: "",
          setting: "",
          notes: "",
        },
      }),
    ]);

    const dataset = await generateTrainingDataset(
      {
        inputPattern: filePath,
        format: "naturedialog",
        dictionaryModels: ["dict-model"],
        outlineModels: ["outline-model"],
        maxSplitLength: 1,
      },
      {
        configManager: createFakeConfigManager({
          glossaryExtractorConfig: {
            modelName: "dict-model",
            maxCharsPerBatch: 100,
          },
        }),
        createProvider() {
          return new FakeDatasetProvider({
            "dict-model": dictionaryClient,
            "outline-model": outlineClient,
          });
        },
      },
    );

    expect(dataset).toHaveLength(10);
    expect(dictionaryClient.requests).toHaveLength(3);
    expect(dictionaryClient.requests[1]?.prompt).toContain("Royal Capital One");
    expect(dictionaryClient.requests[1]?.prompt).toContain("Royal Capital Two");
    expect(dictionaryClient.requests[1]?.prompt).toContain("Plain Three");
    expect(dictionaryClient.requests[1]?.prompt).toContain("Plain Four");
    expect(dictionaryClient.requests[1]?.prompt).toContain("Plain Five");
    expect(dictionaryClient.requests[1]?.prompt).not.toContain("Holy Sword Six");
    expect(dictionaryClient.requests[2]?.prompt).toContain("Holy Sword Six");
    expect(dictionaryClient.requests[2]?.prompt).toContain("Holy Sword Seven");
    expect(dictionaryClient.requests[2]?.prompt).toContain("Plain Eight");
    expect(dataset[0]?.UserPrompt).toContain("translation: Royal Capital");
    expect(dataset[5]?.UserPrompt).toContain("translation: Holy Sword");
  });

  test("summarizes source fragments in batches of five by default", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-dataset-cli-plot-batch-"));
    cleanupTargets.push(workspaceDir);

    const filePath = join(workspaceDir, "scene.txt");
    await writeFile(
      filePath,
      [
        "○ 甲",
        "● A",
        "",
        "○ 乙",
        "● B",
        "",
        "○ 丙",
        "● C",
        "",
        "○ 丁",
        "● D",
        "",
        "○ 戊",
        "● E",
        "",
        "○ 己",
        "● F",
        "",
      ].join("\n"),
      "utf8",
    );

    const dictionaryClient = new FakeChatClient("dict-model", [
      JSON.stringify({
        entities: [],
      }),
    ]);
    const outlineClient = new FakeChatClient("outline-model", [
      JSON.stringify({
        summary: {
          mainEvents: "甲乙丙丁戊",
          keyCharacters: "",
          setting: "",
          notes: "",
        },
      }),
      JSON.stringify({
        summary: {
          mainEvents: "己",
          keyCharacters: "",
          setting: "",
          notes: "",
        },
      }),
    ]);

    const dataset = await generateTrainingDataset(
      {
        inputPattern: filePath,
        format: "naturedialog",
        dictionaryModels: ["dict-model"],
        outlineModels: ["outline-model"],
        maxSplitLength: 1,
      },
      {
        configManager: createFakeConfigManager({
          glossaryExtractorConfig: {
            modelName: "dict-model",
            maxCharsPerBatch: 100,
          },
        }),
        createProvider() {
          return new FakeDatasetProvider({
            "dict-model": dictionaryClient,
            "outline-model": outlineClient,
          });
        },
      },
    );

    expect(dataset).toHaveLength(6);
    expect(dictionaryClient.requests).toHaveLength(1);
    expect(outlineClient.requests).toHaveLength(2);
    expect(outlineClient.requests[0]?.prompt).toContain("甲");
    expect(outlineClient.requests[0]?.prompt).toContain("乙");
    expect(outlineClient.requests[0]?.prompt).toContain("丙");
    expect(outlineClient.requests[0]?.prompt).toContain("丁");
    expect(outlineClient.requests[0]?.prompt).toContain("戊");
    expect(outlineClient.requests[0]?.prompt).not.toContain("己");
    expect(outlineClient.requests[1]?.prompt).toContain("己");
  });

  test("throws a helpful error when the requested model is not registered", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-dataset-cli-missing-model-"));
    cleanupTargets.push(workspaceDir);

    const filePath = join(workspaceDir, "scene.txt");
    await writeFile(
      filePath,
      [
        "○ 勇者来到王都",
        "● The Hero arrived at the Royal Capital",
        "",
        "○ 王都很安静",
        "● The Royal Capital was quiet",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(
      generateTrainingDataset(
        {
          inputPattern: filePath,
          format: "naturedialog",
          dictionaryModels: ["dict-model", "missing-model"],
          outlineModels: ["outline-model"],
        },
        {
          configManager: createFakeConfigManager({
            availableModels: ["dict-model", "outline-model"],
          }),
          createProvider() {
            throw new Error("should not reach provider creation");
          },
        },
      ),
    ).rejects.toThrow("已注册模型: dict-model, outline-model");
  });

  test("falls back to the next model and restarts from the first model on the next task", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-dataset-cli-fallback-"));
    cleanupTargets.push(workspaceDir);

    const inputDir = join(workspaceDir, "input");
    await mkdir(inputDir, { recursive: true });
    const filePath = join(inputDir, "scene.txt");
    await writeFile(
      filePath,
      [
        "○ 勇者来到王都",
        "● The Hero arrived at the Royal Capital",
        "",
        "○ 王都很安静",
        "● The Royal Capital was quiet",
        "",
      ].join("\n"),
      "utf8",
    );

    const dictionaryClient = new FakeChatClient("dict-model", [
      JSON.stringify({
        entities: [
          {
            term: "王都",
            category: "placeName",
            description: "首都",
          },
        ],
      }),
      JSON.stringify({
        glossaryUpdates: [
          {
            term: "王都",
            translation: "Royal Capital",
          },
        ],
      }),
    ]);
    const primaryOutlineClient = new FakeChatClient("outline-primary", [
      new Error("outline primary unavailable"),
      JSON.stringify({
        summary: {
          mainEvents: "王都保持安静",
          keyCharacters: "",
          setting: "王都",
          notes: "",
        },
      }),
    ]);
    const fallbackOutlineClient = new FakeChatClient("outline-fallback", [
      JSON.stringify({
        summary: {
          mainEvents: "勇者抵达王都",
          keyCharacters: "勇者",
          setting: "王都",
          notes: "",
        },
      }),
    ]);
    const logger = new MemoryLogger();

    const dataset = await generateTrainingDataset(
      {
        inputPattern: join(inputDir, "**", "*.txt"),
        format: "naturedialog",
        dictionaryModels: ["dict-model"],
        outlineModels: ["outline-primary", "outline-fallback"],
        maxSplitLength: 8,
      },
      {
        logger,
        configManager: createFakeConfigManager({
          availableModels: ["dict-model", "outline-primary", "outline-fallback"],
          glossaryExtractorConfig: {
            modelName: "dict-model",
            maxCharsPerBatch: 100,
          },
          glossaryUpdaterConfig: {
            modelName: "dict-model",
          },
          plotSummaryConfig: {
            modelName: "outline-primary",
            fragmentsPerBatch: 1,
            maxContextSummaries: 20,
          },
        }),
        createProvider() {
          return new FakeDatasetProvider({
            "dict-model": dictionaryClient,
            "outline-primary": primaryOutlineClient,
            "outline-fallback": fallbackOutlineClient,
          });
        },
      },
    );

    expect(dataset.length).toBeGreaterThan(0);
    expect(dictionaryClient.requests).toHaveLength(2);
    expect(primaryOutlineClient.requests).toHaveLength(2);
    expect(fallbackOutlineClient.requests).toHaveLength(1);
    expect(
      logger.entries.some(
        (entry) =>
          entry.level === "warn" &&
          entry.message === "模型请求失败，准备切换到回退模型" &&
          entry.metadata?.failedModel === "outline-primary" &&
          entry.metadata?.nextModel === "outline-fallback",
      ),
    ).toBe(true);
  });

  test("retries invalid dictionary JSON on the same model before falling back to the next model", async () => {
    const workspaceDir = await mkdtemp(
      join(tmpdir(), "soloyakusha-dataset-cli-dictionary-validation-"),
    );
    cleanupTargets.push(workspaceDir);

    const inputDir = join(workspaceDir, "input");
    await mkdir(inputDir, { recursive: true });
    const filePath = join(inputDir, "scene.txt");
    await writeFile(
      filePath,
      [
        "○ 勇者来到王都",
        "● The Hero arrived at the Royal Capital",
        "",
        "○ 王都很安静",
        "● The Royal Capital was quiet",
        "",
      ].join("\n"),
      "utf8",
    );

    const primaryDictionaryClient = new FakeChatClient(
      "dict-primary",
      [
        "not-json-at-all",
        "still-not-json",
        JSON.stringify({
          glossaryUpdates: [
            {
              term: "王都",
              translation: "Royal Capital",
            },
          ],
        }),
      ],
      2,
    );
    const fallbackDictionaryClient = new FakeChatClient("dict-fallback", [
      JSON.stringify({
        entities: [
          {
            term: "王都",
            category: "placeName",
            description: "首都",
          },
        ],
      }),
    ]);
    const outlineClient = new FakeChatClient("outline-model", [
      JSON.stringify({
        summary: {
          mainEvents: "勇者抵达王都",
          keyCharacters: "勇者",
          setting: "王都",
          notes: "",
        },
      }),
      JSON.stringify({
        summary: {
          mainEvents: "王都保持安静",
          keyCharacters: "",
          setting: "王都",
          notes: "",
        },
      }),
    ]);
    const logger = new MemoryLogger();

    const dataset = await generateTrainingDataset(
      {
        inputPattern: join(inputDir, "**", "*.txt"),
        format: "naturedialog",
        dictionaryModels: ["dict-primary", "dict-fallback"],
        outlineModels: ["outline-model"],
        maxSplitLength: 8,
      },
      {
        logger,
        configManager: createFakeConfigManager({
          availableModels: ["dict-primary", "dict-fallback", "outline-model"],
          glossaryExtractorConfig: {
            modelName: "dict-primary",
            maxCharsPerBatch: 100,
          },
          glossaryUpdaterConfig: {
            modelName: "dict-primary",
          },
          plotSummaryConfig: {
            modelName: "outline-model",
            fragmentsPerBatch: 1,
            maxContextSummaries: 20,
          },
        }),
        createProvider() {
          return new FakeDatasetProvider({
            "dict-primary": primaryDictionaryClient,
            "dict-fallback": fallbackDictionaryClient,
            "outline-model": outlineClient,
          });
        },
      },
    );

    expect(dataset.length).toBeGreaterThan(0);
    expect(primaryDictionaryClient.requests).toHaveLength(3);
    expect(primaryDictionaryClient.requests[0]?.prompt).toBe(primaryDictionaryClient.requests[1]?.prompt);
    expect(fallbackDictionaryClient.requests).toHaveLength(1);
    expect(fallbackDictionaryClient.requests[0]?.prompt).toBe(primaryDictionaryClient.requests[0]?.prompt);
    expect(
      logger.entries.some(
        (entry) =>
          entry.level === "warn" &&
          entry.message === "模型请求失败，准备切换到回退模型" &&
          entry.metadata?.failedModel === "dict-primary" &&
          entry.metadata?.nextModel === "dict-fallback",
      ),
    ).toBe(true);
  });
});

function createFakeConfigManager(options: {
  availableModels?: string[];
  glossaryExtractorConfig?: GlossaryExtractorConfig;
  glossaryUpdaterConfig?: GlossaryUpdaterConfig;
  plotSummaryConfig?: PlotSummaryConfig;
}) {
  const availableModels = options.availableModels ?? ["dict-model", "outline-model"];

  return {
    async listLlmProfileNames(): Promise<string[]> {
      return [...availableModels];
    },
    async getResolvedLlmProfile(profileName: string): Promise<LlmClientConfig> {
      if (!availableModels.includes(profileName)) {
        throw new Error(`未找到名为 '${profileName}' 的 LLM 全局配置`);
      }

      return {
        provider: "openai",
        modelName: profileName,
        apiKey: "test-key",
        endpoint: "https://example.com",
        modelType: "chat",
        retries: 0,
      };
    },
    async getGlossaryExtractorConfig(): Promise<GlossaryExtractorConfig | undefined> {
      return options.glossaryExtractorConfig;
    },
    async getGlossaryUpdaterConfig(): Promise<GlossaryUpdaterConfig | undefined> {
      return options.glossaryUpdaterConfig;
    },
    async getPlotSummaryConfig(): Promise<PlotSummaryConfig | undefined> {
      return options.plotSummaryConfig;
    },
  };
}

class FakeChatClient extends ChatClient {
  readonly requests: Array<{ prompt: string; options?: ChatRequestOptions }> = [];
  private readonly responses: FakeChatResponse[];

  constructor(
    modelName: string,
    responses: FakeChatResponse[],
    retries = 0,
  ) {
    super(createFakeChatConfig(modelName, retries));
    this.responses = [...responses];
  }

  override async singleTurnRequest(
    prompt: string,
    options: ChatRequestOptions = {},
  ): Promise<string> {
    return retryAsync(
      async () => {
        this.requests.push({ prompt, options });
        const next = this.responses.shift();
        if (!next) {
          throw new Error("缺少测试用 LLM 响应");
        }
        if (next instanceof Error) {
          throw next;
        }

        await options.outputValidator?.(next, options.outputValidationContext);
        return next;
      },
      {
        retries: this.config.retries,
        minDelayMs: 0,
        maxDelayMs: 0,
        multiplier: 1,
        shouldRetry: () => true,
      },
    );
  }
}

class FakeDatasetProvider extends LlmClientProvider {
  constructor(private readonly clients: Record<string, FakeChatClient>) {
    super();
  }

  override getChatClient(name: string): ChatClient {
    const client = this.clients[name];
    if (!client) {
      throw new Error(`未找到测试 ChatClient: ${name}`);
    }

    return client;
  }

  override async closeAll(): Promise<void> {}
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

function createFakeChatConfig(modelName: string, retries: number): LlmClientConfig {
  return {
    provider: "openai",
    modelName,
    apiKey: "test-key",
    endpoint: "https://example.com",
    modelType: "chat",
    retries,
  };
}
