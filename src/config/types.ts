/**
 * 定义全局配置模块共享的类型。
 *
 * 当前持久化 LLM 配置与翻译流程默认配置，
 * 便于在用户目录下统一管理模型、翻译器与术语更新器参数。
 */

import type {
  JsonObject,
  JsonValue,
  LlmModelType,
  LlmProvider,
  LlmRequestConfigInput,
} from "../llm/types.ts";
import type {
  GlossaryUpdaterConfig,
  TranslationProcessorConfig,
} from "../project/config.ts";

export const GLOBAL_CONFIG_VERSION = 1;
export const DEFAULT_GLOBAL_CONFIG_DIR_NAME = ".soloyakusha-ts";
export const DEFAULT_GLOBAL_CONFIG_FILE_NAME = "config.json";

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
};

export type GlobalTranslationConfig = {
  translationProcessor?: TranslationProcessorConfig;
  glossaryUpdater?: GlossaryUpdaterConfig;
};

export type GlobalConfigDocument = {
  version: typeof GLOBAL_CONFIG_VERSION;
  llm: GlobalLlmConfig;
  translation?: GlobalTranslationConfig;
};

export type GlobalConfigManagerOptions = {
  filePath?: string;
  appDirName?: string;
};

export type GlobalConfigJsonObject = JsonObject;
export type GlobalConfigJsonValue = JsonValue;
