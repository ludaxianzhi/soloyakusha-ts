/**
 * 提供用户目录下全局配置文件的读取、校验与更新能力。
 *
 * 当前管理 LLM 配置与翻译默认配置：
 * - 多命名配置(profile) 的增删查改
 * - 默认 profile 设置
 * - 从持久化配置解析为运行时 LLM 客户端配置
 * - 翻译器与术语更新器默认配置的读写
 *
 * 配置文件默认位于：
 * - Windows: %USERPROFILE%\\.soloyakusha-ts\\config.json
 * - macOS/Linux: ~/.soloyakusha-ts/config.json
 *
 * @module config/manager
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createLlmClientConfig } from "../llm/types.ts";
import type {
  ChatRequestOptions,
  JsonObject,
  JsonValue,
  LlmClientConfig,
  LlmProvider,
  LlmRequestConfigInput,
} from "../llm/types.ts";
import { TranslationGlobalConfig } from "../project/config.ts";
import type {
  GlossaryUpdaterConfig,
  TranslationProcessorConfig,
} from "../project/config.ts";
import type { SlidingWindowOptions } from "../project/types.ts";
import type {
  GlobalConfigDocument,
  GlobalConfigManagerOptions,
  GlobalLlmConfig,
  GlobalTranslationConfig,
  PersistedLlmClientConfig,
  PersistedLlmRequestConfig,
} from "./types.ts";
import {
  DEFAULT_GLOBAL_CONFIG_DIR_NAME,
  DEFAULT_GLOBAL_CONFIG_FILE_NAME,
  GLOBAL_CONFIG_VERSION,
} from "./types.ts";

/**
 * 全局配置管理器。
 *
 * 实例会在首次访问时懒加载配置文件，并在写入后刷新内部缓存。
 * 对外仅暴露语义化 API，避免调用方直接操作底层 JSON 文档。
 */
export class GlobalConfigManager {
  private readonly filePath: string;
  private cachedDocument?: GlobalConfigDocument;

  constructor(options: GlobalConfigManagerOptions = {}) {
    this.filePath =
      options.filePath ?? getDefaultGlobalConfigFilePath(options.appDirName);
  }

  getFilePath(): string {
    return this.filePath;
  }

  async reload(): Promise<GlobalConfigDocument> {
    this.cachedDocument = await this.readDocumentFromDisk();
    return cloneDocument(this.cachedDocument);
  }

  async getDocument(): Promise<GlobalConfigDocument> {
    return cloneDocument(await this.loadDocument());
  }

  async getLlmConfig(): Promise<GlobalLlmConfig> {
    return cloneLlmConfig((await this.loadDocument()).llm);
  }

  async getTranslationConfig(): Promise<GlobalTranslationConfig | undefined> {
    return cloneTranslationConfig((await this.loadDocument()).translation);
  }

  async getTranslationProcessorConfig(): Promise<TranslationProcessorConfig | undefined> {
    return cloneTranslationProcessorConfig((await this.loadDocument()).translation?.translationProcessor);
  }

  async setTranslationProcessorConfig(
    config?: TranslationProcessorConfig,
  ): Promise<TranslationProcessorConfig | undefined> {
    const document = await this.loadDocument();
    const translation = document.translation ?? {};
    translation.translationProcessor = config
      ? normalizeTranslationProcessorConfig(config, "translation.translationProcessor")
      : undefined;
    document.translation = pruneEmptyTranslationConfig(translation);
    await this.persistDocument(document);
    return cloneTranslationProcessorConfig(document.translation?.translationProcessor);
  }

  async getGlossaryUpdaterConfig(): Promise<GlossaryUpdaterConfig | undefined> {
    return cloneGlossaryUpdaterConfig((await this.loadDocument()).translation?.glossaryUpdater);
  }

  async setGlossaryUpdaterConfig(
    config?: GlossaryUpdaterConfig,
  ): Promise<GlossaryUpdaterConfig | undefined> {
    const document = await this.loadDocument();
    const translation = document.translation ?? {};
    translation.glossaryUpdater = config
      ? normalizeGlossaryUpdaterConfig(config, "translation.glossaryUpdater")
      : undefined;
    document.translation = pruneEmptyTranslationConfig(translation);
    await this.persistDocument(document);
    return cloneGlossaryUpdaterConfig(document.translation?.glossaryUpdater);
  }

