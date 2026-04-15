/**
 * 提供翻译模块的全局配置与处理器创建能力。
 *
 * @module project/config
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import YAML from "yaml";
import { GlossaryUpdaterFactory, type GlossaryUpdater } from "../glossary/index.ts";
import { createProviderFromConfigs, LlmClientProvider } from "../llm/provider.ts";
import type { ChatRequestOptions, ClientHooks, LlmClientConfigInput } from "../llm/types.ts";
import { AlignmentRepairTool, DefaultTextAligner } from "../utils/index.ts";
import { NOOP_LOGGER, type Logger } from "./logger.ts";
import type { MultiStageStepName } from "./multi-stage-translation-processor.ts";
import { PromptManager } from "./prompt-manager.ts";
import { TranslationProcessorFactory } from "./translation-processor-factory.ts";
import type {
  TranslationProcessor,
  TranslationProcessorClientResolver,
} from "./translation-processor.ts";
import type { TranslationOutputRepairer } from "./translation-output-repair.ts";
import type { SlidingWindowOptions } from "./types.ts";

export const GLOBAL_EMBEDDING_CLIENT_NAME = "__global_embedding__";

export type TranslationProcessorConfig = {
  workflow?: string;
  modelNames: string[];
  /** 文本块级调度的最大并发数。 */
  maxConcurrentWorkItems?: number;
  slidingWindow?: SlidingWindowOptions;
  requestOptions?: ChatRequestOptions;
  /**
   * 各步骤的模型链与请求选项（供 multi-stage 等多步骤工作流使用）。
   * key 为步骤标识，value 为该步骤的独立配置。
   */
  steps?: Partial<Record<MultiStageStepName, TranslationProcessorStepConfig>>;
  /**
   * 旧版步骤模型覆盖，兼容已有配置。
   * 新配置请使用 steps。
   */
  models?: Record<string, string>;
  /** 评审迭代次数（仅 multi-stage 工作流使用，默认值为 2）。 */
  reviewIterations?: number;
};

export type TranslationProcessorStepConfig = {
  modelNames: string[];
  requestOptions?: ChatRequestOptions;
};

export type GlossaryExtractorConfig = {
  modelNames: string[];
  maxCharsPerBatch?: number;
  occurrenceTopK?: number;
  occurrenceTopP?: number;
  requestOptions?: ChatRequestOptions;
};

export type GlossaryUpdaterConfig = {
  workflow?: string;
  modelNames: string[];
  requestOptions?: ChatRequestOptions;
};

export type PlotSummaryConfig = {
  modelNames: string[];
  fragmentsPerBatch?: number;
  maxContextSummaries?: number;
  requestOptions?: ChatRequestOptions;
};

export type AlignmentRepairConfig = {
  /** 用于对齐补翻 LLM 调用的命名 Chat 配置。 */
  modelNames: string[];
  requestOptions?: ChatRequestOptions;
};

export type TranslationRuntimeConfig = {
  translationProcessor?: TranslationProcessorConfig;
  glossaryExtractor?: GlossaryExtractorConfig;
  glossaryUpdater?: GlossaryUpdaterConfig;
  plotSummary?: PlotSummaryConfig;
  alignmentRepair?: AlignmentRepairConfig;
};

export type TranslationGlobalLlmConfig = {
  profiles: Record<string, LlmClientConfigInput>;
  embedding?: LlmClientConfigInput;
};

export type TranslationGlobalConfigInput = {
  llm?: TranslationGlobalLlmConfig | Record<string, LlmClientConfigInput>;
  translation?: TranslationRuntimeConfig;
  translationProcessor?: TranslationProcessorConfig;
  glossaryExtractor?: GlossaryExtractorConfig;
  glossaryUpdater?: GlossaryUpdaterConfig;
  plotSummary?: PlotSummaryConfig;
  alignmentRepair?: AlignmentRepairConfig;
};

export class TranslationGlobalConfig {
  readonly llm: TranslationGlobalLlmConfig;
  readonly translation?: TranslationRuntimeConfig;

