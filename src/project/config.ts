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

export type TranslationGlobalConfigInput = {
  llm?: Record<string, LlmClientConfigInput>;
  translationProcessor?: TranslationProcessorConfig;
  glossaryUpdater?: GlossaryUpdaterConfig;
};

export class TranslationGlobalConfig {
  readonly llm: Record<string, LlmClientConfigInput>;
  readonly translationProcessor?: TranslationProcessorConfig;
  readonly glossaryUpdater?: GlossaryUpdaterConfig;

  constructor(input: TranslationGlobalConfigInput = {}) {
    this.llm = { ...(input.llm ?? {}) };
    this.translationProcessor = input.translationProcessor
      ? { ...input.translationProcessor }
      : undefined;
    this.glossaryUpdater = input.glossaryUpdater
      ? { ...input.glossaryUpdater }
      : undefined;
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

    return new TranslationGlobalConfig(parsed as TranslationGlobalConfigInput);
  }

  getTranslationProcessorConfig(): TranslationProcessorConfig {
    const config = this.translationProcessor;
    if (!config) {
      throw new Error("未配置 translationProcessor");
    }

    return config;
  }

  getGlossaryUpdaterConfig(): GlossaryUpdaterConfig | undefined {
    return this.glossaryUpdater ? { ...this.glossaryUpdater } : undefined;
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
    const glossaryUpdater =
      options.glossaryUpdater ??
      (this.glossaryUpdater
        ? GlossaryUpdaterFactory.createUpdater({
            workflow: this.glossaryUpdater.workflow,
            clientResolver: {
              provider,
              modelName: this.glossaryUpdater.modelName,
            },
            defaultRequestOptions: this.glossaryUpdater.requestOptions,
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
