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
import { NOOP_LOGGER, type Logger } from "./logger.ts";
import { PromptManager } from "./prompt-manager.ts";
import { TranslationProcessorFactory } from "./translation-processor-factory.ts";
import type { TranslationProcessor } from "./translation-processor.ts";
import type { SlidingWindowOptions } from "./types.ts";

export const GLOBAL_EMBEDDING_CLIENT_NAME = "__global_embedding__";

export type TranslationProcessorConfig = {
  workflow?: string;
  modelName: string;
  slidingWindow?: SlidingWindowOptions;
  requestOptions?: ChatRequestOptions;
};

export type GlossaryExtractorConfig = {
  modelName: string;
  maxCharsPerBatch?: number;
  occurrenceTopK?: number;
  occurrenceTopP?: number;
  requestOptions?: ChatRequestOptions;
};

export type GlossaryUpdaterConfig = {
  workflow?: string;
  modelName: string;
  requestOptions?: ChatRequestOptions;
};

export type PlotSummaryConfig = {
  modelName: string;
  fragmentsPerBatch?: number;
  maxContextSummaries?: number;
  requestOptions?: ChatRequestOptions;
};

export type TranslationRuntimeConfig = {
  translationProcessor?: TranslationProcessorConfig;
  glossaryExtractor?: GlossaryExtractorConfig;
  glossaryUpdater?: GlossaryUpdaterConfig;
  plotSummary?: PlotSummaryConfig;
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

    return { ...config };
  }

  getGlossaryUpdaterConfig(): GlossaryUpdaterConfig | undefined {
    return this.translation?.glossaryUpdater ? { ...this.translation.glossaryUpdater } : undefined;
  }

  getGlossaryExtractorConfig(): GlossaryExtractorConfig | undefined {
    return this.translation?.glossaryExtractor
      ? { ...this.translation.glossaryExtractor }
      : undefined;
  }

  getPlotSummaryConfig(): PlotSummaryConfig | undefined {
    return this.translation?.plotSummary ? { ...this.translation.plotSummary } : undefined;
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
            clientResolver: {
              provider,
              modelName: glossaryUpdaterConfig.modelName,
            },
            defaultRequestOptions: glossaryUpdaterConfig.requestOptions,
            logger,
          })
        : undefined);

    return TranslationProcessorFactory.createProcessor({
      workflow: config.workflow,
      clientResolver: {
        provider,
        modelName: config.modelName,
      },
      promptManager: options.promptManager,
      defaultRequestOptions: config.requestOptions,
      defaultSlidingWindow: config.slidingWindow,
      logger,
      glossaryUpdater,
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
  };

  return cloneTranslationRuntimeConfig({
    translationProcessor:
      nestedTranslation?.translationProcessor ?? topLevelTranslation.translationProcessor,
    glossaryExtractor:
      nestedTranslation?.glossaryExtractor ?? topLevelTranslation.glossaryExtractor,
    glossaryUpdater: nestedTranslation?.glossaryUpdater ?? topLevelTranslation.glossaryUpdater,
    plotSummary: nestedTranslation?.plotSummary ?? topLevelTranslation.plotSummary,
  });
}

function cloneTranslationRuntimeConfig(
  input: TranslationRuntimeConfig | undefined,
): TranslationRuntimeConfig | undefined {
  if (!input) {
    return undefined;
  }

  const translationProcessor = input.translationProcessor
    ? { ...input.translationProcessor }
    : undefined;
  const glossaryExtractor = input.glossaryExtractor ? { ...input.glossaryExtractor } : undefined;
  const glossaryUpdater = input.glossaryUpdater ? { ...input.glossaryUpdater } : undefined;
  const plotSummary = input.plotSummary ? { ...input.plotSummary } : undefined;
  if (!translationProcessor && !glossaryExtractor && !glossaryUpdater && !plotSummary) {
    return undefined;
  }

  return {
    translationProcessor,
    glossaryExtractor,
    glossaryUpdater,
    plotSummary,
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