  constructor(input: TranslationGlobalConfigInput = {}) {
    this.llm = normalizeLlmConfigInput(input.llm);
    const translation = input.translation ?? {
      translationProcessor: input.translationProcessor,
      glossaryExtractor: input.glossaryExtractor,
      glossaryUpdater: input.glossaryUpdater,
      plotSummary: input.plotSummary,
      alignmentRepair: input.alignmentRepair,
    };
    this.translation = cloneTranslationRuntimeConfig(translation);
  }

  static async loadFromFile(filePath: string): Promise<TranslationGlobalConfig> {
    const content = await readFile(filePath, "utf8");
    const suffix = extname(filePath).toLowerCase();
    const parsed =
      suffix === ".yaml" || suffix === ".yml"
        ? YAML.parse(content)
        : JSON.parse(content);

    if (!parsed || typeof parsed !== "object") {
      throw new Error("全局配置文件必须是 JSON/YAML 对象");
    }

    return TranslationGlobalConfig.fromParsedObject(parsed as Record<string, unknown>);
  }

  static fromParsedObject(parsed: Record<string, unknown>): TranslationGlobalConfig {
    const llmValue = parsed.llm;
    const llm = resolveLlmConfig(llmValue);

    return new TranslationGlobalConfig({
      llm,
      translation: resolveTranslationRuntimeConfig(parsed),
    });
  }

  getTranslationProcessorConfig(): TranslationProcessorConfig {
    const config = this.translation?.translationProcessor;
    if (!config) {
      throw new Error("未配置 translationProcessor");
    }

    return { ...config, modelNames: [...config.modelNames] };
  }

  getGlossaryUpdaterConfig(): GlossaryUpdaterConfig | undefined {
    return this.translation?.glossaryUpdater
      ? { ...this.translation.glossaryUpdater, modelNames: [...this.translation.glossaryUpdater.modelNames] }
      : undefined;
  }

  getGlossaryExtractorConfig(): GlossaryExtractorConfig | undefined {
    return this.translation?.glossaryExtractor
      ? { ...this.translation.glossaryExtractor, modelNames: [...this.translation.glossaryExtractor.modelNames] }
      : undefined;
  }

  getPlotSummaryConfig(): PlotSummaryConfig | undefined {
    return this.translation?.plotSummary
      ? { ...this.translation.plotSummary, modelNames: [...this.translation.plotSummary.modelNames] }
      : undefined;
  }

  getAlignmentRepairConfig(): AlignmentRepairConfig | undefined {
    return this.translation?.alignmentRepair
      ? { ...this.translation.alignmentRepair, modelNames: [...this.translation.alignmentRepair.modelNames] }
      : undefined;
  }

  getEmbeddingConfig(): LlmClientConfigInput | undefined {
    return this.llm.embedding ? { ...this.llm.embedding } : undefined;
  }

  createProvider(hooks?: ClientHooks): LlmClientProvider {
    return createProviderFromConfigs(
      {
        ...this.llm.profiles,
        ...(this.llm.embedding
          ? { [GLOBAL_EMBEDDING_CLIENT_NAME]: this.llm.embedding }
          : {}),
      },
      hooks,
    );
  }

  createTranslationProcessor(options: {
    provider?: LlmClientProvider;
    hooks?: ClientHooks;
    logger?: Logger;
    promptManager?: PromptManager;
    glossaryUpdater?: GlossaryUpdater;
  } = {}): TranslationProcessor {
    const config = this.getTranslationProcessorConfig();
    const provider = options.provider ?? this.createProvider(options.hooks);
    const logger = options.logger ?? NOOP_LOGGER;
    const glossaryUpdaterConfig = this.getGlossaryUpdaterConfig();
    const glossaryUpdater =
      options.glossaryUpdater ??
      (glossaryUpdaterConfig
        ? GlossaryUpdaterFactory.createUpdater({
            workflow: glossaryUpdaterConfig.workflow,
            clientResolver: provider.getChatClientWithFallback(glossaryUpdaterConfig.modelNames),
            defaultRequestOptions: glossaryUpdaterConfig.requestOptions,
            logger,
          })
        : undefined);
    const outputRepairer = createOutputRepairer(
      provider,
      this.getAlignmentRepairConfig(),
      Boolean(this.llm.embedding),
    );

    const additionalClientResolvers = {
      ...(buildAdditionalClientResolvers(config.models, provider) ?? {}),
      ...(buildStepClientResolvers(config.steps, provider) ?? {}),
    };

    return TranslationProcessorFactory.createProcessor({
      workflow: config.workflow,
      clientResolver: provider.getChatClientWithFallback(config.modelNames),
      additionalClientResolvers,
      stepRequestOptions: buildStepRequestOptions(config.steps),
      workflowOptions: config.reviewIterations !== undefined
        ? { reviewIterations: config.reviewIterations }
        : undefined,
      promptManager: options.promptManager,
      defaultRequestOptions: config.requestOptions,
      defaultSlidingWindow: config.slidingWindow,
      logger,
      glossaryUpdater,
      outputRepairer,
    });
  }
}

