/**
 * 定义全局配置模块共享的类型。
 *
 * 当前仅持久化 LLM 配置，但顶层文档保留了扩展入口，
 * 后续可继续加入 prompt、project defaults 等全局设置。
 */

import type {
  JsonObject,
  JsonValue,
  LlmModelType,
  LlmProvider,
  LlmRequestConfigInput,
} from "../llm/types.ts";

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

export type GlobalConfigDocument = {
  version: typeof GLOBAL_CONFIG_VERSION;
  llm: GlobalLlmConfig;
};

export type GlobalConfigManagerOptions = {
  filePath?: string;
  appDirName?: string;
};

export type GlobalConfigJsonObject = JsonObject;
export type GlobalConfigJsonValue = JsonValue;