  async getTranslationGlobalConfig(): Promise<TranslationGlobalConfig> {
    return TranslationGlobalConfig.fromParsedObject({
      llm: {
        profiles: cloneProfiles((await this.loadDocument()).llm.profiles),
      },
      translation: cloneTranslationConfig((await this.loadDocument()).translation),
    });
  }

  async listLlmProfileNames(): Promise<string[]> {
    return Object.keys((await this.loadDocument()).llm.profiles).sort();
  }

  async getDefaultLlmProfileName(): Promise<string | undefined> {
    return (await this.loadDocument()).llm.defaultProfileName;
  }

  async setDefaultLlmProfileName(profileName?: string): Promise<void> {
    const document = await this.loadDocument();
    if (profileName !== undefined && !document.llm.profiles[profileName]) {
      throw new Error(`未找到名为 '${profileName}' 的 LLM 全局配置`);
    }

    document.llm.defaultProfileName = profileName;
    await this.persistDocument(document);
  }

  async getLlmProfile(
    profileName: string,
  ): Promise<PersistedLlmClientConfig | undefined> {
    const profile = (await this.loadDocument()).llm.profiles[profileName];
    return profile ? clonePersistedLlmClientConfig(profile) : undefined;
  }

  async getRequiredLlmProfile(profileName: string): Promise<PersistedLlmClientConfig> {
    const profile = await this.getLlmProfile(profileName);
    if (!profile) {
      throw new Error(`未找到名为 '${profileName}' 的 LLM 全局配置`);
    }

    return profile;
  }

  async getResolvedLlmProfile(profileName: string): Promise<LlmClientConfig> {
    const profile = await this.getRequiredLlmProfile(profileName);
    return createLlmClientConfig(profile);
  }

  async setLlmProfile(
    profileName: string,
    config: PersistedLlmClientConfig,
  ): Promise<PersistedLlmClientConfig> {
    validateProfileName(profileName);
    const document = await this.loadDocument();
    const normalized = normalizePersistedLlmClientConfig(
      config,
      `llm.profiles.${profileName}`,
    );

    document.llm.profiles[profileName] = normalized;
    await this.persistDocument(document);
    return clonePersistedLlmClientConfig(normalized);
  }

  async updateLlmProfile(
    profileName: string,
    updater: (current: PersistedLlmClientConfig) => PersistedLlmClientConfig,
  ): Promise<PersistedLlmClientConfig> {
    validateProfileName(profileName);
    const document = await this.loadDocument();
    const current = document.llm.profiles[profileName];
    if (!current) {
      throw new Error(`未找到名为 '${profileName}' 的 LLM 全局配置`);
    }

    const next = normalizePersistedLlmClientConfig(
      updater(clonePersistedLlmClientConfig(current)),
      `llm.profiles.${profileName}`,
    );
    document.llm.profiles[profileName] = next;
    await this.persistDocument(document);
    return clonePersistedLlmClientConfig(next);
  }

  async removeLlmProfile(profileName: string): Promise<boolean> {
    validateProfileName(profileName);
    const document = await this.loadDocument();
    if (!document.llm.profiles[profileName]) {
      return false;
    }

    delete document.llm.profiles[profileName];
    if (document.llm.defaultProfileName === profileName) {
      document.llm.defaultProfileName = undefined;
    }

    await this.persistDocument(document);
    return true;
  }

  private async loadDocument(): Promise<GlobalConfigDocument> {
    if (!this.cachedDocument) {
      this.cachedDocument = await this.readDocumentFromDisk();
    }

    return this.cachedDocument;
  }

  private async readDocumentFromDisk(): Promise<GlobalConfigDocument> {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as unknown;
      return normalizeGlobalConfigDocument(parsed, this.filePath);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return createEmptyDocument();
      }

      throw error;
    }
  }

  private async persistDocument(document: GlobalConfigDocument): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    this.cachedDocument = cloneDocument(document);
  }
}

export function getDefaultGlobalConfigFilePath(appDirName?: string): string {
  return join(
    homedir(),
    appDirName ?? DEFAULT_GLOBAL_CONFIG_DIR_NAME,
    DEFAULT_GLOBAL_CONFIG_FILE_NAME,
  );
}

function createEmptyDocument(): GlobalConfigDocument {
  return {
    version: GLOBAL_CONFIG_VERSION,
    llm: {
      profiles: {},
    },
  };
}