function resolveTranslationRuntimeConfig(
  input: Record<string, unknown>,
): TranslationRuntimeConfig | undefined {
  const nestedTranslation = isRecord(input.translation)
    ? {
        translationProcessor: isRecord(input.translation.translationProcessor)
          ? (input.translation.translationProcessor as TranslationProcessorConfig)
          : undefined,
        glossaryExtractor: isRecord(input.translation.glossaryExtractor)
          ? (input.translation.glossaryExtractor as GlossaryExtractorConfig)
          : undefined,
        glossaryUpdater: isRecord(input.translation.glossaryUpdater)
          ? (input.translation.glossaryUpdater as GlossaryUpdaterConfig)
          : undefined,
        plotSummary: isRecord(input.translation.plotSummary)
          ? (input.translation.plotSummary as PlotSummaryConfig)
          : undefined,
        alignmentRepair: isRecord(input.translation.alignmentRepair)
          ? (input.translation.alignmentRepair as AlignmentRepairConfig)
          : undefined,
      }
    : undefined;

  const topLevelTranslation = {
    translationProcessor: isRecord(input.translationProcessor)
      ? (input.translationProcessor as TranslationProcessorConfig)
      : undefined,
    glossaryExtractor: isRecord(input.glossaryExtractor)
      ? (input.glossaryExtractor as GlossaryExtractorConfig)
      : undefined,
    glossaryUpdater: isRecord(input.glossaryUpdater)
      ? (input.glossaryUpdater as GlossaryUpdaterConfig)
      : undefined,
    plotSummary: isRecord(input.plotSummary)
      ? (input.plotSummary as PlotSummaryConfig)
      : undefined,
    alignmentRepair: isRecord(input.alignmentRepair)
      ? (input.alignmentRepair as AlignmentRepairConfig)
      : undefined,
  };

  return cloneTranslationRuntimeConfig({
    translationProcessor:
      nestedTranslation?.translationProcessor ?? topLevelTranslation.translationProcessor,
    glossaryExtractor:
      nestedTranslation?.glossaryExtractor ?? topLevelTranslation.glossaryExtractor,
    glossaryUpdater: nestedTranslation?.glossaryUpdater ?? topLevelTranslation.glossaryUpdater,
    plotSummary: nestedTranslation?.plotSummary ?? topLevelTranslation.plotSummary,
    alignmentRepair: nestedTranslation?.alignmentRepair ?? topLevelTranslation.alignmentRepair,
  });
}

function cloneTranslationRuntimeConfig(
  input: TranslationRuntimeConfig | undefined,
): TranslationRuntimeConfig | undefined {
  if (!input) {
    return undefined;
  }

  const translationProcessor = input.translationProcessor
    ? { ...input.translationProcessor, modelNames: [...input.translationProcessor.modelNames] }
    : undefined;
  const glossaryExtractor = input.glossaryExtractor
    ? { ...input.glossaryExtractor, modelNames: [...input.glossaryExtractor.modelNames] }
    : undefined;
  const glossaryUpdater = input.glossaryUpdater
    ? { ...input.glossaryUpdater, modelNames: [...input.glossaryUpdater.modelNames] }
    : undefined;
  const plotSummary = input.plotSummary
    ? { ...input.plotSummary, modelNames: [...input.plotSummary.modelNames] }
    : undefined;
  const alignmentRepair = input.alignmentRepair
    ? { ...input.alignmentRepair, modelNames: [...input.alignmentRepair.modelNames] }
    : undefined;
  if (
    !translationProcessor &&
    !glossaryExtractor &&
    !glossaryUpdater &&
    !plotSummary &&
    !alignmentRepair
  ) {
    return undefined;
  }

  return {
    translationProcessor,
    glossaryExtractor,
    glossaryUpdater,
    plotSummary,
    alignmentRepair,
  };
}

