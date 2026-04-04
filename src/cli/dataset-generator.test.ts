import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatClient } from "../llm/base.ts";
import { LlmClientProvider } from "../llm/provider.ts";
import type { ChatRequestOptions, LlmClientConfig } from "../llm/types.ts";
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
    expect(dataset[0]?.Prompt).toContain("[System Prompt]");
    expect(dataset[0]?.Answer).toContain("The Hero arrived at the Royal Capital");

    expect(dataset[1]?.Prompt).toContain("依赖文本块译文参考");
    expect(dataset[1]?.Prompt).toContain("The Hero arrived at the Royal Capital");
    expect(dataset[1]?.Prompt).toContain("前序情节总结参考");
    expect(dataset[1]?.Prompt).toContain("勇者抵达王都");
    expect(dataset[1]?.Prompt).toContain("术语表：");
    expect(dataset[1]?.Prompt).toContain("translation: Royal Capital");
    expect(dataset[1]?.Answer).toContain("The Royal Capital was quiet");
    expect(dictionaryClient.requests).toHaveLength(2);
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
        inputPath: inputDir,
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

  constructor(modelName: string, responses: FakeChatResponse[]) {
    super(createFakeChatConfig(modelName));
    this.responses = [...responses];
  }

  override async singleTurnRequest(
    prompt: string,
    options?: ChatRequestOptions,
  ): Promise<string> {
    this.requests.push({ prompt, options });
    const next = this.responses.shift();
    if (!next) {
      throw new Error("缺少测试用 LLM 响应");
    }
    if (next instanceof Error) {
      throw next;
    }

    return next;
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

function createFakeChatConfig(modelName: string): LlmClientConfig {
  return {
    provider: "openai",
    modelName,
    apiKey: "test-key",
    endpoint: "https://example.com",
    modelType: "chat",
    retries: 0,
  };
}
