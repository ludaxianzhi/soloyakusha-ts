/**
 * 定义全局配置模块共享的类型。
 *
 * 当前持久化 LLM 配置与翻译流程默认配置，
 * 便于在用户目录下统一管理模型、翻译器与术语更新器参数。
 */

import type {
  ChatRequestOptions,
  JsonObject,
  JsonValue,
  LlmModelType,
  LlmProvider,
  LlmRequestConfigInput,
} from "../llm/types.ts";
import type {
  GlossaryUpdaterConfig,
  GlossaryExtractorConfig,
  PlotSummaryConfig,
  TranslationProcessorConfig,
} from "../project/config.ts";
import type { SlidingWindowOptions } from "../project/types.ts";

export const GLOBAL_CONFIG_VERSION = 1;
export const DEFAULT_GLOBAL_CONFIG_DIR_NAME = ".soloyakusha-ts";
export const DEFAULT_GLOBAL_CONFIG_FILE_NAME = "config.json";

/** 全局工作区注册表条目，记录已知工作区的基本信息。 */
export type WorkspaceEntry = {
  name: string;
  dir: string;
  lastOpenedAt: string;
};

export type PersistedLlmRequestConfig = LlmRequestConfigInput;

export type PersistedLlmClientConfig = {
  provider: LlmProvider;
  modelName: string;
  apiKey?: string;
  apiKeyEnv?: string;
  endpoint: string;
  qps?: number;
  maxParallelRequests?: number;
  modelType: LlmModelType;
  retries: number;
  defaultRequestConfig?: PersistedLlmRequestConfig;
};

export type GlobalLlmConfig = {
  defaultProfileName?: string;
  profiles: Record<string, PersistedLlmClientConfig>;
  embedding?: PersistedLlmClientConfig;
};

/** 命名翻译器注册条目，对应一种翻译工作流 + 参数组合。 */
export type TranslatorEntry = {
  /** 工作流类型，对应翻译处理器 workflow 参数，留空则使用 "default"。 */
  type?: string;
  /** 引用的 LLM Profile 名称。 */
  modelName: string;
  slidingWindow?: SlidingWindowOptions;
  requestOptions?: ChatRequestOptions;
};

export type GlobalTranslationConfig = {
  /** 命名翻译器目录，key 为翻译器名称。 */
  translators?: Record<string, TranslatorEntry>;
  /** @deprecated 迁移前的单一翻译处理器配置，新代码请使用 translators。 */
  translationProcessor?: TranslationProcessorConfig;
  glossaryExtractor?: GlossaryExtractorConfig;
  glossaryUpdater?: GlossaryUpdaterConfig;
  plotSummary?: PlotSummaryConfig;
};

export type GlobalConfigDocument = {
  version: typeof GLOBAL_CONFIG_VERSION;
  llm: GlobalLlmConfig;
  translation?: GlobalTranslationConfig;
  recentWorkspaces?: WorkspaceEntry[];
};

export type GlobalConfigManagerOptions = {
  filePath?: string;
  appDirName?: string;
};

export type GlobalConfigJsonObject = JsonObject;
export type GlobalConfigJsonValue = JsonValue;