function normalizeGlobalConfigDocument(
  value: unknown,
  sourceLabel: string,
): GlobalConfigDocument {
  if (!isRecord(value)) {
    throw new Error(`全局配置文档必须是对象: ${sourceLabel}`);
  }

  const version = value.version;
  if (version !== undefined && version !== GLOBAL_CONFIG_VERSION) {
    throw new Error(`不支持的全局配置版本: ${String(version)} (${sourceLabel})`);
  }

  const llmValue = value.llm ?? {};
  if (!isRecord(llmValue)) {
    throw new Error(`全局配置的 llm 字段必须是对象: ${sourceLabel}`);
  }

  const profilesValue = llmValue.profiles ?? {};
  if (!isRecord(profilesValue)) {
    throw new Error(`全局配置的 llm.profiles 字段必须是对象: ${sourceLabel}`);
  }

  const profiles: Record<string, PersistedLlmClientConfig> = {};
  for (const [profileName, profileValue] of Object.entries(profilesValue)) {
    validateProfileName(profileName);
    profiles[profileName] = normalizePersistedLlmClientConfig(
      profileValue,
      `${sourceLabel}:llm.profiles.${profileName}`,
    );
  }

  const defaultProfileName = readOptionalString(
    llmValue.defaultProfileName,
    `${sourceLabel}:llm.defaultProfileName`,
  );
  if (defaultProfileName !== undefined && !profiles[defaultProfileName]) {
    throw new Error(
      `llm.defaultProfileName 指向了不存在的 profile: ${defaultProfileName} (${sourceLabel})`,
    );
  }

  const translation = normalizeOptionalTranslationConfig(
    value.translation,
    `${sourceLabel}:translation`,
  );

  return {
    version: GLOBAL_CONFIG_VERSION,
    llm: {
      defaultProfileName,
      profiles,
    },
    translation,
  };
}

function normalizePersistedLlmClientConfig(
  value: unknown,
  sourceLabel: string,
): PersistedLlmClientConfig {
  if (!isRecord(value)) {
    throw new Error(`LLM 配置必须是对象: ${sourceLabel}`);
  }

  const provider = normalizeLlmProvider(value.provider, `${sourceLabel}.provider`);
  const modelName = readRequiredString(value.modelName, `${sourceLabel}.modelName`);
  const endpoint = readRequiredString(value.endpoint, `${sourceLabel}.endpoint`);
  const apiKey = readOptionalString(value.apiKey, `${sourceLabel}.apiKey`);
  const apiKeyEnv = readOptionalString(value.apiKeyEnv, `${sourceLabel}.apiKeyEnv`);
  const modelType = normalizeModelType(value.modelType, `${sourceLabel}.modelType`);
  const retries = readOptionalNonNegativeInteger(value.retries, `${sourceLabel}.retries`) ?? 3;
  const qps = readOptionalPositiveNumber(value.qps, `${sourceLabel}.qps`);
  const maxParallelRequests = readOptionalPositiveInteger(
    value.maxParallelRequests,
    `${sourceLabel}.maxParallelRequests`,
  );
  const defaultRequestConfig =
    value.defaultRequestConfig === undefined
      ? undefined
      : normalizeRequestConfig(value.defaultRequestConfig, `${sourceLabel}.defaultRequestConfig`);

  if (apiKey && apiKeyEnv) {
    throw new Error(`${sourceLabel} 中 apiKey 和 apiKeyEnv 只能配置其中一个`);
  }

  if (!apiKey && !apiKeyEnv) {
    throw new Error(`${sourceLabel} 必须配置 apiKey 或 apiKeyEnv 其中一个`);
  }

  return {
    provider,
    modelName,
    apiKey,
    apiKeyEnv,
    endpoint,
    qps,
    maxParallelRequests,
    modelType,
    retries,
    defaultRequestConfig,
  };
}

function normalizeRequestConfig(
  value: unknown,
  sourceLabel: string,
): PersistedLlmRequestConfig {
  if (!isRecord(value)) {
    throw new Error(`请求配置必须是对象: ${sourceLabel}`);
  }

  const systemPrompt = readOptionalStringAllowEmpty(
    value.systemPrompt,
    `${sourceLabel}.systemPrompt`,
  );
  const temperature = readOptionalFiniteNumber(
    value.temperature,
    `${sourceLabel}.temperature`,
  );
  const maxTokens = readOptionalFiniteNumber(value.maxTokens, `${sourceLabel}.maxTokens`);
  const topP = readOptionalFiniteNumber(value.topP, `${sourceLabel}.topP`);
  const extraBody = normalizeOptionalJsonObject(value.extraBody, `${sourceLabel}.extraBody`);

  return {
    systemPrompt,
    temperature,
    maxTokens,
    topP,
    extraBody,
  };
}

