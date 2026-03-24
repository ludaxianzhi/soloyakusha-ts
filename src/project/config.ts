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

export type TranslationProcessorConfig = {
  workflow?: string;
  modelName: string;
  slidingWindow?: SlidingWindowOptions;
  requestOptions?: ChatRequestOptions;
};

export type GlossaryUpdaterConfig = {
  workflow?: string;
  modelName: string;
  requestOptions?: ChatRequestOptions;
};

export type TranslationRuntimeConfig = {
  translationProcessor?: TranslationProcessorConfig;
  glossaryUpdater?: GlossaryUpdaterConfig;
};

export type TranslationGlobalConfigInput = {
  llm?: Record<string, LlmClientConfigInput>;
  translation?: TranslationRuntimeConfig;
  translationProcessor?: TranslationProcessorConfig;
  glossaryUpdater?: GlossaryUpdaterConfig;
};

export class TranslationGlobalConfig {
  readonly llm: Record<string, LlmClientConfigInput>;
  readonly translation?: TranslationRuntimeConfig;

  constructor(input: TranslationGlobalConfigInput = {}) {
    this.llm = { ...(input.llm ?? {}) };
    const translation = input.translation ?? {
      translationProcessor: input.translationProcessor,
      glossaryUpdater: input.glossaryUpdater,
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
    const llm =
      isRecord(llmValue) && isRecord(llmValue.profiles)
        ? (llmValue.profiles as Record<string, LlmClientConfigInput>)
        : ((llmValue as Record<string, LlmClientConfigInput> | undefined) ?? {});

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

  createProvider(hooks?: ClientHooks): LlmClientProvider {
    return createProviderFromConfigs(this.llm, hooks);
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
        glossaryUpdater: isRecord(input.translation.glossaryUpdater)
          ? (input.translation.glossaryUpdater as GlossaryUpdaterConfig)
          : undefined,
      }
    : undefined;

  const topLevelTranslation = {
    translationProcessor: isRecord(input.translationProcessor)
      ? (input.translationProcessor as TranslationProcessorConfig)
      : undefined,
    glossaryUpdater: isRecord(input.glossaryUpdater)
      ? (input.glossaryUpdater as GlossaryUpdaterConfig)
      : undefined,
  };

  return cloneTranslationRuntimeConfig({
    translationProcessor:
      nestedTranslation?.translationProcessor ?? topLevelTranslation.translationProcessor,
    glossaryUpdater: nestedTranslation?.glossaryUpdater ?? topLevelTranslation.glossaryUpdater,
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
  const glossaryUpdater = input.glossaryUpdater ? { ...input.glossaryUpdater } : undefined;
  if (!translationProcessor && !glossaryUpdater) {
    return undefined;
  }

  return {
    translationProcessor,
    glossaryUpdater,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
