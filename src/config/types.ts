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
  AlignmentRepairConfig,
  GlossaryUpdaterConfig,
  GlossaryExtractorConfig,
  PlotSummaryConfig,
  TranslationProcessorStepConfig,
  TranslationProcessorConfig,
} from "../project/config.ts";
import type { MultiStageStepName } from "../project/multi-stage-translation-processor.ts";
import type { SlidingWindowOptions } from "../project/types.ts";
import type {
  VectorDistanceMetric,
  VectorStoreProviderName,
} from "../vector/types.ts";

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
  supportsStructuredOutput?: boolean;
};

export type GlobalLlmConfig = {
  defaultProfileName?: string;
  profiles: Record<string, PersistedLlmClientConfig>;
  embedding?: PersistedLlmClientConfig;
};

export type PersistedVectorStoreConfig = {
  provider: VectorStoreProviderName;
  endpoint: string;
  apiKey?: string;
  apiKeyEnv?: string;
  defaultCollection?: string;
  distance: VectorDistanceMetric;
  timeoutMs: number;
  retries: number;
  extraHeaders?: Record<string, string>;
  options?: JsonObject;
};

export type GlobalVectorConfig = {
  defaultStoreName?: string;
  stores: Record<string, PersistedVectorStoreConfig>;
};

/** 旧版多步骤工作流的步骤模型覆盖（兼容字段）。 */
export type TranslatorModelOverrides = Record<string, string>;

export type TranslatorMetadata = {
  title?: string;
  description?: string;
};

export const DEFAULT_TRANSLATOR_SOURCE_LANGUAGE = "ja";
export const DEFAULT_TRANSLATOR_TARGET_LANGUAGE = "zh-CN";
export const DEFAULT_TRANSLATOR_PROMPT_SET = "ja-zhCN";

/** 命名翻译器注册条目，对应一种翻译工作流 + 参数组合。 */
export type TranslatorEntry = {
  /** 翻译器的人类可读元数据，用于前端自解释展示。 */
  metadata?: TranslatorMetadata;
  /** 由工作流绑定的源语言代码。 */
  sourceLanguage: string;
  /** 由工作流绑定的目标语言代码。 */
  targetLanguage: string;
  /** 由工作流绑定的翻译提示词套件。 */
  promptSet: string;
  /** 工作流类型，对应翻译处理器 workflow 参数，留空则使用 "default"。 */
  type?: string;
  /** 引用的 LLM Profile 名称链（默认工作流使用；多步骤工作流可作为兼容回退值）。 */
  modelNames: string[];
  /** 文本块级调度的最大并发数。 */
  maxConcurrentWorkItems?: number;
  slidingWindow?: SlidingWindowOptions;
  requestOptions?: ChatRequestOptions;
  /**
   * 各步骤的独立配置，供多步骤工作流使用。
   */
  steps?: Partial<Record<MultiStageStepName, TranslationProcessorStepConfig>>;
  /** 旧版步骤模型覆盖，兼容已有配置。 */
  models?: TranslatorModelOverrides;
  /**
   * 评审迭代次数（仅 multi-stage 工作流使用）。
   * 默认值为 2。
   */
  reviewIterations?: number;
};

export type GlobalTranslationConfig = {
  /** 命名翻译器目录，key 为翻译器名称。 */
  translators?: Record<string, TranslatorEntry>;
  /** @deprecated 迁移前的单一翻译处理器配置，新代码请使用 translators。 */
  translationProcessor?: TranslationProcessorConfig;
  glossaryExtractor?: GlossaryExtractorConfig;
  glossaryUpdater?: GlossaryUpdaterConfig;
  plotSummary?: PlotSummaryConfig;
  alignmentRepair?: AlignmentRepairConfig;
};

export type GlobalConfigDocument = {
  version: typeof GLOBAL_CONFIG_VERSION;
  llm: GlobalLlmConfig;
  vector?: GlobalVectorConfig;
  translation?: GlobalTranslationConfig;
  recentWorkspaces?: WorkspaceEntry[];
};

export type GlobalConfigManagerOptions = {
  filePath?: string;
  appDirName?: string;
};

export type GlobalConfigJsonObject = JsonObject;
export type GlobalConfigJsonValue = JsonValue;