function normalizeLlmProvider(value: unknown, sourceLabel: string): LlmProvider {
  if (value === undefined) {
    return "openai";
  }

  if (value === "openai" || value === "anthropic") {
    return value;
  }

  throw new Error(`provider 非法: ${sourceLabel}`);
}

function normalizeModelType(value: unknown, sourceLabel: string) {
  if (value === undefined) {
    return "chat";
  }

  if (value === "chat" || value === "embedding") {
    return value;
  }

  throw new Error(`modelType 非法: ${sourceLabel}`);
}

function normalizeOptionalJsonObject(
  value: unknown,
  sourceLabel: string,
): JsonObject | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isJsonObject(value)) {
    throw new Error(`extraBody 必须是 JSON 对象: ${sourceLabel}`);
  }

  return cloneJsonObject(value);
}

function cloneDocument(document: GlobalConfigDocument): GlobalConfigDocument {
  return {
    version: document.version,
    llm: cloneLlmConfig(document.llm),
    translation: cloneTranslationConfig(document.translation),
  };
}

function cloneLlmConfig(config: GlobalLlmConfig): GlobalLlmConfig {
  return {
    defaultProfileName: config.defaultProfileName,
    profiles: cloneProfiles(config.profiles),
  };
}

function cloneProfiles(
  profiles: Record<string, PersistedLlmClientConfig>,
): Record<string, PersistedLlmClientConfig> {
  const result: Record<string, PersistedLlmClientConfig> = {};
  for (const [profileName, profile] of Object.entries(profiles)) {
    result[profileName] = clonePersistedLlmClientConfig(profile);
  }

  return result;
}

function clonePersistedLlmClientConfig(
  config: PersistedLlmClientConfig,
): PersistedLlmClientConfig {
  return {
    provider: config.provider,
    modelName: config.modelName,
    apiKey: config.apiKey,
    apiKeyEnv: config.apiKeyEnv,
    endpoint: config.endpoint,
    qps: config.qps,
    maxParallelRequests: config.maxParallelRequests,
    modelType: config.modelType,
    retries: config.retries,
    defaultRequestConfig: config.defaultRequestConfig
      ? cloneRequestConfig(config.defaultRequestConfig)
      : undefined,
  };
}

function normalizeOptionalTranslationConfig(
  value: unknown,
  sourceLabel: string,
): GlobalTranslationConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error(`翻译配置必须是对象: ${sourceLabel}`);
  }

  return pruneEmptyTranslationConfig({
    translationProcessor:
      value.translationProcessor === undefined
        ? undefined
        : normalizeTranslationProcessorConfig(
            value.translationProcessor,
            `${sourceLabel}.translationProcessor`,
          ),
    glossaryUpdater:
      value.glossaryUpdater === undefined
        ? undefined
        : normalizeGlossaryUpdaterConfig(value.glossaryUpdater, `${sourceLabel}.glossaryUpdater`),
  });
}

function pruneEmptyTranslationConfig(
  config: GlobalTranslationConfig | undefined,
): GlobalTranslationConfig | undefined {
  if (!config?.translationProcessor && !config?.glossaryUpdater) {
    return undefined;
  }

  return {
    translationProcessor: cloneTranslationProcessorConfig(config.translationProcessor),
    glossaryUpdater: cloneGlossaryUpdaterConfig(config.glossaryUpdater),
  };
}

function normalizeTranslationProcessorConfig(
  value: unknown,
  sourceLabel: string,
): TranslationProcessorConfig {
  if (!isRecord(value)) {
    throw new Error(`翻译器配置必须是对象: ${sourceLabel}`);
  }

  return {
    workflow: readOptionalString(value.workflow, `${sourceLabel}.workflow`),
    modelName: readRequiredString(value.modelName, `${sourceLabel}.modelName`),
    slidingWindow:
      value.slidingWindow === undefined
        ? undefined
        : normalizeSlidingWindowOptions(value.slidingWindow, `${sourceLabel}.slidingWindow`),
    requestOptions:
      value.requestOptions === undefined
        ? undefined
        : normalizePersistedChatRequestOptions(value.requestOptions, `${sourceLabel}.requestOptions`),
  };
}