function createOutputRepairer(
  provider: LlmClientProvider,
  config: AlignmentRepairConfig | undefined,
  hasEmbeddingConfig: boolean,
): TranslationOutputRepairer | undefined {
  if (!config) {
    return undefined;
  }

  if (!hasEmbeddingConfig) {
    throw new Error("已配置对齐补翻，但未配置 llm.embedding，无法执行文本对齐。");
  }

  const tool = new AlignmentRepairTool(
    new DefaultTextAligner(provider.getEmbeddingClient(GLOBAL_EMBEDDING_CLIENT_NAME)),
    provider.getChatClientWithFallback(config.modelNames),
  );

  return {
    repairMissingTranslations(sourceLines, targetLines) {
      return tool.repairMissingTranslations(sourceLines, targetLines, {
        requestOptions: config.requestOptions,
      });
    },
  };
}

function normalizeLlmConfigInput(
  llm: TranslationGlobalConfigInput["llm"],
): TranslationGlobalLlmConfig {
  if (!llm) {
    return { profiles: {} };
  }

  if ("profiles" in llm || "embedding" in llm) {
    const typed = llm as TranslationGlobalLlmConfig;
    return {
      profiles: { ...(typed.profiles ?? {}) },
      embedding: typed.embedding ? { ...typed.embedding } : undefined,
    };
  }

  return {
    profiles: { ...(llm as Record<string, LlmClientConfigInput>) },
  };
}

function resolveLlmConfig(value: unknown): TranslationGlobalLlmConfig {
  if (!isRecord(value)) {
    return { profiles: {} };
  }

  if (isRecord(value.profiles) || value.embedding !== undefined) {
    return {
      profiles: isRecord(value.profiles)
        ? (value.profiles as Record<string, LlmClientConfigInput>)
        : {},
      embedding: isRecord(value.embedding)
        ? (value.embedding as LlmClientConfigInput)
        : undefined,
    };
  }

  return {
    profiles: value as Record<string, LlmClientConfigInput>,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildAdditionalClientResolvers(
  models: Record<string, string> | undefined,
  provider: LlmClientProvider,
): Record<string, { provider: LlmClientProvider; modelName: string }> | undefined {
  if (!models || Object.keys(models).length === 0) {
    return undefined;
  }

  const result: Record<string, { provider: LlmClientProvider; modelName: string }> = {};
  for (const [step, modelName] of Object.entries(models)) {
    result[step] = { provider, modelName };
  }

  return result;
}

function buildStepClientResolvers(
  steps: Partial<
    Record<MultiStageStepName, TranslationProcessorStepConfig>
  > | undefined,
  provider: LlmClientProvider,
): Record<string, TranslationProcessorClientResolver> | undefined {
  if (!steps) {
    return undefined;
  }

  const result: Record<string, TranslationProcessorClientResolver> = {};
  for (const [step, config] of Object.entries(steps)) {
    if (!config) {
      continue;
    }

    result[step] = provider.getChatClientWithFallback(config.modelNames);
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function buildStepRequestOptions(
  steps: Partial<
    Record<MultiStageStepName, TranslationProcessorStepConfig>
  > | undefined,
): Partial<Record<MultiStageStepName, ChatRequestOptions>> | undefined {
  if (!steps) {
    return undefined;
  }

  const result: Partial<Record<MultiStageStepName, ChatRequestOptions>> = {};
  for (const [step, config] of Object.entries(steps)) {
    if (!config?.requestOptions) {
      continue;
    }

    result[step as MultiStageStepName] = config.requestOptions;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
