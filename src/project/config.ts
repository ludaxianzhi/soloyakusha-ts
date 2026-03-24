/**
 * 提供翻译模块的全局配置与命名翻译器注册能力。
 *
 * @module project/config
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import YAML from "yaml";
import { createProviderFromConfigs, LlmClientProvider } from "../llm/provider.ts";
import type { ChatRequestOptions, ClientHooks, LlmClientConfigInput } from "../llm/types.ts";
import { NOOP_LOGGER, type Logger } from "./logger.ts";
import { PromptManager } from "./prompt-manager.ts";
import { TranslationProcessor } from "./translation-processor.ts";
import type { SlidingWindowOptions } from "./types.ts";

export type NamedTranslatorConfig = {
  modelName: string;
  slidingWindow?: SlidingWindowOptions;
  requestOptions?: ChatRequestOptions;
};

export type TranslationGlobalConfigInput = {
  llm?: Record<string, LlmClientConfigInput>;
  translators?: Record<string, NamedTranslatorConfig>;
  defaultTranslator?: string;
};

export class TranslationProcessorRegistry {
  private readonly cache = new Map<string, TranslationProcessor>();

  constructor(
    private readonly provider: LlmClientProvider,
    private readonly translators: Record<string, NamedTranslatorConfig>,
    private readonly options: {
      logger?: Logger;
      promptManager?: PromptManager;
    } = {},
  ) {}

  getTranslator(name: string): TranslationProcessor {
    const existing = this.cache.get(name);
    if (existing) {
      this.options.logger?.debug?.("复用已缓存的命名翻译器", { translatorName: name });
      return existing;
    }

    const config = this.translators[name];
    if (!config) {
      throw new Error(`未找到名为 '${name}' 的翻译器配置`);
    }

    const processor = new TranslationProcessor(
      {
        provider: this.provider,
        modelName: config.modelName,
      },
      {
        promptManager: this.options.promptManager,
        defaultRequestOptions: config.requestOptions,
        defaultSlidingWindow: config.slidingWindow,
        logger: this.options.logger,
        translatorName: name,
      },
    );
    this.cache.set(name, processor);
    this.options.logger?.info?.("创建命名翻译器", {
      translatorName: name,
      modelName: config.modelName,
      slidingWindow: config.slidingWindow,
    });
    return processor;
  }
}

export class TranslationGlobalConfig {
  readonly llm: Record<string, LlmClientConfigInput>;
  readonly translators: Record<string, NamedTranslatorConfig>;
  readonly defaultTranslator?: string;

  constructor(input: TranslationGlobalConfigInput = {}) {
    this.llm = { ...(input.llm ?? {}) };
    this.translators = { ...(input.translators ?? {}) };
    this.defaultTranslator = input.defaultTranslator;
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

  getTranslatorConfig(name = this.defaultTranslator): NamedTranslatorConfig {
    if (!name) {
      throw new Error("未指定翻译器名称，且 defaultTranslator 未配置");
    }

    const config = this.translators[name];
    if (!config) {
      throw new Error(`未找到名为 '${name}' 的翻译器配置`);
    }

    return config;
  }

  createProvider(hooks?: ClientHooks): LlmClientProvider {
    return createProviderFromConfigs(this.llm, hooks);
  }

  createTranslatorRegistry(options: {
    provider?: LlmClientProvider;
    hooks?: ClientHooks;
    logger?: Logger;
    promptManager?: PromptManager;
  } = {}): TranslationProcessorRegistry {
    const provider = options.provider ?? this.createProvider(options.hooks);
    const logger = options.logger ?? NOOP_LOGGER;
    return new TranslationProcessorRegistry(provider, this.translators, {
      logger,
      promptManager: options.promptManager,
    });
  }
}