function normalizeGlossaryUpdaterConfig(
  value: unknown,
  sourceLabel: string,
): GlossaryUpdaterConfig {
  if (!isRecord(value)) {
    throw new Error(`术语更新器配置必须是对象: ${sourceLabel}`);
  }

  return {
    workflow: readOptionalString(value.workflow, `${sourceLabel}.workflow`),
    modelName: readRequiredString(value.modelName, `${sourceLabel}.modelName`),
    requestOptions:
      value.requestOptions === undefined
        ? undefined
        : normalizePersistedChatRequestOptions(value.requestOptions, `${sourceLabel}.requestOptions`),
  };
}

function normalizeSlidingWindowOptions(
  value: unknown,
  sourceLabel: string,
): SlidingWindowOptions {
  if (!isRecord(value)) {
    throw new Error(`滑动窗口配置必须是对象: ${sourceLabel}`);
  }

  return {
    overlapChars: readOptionalNonNegativeInteger(value.overlapChars, `${sourceLabel}.overlapChars`),
  };
}

function normalizePersistedChatRequestOptions(
  value: unknown,
  sourceLabel: string,
): ChatRequestOptions {
  if (!isRecord(value)) {
    throw new Error(`请求选项必须是对象: ${sourceLabel}`);
  }

  if (value.outputValidator !== undefined) {
    throw new Error(`全局配置不支持持久化 outputValidator: ${sourceLabel}.outputValidator`);
  }

  return {
    requestConfig:
      value.requestConfig === undefined
        ? undefined
        : normalizeSparseRequestConfig(value.requestConfig, `${sourceLabel}.requestConfig`),
    outputValidationContext:
      value.outputValidationContext === undefined
        ? undefined
        : normalizeOutputValidationContext(
            value.outputValidationContext,
            `${sourceLabel}.outputValidationContext`,
          ),
  };
}

function normalizeOutputValidationContext(
  value: unknown,
  sourceLabel: string,
): ChatRequestOptions["outputValidationContext"] {
  if (!isRecord(value)) {
    throw new Error(`输出校验上下文必须是对象: ${sourceLabel}`);
  }

  return {
    stageLabel: readOptionalString(value.stageLabel, `${sourceLabel}.stageLabel`),
    sourceLineCount: readOptionalFiniteNumber(
      value.sourceLineCount,
      `${sourceLabel}.sourceLineCount`,
    ),
    minLineRatio: readOptionalFiniteNumber(value.minLineRatio, `${sourceLabel}.minLineRatio`),
    modelName: readOptionalString(value.modelName, `${sourceLabel}.modelName`),
  };
}

function cloneTranslationConfig(
  config: GlobalTranslationConfig | undefined,
): GlobalTranslationConfig | undefined {
  if (!config) {
    return undefined;
  }

  return {
    translationProcessor: cloneTranslationProcessorConfig(config.translationProcessor),
    glossaryUpdater: cloneGlossaryUpdaterConfig(config.glossaryUpdater),
  };
}

function cloneTranslationProcessorConfig(
  config: TranslationProcessorConfig | undefined,
): TranslationProcessorConfig | undefined {
  if (!config) {
    return undefined;
  }

  return {
    workflow: config.workflow,
    modelName: config.modelName,
    slidingWindow: config.slidingWindow ? { ...config.slidingWindow } : undefined,
    requestOptions: config.requestOptions
      ? clonePersistedChatRequestOptions(config.requestOptions)
      : undefined,
  };
}

function cloneGlossaryUpdaterConfig(
  config: GlossaryUpdaterConfig | undefined,
): GlossaryUpdaterConfig | undefined {
  if (!config) {
    return undefined;
  }

  return {
    workflow: config.workflow,
    modelName: config.modelName,
    requestOptions: config.requestOptions
      ? clonePersistedChatRequestOptions(config.requestOptions)
      : undefined,
  };
}

function clonePersistedChatRequestOptions(config: ChatRequestOptions): ChatRequestOptions {
  return {
    requestConfig: config.requestConfig ? cloneSparseRequestConfig(config.requestConfig) : undefined,
    outputValidationContext: config.outputValidationContext
      ? {
          stageLabel: config.outputValidationContext.stageLabel,
          sourceLineCount: config.outputValidationContext.sourceLineCount,
          minLineRatio: config.outputValidationContext.minLineRatio,
          modelName: config.outputValidationContext.modelName,
        }
      : undefined,
  };
}

function normalizeSparseRequestConfig(
  value: unknown,
  sourceLabel: string,
): LlmRequestConfigInput {
  if (!isRecord(value)) {
    throw new Error(`请求配置必须是对象: ${sourceLabel}`);
  }

  const result: LlmRequestConfigInput = {};
  if (value.systemPrompt !== undefined) {
    result.systemPrompt = readOptionalStringAllowEmpty(
      value.systemPrompt,
      `${sourceLabel}.systemPrompt`,
    );
  }
  if (value.temperature !== undefined) {
    result.temperature = readOptionalFiniteNumber(value.temperature, `${sourceLabel}.temperature`);
  }
  if (value.maxTokens !== undefined) {
    result.maxTokens = readOptionalFiniteNumber(value.maxTokens, `${sourceLabel}.maxTokens`);
  }
  if (value.topP !== undefined) {
    result.topP = readOptionalFiniteNumber(value.topP, `${sourceLabel}.topP`);
  }
  if (value.extraBody !== undefined) {
    result.extraBody = normalizeOptionalJsonObject(value.extraBody, `${sourceLabel}.extraBody`);
  }

  return result;
}

function cloneSparseRequestConfig(config: LlmRequestConfigInput): LlmRequestConfigInput {
  return {
    ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
    ...(config.topP !== undefined ? { topP: config.topP } : {}),
    ...(config.extraBody !== undefined
      ? { extraBody: cloneJsonObject(config.extraBody) }
      : {}),
  };
}

function cloneRequestConfig(
  config: LlmRequestConfigInput,
): PersistedLlmRequestConfig {
  return {
    systemPrompt: config.systemPrompt,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    topP: config.topP,
    extraBody: config.extraBody ? cloneJsonObject(config.extraBody) : undefined,
  };
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, cloneJsonValue(entryValue)]),
  );
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonValue(entry));
  }

  if (isJsonObject(value)) {
    return cloneJsonObject(value);
  }

  return value;
}

function readRequiredString(value: unknown, sourceLabel: string): string {
  const result = readOptionalString(value, sourceLabel);
  if (!result) {
    throw new Error(`必须配置非空字符串: ${sourceLabel}`);
  }

  return result;
}

function readOptionalString(value: unknown, sourceLabel: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`字段必须是字符串: ${sourceLabel}`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`字段不能为空字符串: ${sourceLabel}`);
  }

  return trimmed;
}

function readOptionalStringAllowEmpty(
  value: unknown,
  sourceLabel: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`字段必须是字符串: ${sourceLabel}`);
  }

  return value;
}

function readOptionalFiniteNumber(value: unknown, sourceLabel: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`字段必须是有限数字: ${sourceLabel}`);
  }

  return value;
}

function readOptionalPositiveNumber(value: unknown, sourceLabel: string): number | undefined {
  const result = readOptionalFiniteNumber(value, sourceLabel);
  if (result === undefined) {
    return undefined;
  }

  if (result <= 0) {
    throw new Error(`字段必须大于 0: ${sourceLabel}`);
  }

  return result;
}

function readOptionalPositiveInteger(value: unknown, sourceLabel: string): number | undefined {
  const result = readOptionalFiniteNumber(value, sourceLabel);
  if (result === undefined) {
    return undefined;
  }

  if (!Number.isInteger(result) || result <= 0) {
    throw new Error(`字段必须是正整数: ${sourceLabel}`);
  }

  return result;
}

function readOptionalNonNegativeInteger(
  value: unknown,
  sourceLabel: string,
): number | undefined {
  const result = readOptionalFiniteNumber(value, sourceLabel);
  if (result === undefined) {
    return undefined;
  }

  if (!Number.isInteger(result) || result < 0) {
    throw new Error(`字段必须是非负整数: ${sourceLabel}`);
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateProfileName(profileName: string): void {
  if (profileName.trim().length === 0) {
    throw new Error("LLM profile 名称不能为空字符串");
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!isRecord(value) || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => isJsonValue(entry));
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }

  return isJsonObject(value);
}

function isFileNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
