import type {
  ChatRequestOptions,
  JsonObject,
  JsonValue,
  LlmProvider,
  LlmRequestConfigInput,
} from "../llm/types.ts";
import type {
  AlignmentRepairConfig,
  GlossaryExtractorConfig,
  GlossaryUpdaterConfig,
  PlotSummaryConfig,
  TranslationProcessorStepConfig,
  TranslationProcessorConfig,
} from "../project/config.ts";
import {
  MULTI_STAGE_STEP_NAMES,
  type MultiStageStepName,
} from "../project/multi-stage-translation-processor.ts";
import type { SlidingWindowOptions } from "../project/types.ts";
import type {
  GlobalConfigDocument,
  GlobalLlmConfig,
  GlobalTranslationConfig,
  GlobalVectorConfig,
  PersistedLlmClientConfig,
  PersistedLlmRequestConfig,
  PersistedVectorStoreConfig,
  TranslatorMetadata,
  TranslatorEntry,
  WorkspaceEntry,
} from "./types.ts";
import {
  GLOBAL_CONFIG_VERSION,
  DEFAULT_TRANSLATOR_PROMPT_SET,
  DEFAULT_TRANSLATOR_SOURCE_LANGUAGE,
  DEFAULT_TRANSLATOR_TARGET_LANGUAGE,
} from "./types.ts";

export function createEmptyDocument(): GlobalConfigDocument {
  return {
    version: GLOBAL_CONFIG_VERSION,
    llm: {
      profiles: {},
    },
  };
}

export function normalizeGlobalConfigDocument(
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

  const embedding =
    llmValue.embedding === undefined
      ? undefined
      : normalizePersistedLlmClientConfig(
          llmValue.embedding,
          `${sourceLabel}:llm.embedding`,
        );
  if (embedding && embedding.modelType !== "embedding") {
    throw new Error(`llm.embedding 必须是 embedding 类型配置: ${sourceLabel}`);
  }

  const vector =
    value.vector === undefined
      ? undefined
      : normalizeVectorConfig(value.vector, `${sourceLabel}:vector`);

  const translation = normalizeOptionalTranslationConfig(
    value.translation,
    `${sourceLabel}:translation`,
  );

  const recentWorkspaces = normalizeOptionalWorkspaceEntries(
    value.recentWorkspaces,
    `${sourceLabel}:recentWorkspaces`,
  );

  return {
    version: GLOBAL_CONFIG_VERSION,
    llm: {
      defaultProfileName,
      profiles,
      embedding,
    },
    vector,
    translation,
    recentWorkspaces,
  };
}

export function normalizePersistedLlmClientConfig(
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

export function normalizeTranslationProcessorConfig(
  value: unknown,
  sourceLabel: string,
): TranslationProcessorConfig {
  if (!isRecord(value)) {
    throw new Error(`翻译器配置必须是对象: ${sourceLabel}`);
  }

  const result: TranslationProcessorConfig = {
    workflow: readOptionalString(value.workflow, `${sourceLabel}.workflow`),
    modelNames: readRequiredModelNames(value, sourceLabel),
    slidingWindow:
      value.slidingWindow === undefined
        ? undefined
        : normalizeSlidingWindowOptions(value.slidingWindow, `${sourceLabel}.slidingWindow`),
    requestOptions:
      value.requestOptions === undefined
        ? undefined
        : normalizePersistedChatRequestOptions(value.requestOptions, `${sourceLabel}.requestOptions`),
    models: normalizeTranslatorModelOverrides(value.models, `${sourceLabel}.models`),
    reviewIterations: readOptionalNonNegativeInteger(
      value.reviewIterations,
      `${sourceLabel}.reviewIterations`,
    ),
  };

  const steps = normalizeTranslationProcessorStepConfigs(value.steps, `${sourceLabel}.steps`);
  if (steps) {
    result.steps = steps;
  }

  return result;
}

export function normalizeTranslatorEntry(
  value: unknown,
  sourceLabel: string,
): TranslatorEntry {
  if (!isRecord(value)) {
    throw new Error(`翻译器条目必须是对象: ${sourceLabel}`);
  }

  const steps = normalizeTranslationProcessorStepConfigs(value.steps, `${sourceLabel}.steps`);
  const models = normalizeTranslatorModelOverrides(value.models, `${sourceLabel}.models`);
  const requestOptions =
    value.requestOptions === undefined
      ? undefined
      : normalizePersistedChatRequestOptions(value.requestOptions, `${sourceLabel}.requestOptions`);
  const reviewIterations = readOptionalNonNegativeInteger(
    value.reviewIterations,
    `${sourceLabel}.reviewIterations`,
  );
  const baseModelNames = readRequiredModelNames(value, sourceLabel);
  const workflowType = readOptionalString(value.type, `${sourceLabel}.type`);
  const effectiveSteps =
    steps ??
    (workflowType === "multi-stage" || models !== undefined
      ? buildLegacyTranslatorStepConfigs(baseModelNames, models, requestOptions)
      : undefined);

  const result: TranslatorEntry = {
    metadata: normalizeTranslatorMetadata(value.metadata, `${sourceLabel}.metadata`),
    sourceLanguage:
      readOptionalString(value.sourceLanguage, `${sourceLabel}.sourceLanguage`) ??
      DEFAULT_TRANSLATOR_SOURCE_LANGUAGE,
    targetLanguage:
      readOptionalString(value.targetLanguage, `${sourceLabel}.targetLanguage`) ??
      DEFAULT_TRANSLATOR_TARGET_LANGUAGE,
    promptSet:
      readOptionalString(value.promptSet, `${sourceLabel}.promptSet`) ??
      DEFAULT_TRANSLATOR_PROMPT_SET,
    type: workflowType,
    modelNames: baseModelNames,
    slidingWindow:
      value.slidingWindow === undefined
        ? undefined
        : normalizeSlidingWindowOptions(value.slidingWindow, `${sourceLabel}.slidingWindow`),
    requestOptions,
    models,
    reviewIterations,
  };

  if (effectiveSteps) {
    result.steps = effectiveSteps;
  }

  return result;
}

function normalizeTranslatorModelOverrides(
  value: unknown,
  sourceLabel: string,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error(`翻译器步骤模型覆盖必须是对象: ${sourceLabel}`);
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${sourceLabel}.${key} 必须是非空字符串`);
    }
    result[key] = entry;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeTranslationProcessorStepConfigs(
  value: unknown,
  sourceLabel: string,
): Partial<Record<MultiStageStepName, TranslationProcessorStepConfig>> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error(`步骤配置必须是对象: ${sourceLabel}`);
  }

  const result: Partial<Record<MultiStageStepName, TranslationProcessorStepConfig>> = {};
  for (const [stepName, stepValue] of Object.entries(value)) {
    if (!MULTI_STAGE_STEP_NAMES.includes(stepName as MultiStageStepName)) {
      throw new Error(`${sourceLabel}.${stepName} 不是受支持的步骤`);
    }
    if (!isRecord(stepValue)) {
      throw new Error(`${sourceLabel}.${stepName} 必须是对象`);
    }

    result[stepName as MultiStageStepName] = {
      modelNames: readRequiredModelNames(stepValue, `${sourceLabel}.${stepName}`),
      requestOptions:
        stepValue.requestOptions === undefined
          ? undefined
          : normalizePersistedChatRequestOptions(
              stepValue.requestOptions,
              `${sourceLabel}.${stepName}.requestOptions`,
            ),
    };
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function buildLegacyTranslatorStepConfigs(
  baseModelNames: string[],
  models: Record<string, string> | undefined,
  requestOptions: ChatRequestOptions | undefined,
): Partial<Record<MultiStageStepName, TranslationProcessorStepConfig>> | undefined {
  const result: Partial<Record<MultiStageStepName, TranslationProcessorStepConfig>> = {};
  for (const stepName of MULTI_STAGE_STEP_NAMES) {
    result[stepName] = {
      modelNames: models?.[stepName] ? [models[stepName]] : [...baseModelNames],
      requestOptions: requestOptions ? clonePersistedChatRequestOptions(requestOptions) : undefined,
    };
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function cloneTranslationProcessorStepConfigs(
  steps: Partial<Record<MultiStageStepName, TranslationProcessorStepConfig>> | undefined,
): Partial<Record<MultiStageStepName, TranslationProcessorStepConfig>> | undefined {
  if (!steps) {
    return undefined;
  }

  const result: Partial<Record<MultiStageStepName, TranslationProcessorStepConfig>> = {};
  for (const [stepName, stepConfig] of Object.entries(steps)) {
    if (!stepConfig) {
      continue;
    }

    result[stepName as MultiStageStepName] = {
      modelNames: [...stepConfig.modelNames],
      requestOptions: stepConfig.requestOptions
        ? clonePersistedChatRequestOptions(stepConfig.requestOptions)
        : undefined,
    };
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function normalizePersistedVectorStoreConfig(
  value: unknown,
  sourceLabel: string,
): PersistedVectorStoreConfig {
  if (!isRecord(value)) {
    throw new Error(`向量数据库配置必须是对象: ${sourceLabel}`);
  }

  const provider = normalizeVectorStoreProvider(value.provider, `${sourceLabel}.provider`);
  const endpoint = readRequiredString(value.endpoint, `${sourceLabel}.endpoint`);
  const apiKey = readOptionalString(value.apiKey, `${sourceLabel}.apiKey`);
  const apiKeyEnv = readOptionalString(value.apiKeyEnv, `${sourceLabel}.apiKeyEnv`);
  const defaultCollection = readOptionalString(
    value.defaultCollection,
    `${sourceLabel}.defaultCollection`,
  );
  const distance = normalizeVectorDistance(value.distance, `${sourceLabel}.distance`);
  const timeoutMs =
    readOptionalPositiveInteger(value.timeoutMs, `${sourceLabel}.timeoutMs`) ?? 60_000;
  const retries = readOptionalNonNegativeInteger(value.retries, `${sourceLabel}.retries`) ?? 3;
  const extraHeaders = normalizeOptionalStringMap(
    value.extraHeaders,
    `${sourceLabel}.extraHeaders`,
  );
  const options = normalizeOptionalJsonObject(value.options, `${sourceLabel}.options`);

  if (apiKey && apiKeyEnv) {
    throw new Error(`${sourceLabel} 中 apiKey 和 apiKeyEnv 只能配置其中一个`);
  }

  return {
    provider,
    endpoint,
    apiKey,
    apiKeyEnv,
    defaultCollection,
    distance,
    timeoutMs,
    retries,
    extraHeaders,
    options,
  };
}

export function normalizeVectorConfig(
  value: unknown,
  sourceLabel: string,
): GlobalVectorConfig {
  if (!isRecord(value)) {
    throw new Error(`全局配置的 vector 字段必须是对象: ${sourceLabel}`);
  }

  const storesValue = value.stores ?? {};
  if (!isRecord(storesValue)) {
    throw new Error(`全局配置的 vector.stores 字段必须是对象: ${sourceLabel}`);
  }

  const stores: Record<string, PersistedVectorStoreConfig> = {};
  for (const [storeName, storeValue] of Object.entries(storesValue)) {
    validateProfileName(storeName);
    stores[storeName] = normalizePersistedVectorStoreConfig(
      storeValue,
      `${sourceLabel}.stores.${storeName}`,
    );
  }

  const defaultStoreName = readOptionalString(
    value.defaultStoreName,
    `${sourceLabel}.defaultStoreName`,
  );
  if (defaultStoreName !== undefined && !stores[defaultStoreName]) {
    throw new Error(
      `vector.defaultStoreName 指向了不存在的 store: ${defaultStoreName} (${sourceLabel})`,
    );
  }

  return {
    defaultStoreName,
    stores,
  };
}

export function normalizeTranslators(
  value: unknown,
  sourceLabel: string,
): Record<string, TranslatorEntry> {
  if (!isRecord(value)) {
    throw new Error(`翻译器目录必须是对象: ${sourceLabel}`);
  }

  const result: Record<string, TranslatorEntry> = {};
  for (const [name, entry] of Object.entries(value)) {
    result[name] = normalizeTranslatorEntry(entry, `${sourceLabel}.${name}`);
  }

  return result;
}

export function normalizeGlossaryExtractorConfig(
  value: unknown,
  sourceLabel: string,
): GlossaryExtractorConfig {
  if (!isRecord(value)) {
    throw new Error(`术语提取器配置必须是对象: ${sourceLabel}`);
  }

  return {
    modelNames: readRequiredModelNames(value, sourceLabel),
    maxCharsPerBatch: readOptionalPositiveInteger(
      value.maxCharsPerBatch,
      `${sourceLabel}.maxCharsPerBatch`,
    ),
    occurrenceTopK: readOptionalPositiveInteger(
      value.occurrenceTopK,
      `${sourceLabel}.occurrenceTopK`,
    ),
    occurrenceTopP: readOptionalUnitInterval(
      value.occurrenceTopP,
      `${sourceLabel}.occurrenceTopP`,
    ),
    requestOptions:
      value.requestOptions === undefined
        ? undefined
        : normalizePersistedChatRequestOptions(value.requestOptions, `${sourceLabel}.requestOptions`),
  };
}

export function normalizeGlossaryUpdaterConfig(
  value: unknown,
  sourceLabel: string,
): GlossaryUpdaterConfig {
  if (!isRecord(value)) {
    throw new Error(`术语更新器配置必须是对象: ${sourceLabel}`);
  }

  return {
    workflow: readOptionalString(value.workflow, `${sourceLabel}.workflow`),
    modelNames: readRequiredModelNames(value, sourceLabel),
    requestOptions:
      value.requestOptions === undefined
        ? undefined
        : normalizePersistedChatRequestOptions(value.requestOptions, `${sourceLabel}.requestOptions`),
  };
}

export function normalizePlotSummaryConfig(
  value: unknown,
  sourceLabel: string,
): PlotSummaryConfig {
  if (!isRecord(value)) {
    throw new Error(`情节总结配置必须是对象: ${sourceLabel}`);
  }

  return {
    modelNames: readRequiredModelNames(value, sourceLabel),
    fragmentsPerBatch: readOptionalPositiveInteger(
      value.fragmentsPerBatch,
      `${sourceLabel}.fragmentsPerBatch`,
    ),
    maxContextSummaries: readOptionalPositiveInteger(
      value.maxContextSummaries,
      `${sourceLabel}.maxContextSummaries`,
    ),
    requestOptions:
      value.requestOptions === undefined
        ? undefined
        : normalizePersistedChatRequestOptions(value.requestOptions, `${sourceLabel}.requestOptions`),
  };
}

export function normalizeAlignmentRepairConfig(
  value: unknown,
  sourceLabel: string,
): AlignmentRepairConfig {
  if (!isRecord(value)) {
    throw new Error(`对齐补翻配置必须是对象: ${sourceLabel}`);
  }

  return {
    modelNames: readRequiredModelNames(value, sourceLabel),
    requestOptions:
      value.requestOptions === undefined
        ? undefined
        : normalizePersistedChatRequestOptions(value.requestOptions, `${sourceLabel}.requestOptions`),
  };
}

export function normalizePersistedChatRequestOptions(
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

export function normalizeOptionalTranslationConfig(
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
    translators:
      value.translators === undefined
        ? undefined
        : normalizeTranslators(value.translators, `${sourceLabel}.translators`),
    translationProcessor:
      value.translationProcessor === undefined
        ? undefined
        : normalizeTranslationProcessorConfig(
            value.translationProcessor,
            `${sourceLabel}.translationProcessor`,
          ),
    glossaryExtractor:
      value.glossaryExtractor === undefined
        ? undefined
        : normalizeGlossaryExtractorConfig(
            value.glossaryExtractor,
            `${sourceLabel}.glossaryExtractor`,
          ),
    glossaryUpdater:
      value.glossaryUpdater === undefined
        ? undefined
        : normalizeGlossaryUpdaterConfig(value.glossaryUpdater, `${sourceLabel}.glossaryUpdater`),
    plotSummary:
      value.plotSummary === undefined
        ? undefined
        : normalizePlotSummaryConfig(value.plotSummary, `${sourceLabel}.plotSummary`),
    alignmentRepair:
      value.alignmentRepair === undefined
        ? undefined
        : normalizeAlignmentRepairConfig(
            value.alignmentRepair,
            `${sourceLabel}.alignmentRepair`,
          ),
  });
}

export function pruneEmptyTranslationConfig(
  config: GlobalTranslationConfig | undefined,
): GlobalTranslationConfig | undefined {
  const hasTranslators = config?.translators && Object.keys(config.translators).length > 0;
  if (
    !hasTranslators &&
    !config?.translationProcessor &&
    !config?.glossaryExtractor &&
    !config?.glossaryUpdater &&
    !config?.plotSummary &&
    !config?.alignmentRepair
  ) {
    return undefined;
  }

  return {
    translators: cloneTranslators(config?.translators),
    translationProcessor: cloneTranslationProcessorConfig(config?.translationProcessor),
    glossaryExtractor: cloneGlossaryExtractorConfig(config?.glossaryExtractor),
    glossaryUpdater: cloneGlossaryUpdaterConfig(config?.glossaryUpdater),
    plotSummary: clonePlotSummaryConfig(config?.plotSummary),
    alignmentRepair: cloneAlignmentRepairConfig(config?.alignmentRepair),
  };
}

export function cloneDocument(document: GlobalConfigDocument): GlobalConfigDocument {
  return {
    version: document.version,
    llm: cloneLlmConfig(document.llm),
    vector: cloneVectorConfig(document.vector),
    translation: cloneTranslationConfig(document.translation),
    recentWorkspaces: document.recentWorkspaces
      ? [...document.recentWorkspaces.map(cloneWorkspaceEntry)]
      : undefined,
  };
}

export function cloneLlmConfig(config: GlobalLlmConfig): GlobalLlmConfig {
  return {
    defaultProfileName: config.defaultProfileName,
    profiles: cloneProfiles(config.profiles),
    embedding: config.embedding ? clonePersistedLlmClientConfig(config.embedding) : undefined,
  };
}

export function cloneVectorConfig(
  config: GlobalVectorConfig | undefined,
): GlobalVectorConfig | undefined {
  if (!config) {
    return undefined;
  }

  const stores: Record<string, PersistedVectorStoreConfig> = {};
  for (const [name, store] of Object.entries(config.stores)) {
    stores[name] = clonePersistedVectorStoreConfig(store);
  }

  return {
    defaultStoreName: config.defaultStoreName,
    stores,
  };
}

export function cloneTranslationConfig(
  config: GlobalTranslationConfig | undefined,
): GlobalTranslationConfig | undefined {
  if (!config) {
    return undefined;
  }

  return {
    translators: cloneTranslators(config.translators),
    translationProcessor: cloneTranslationProcessorConfig(config.translationProcessor),
    glossaryExtractor: cloneGlossaryExtractorConfig(config.glossaryExtractor),
    glossaryUpdater: cloneGlossaryUpdaterConfig(config.glossaryUpdater),
    plotSummary: clonePlotSummaryConfig(config.plotSummary),
    alignmentRepair: cloneAlignmentRepairConfig(config.alignmentRepair),
  };
}

export function cloneTranslatorEntry(entry: TranslatorEntry): TranslatorEntry {
  const result: TranslatorEntry = {
    metadata: entry.metadata ? { ...entry.metadata } : undefined,
    sourceLanguage: entry.sourceLanguage,
    targetLanguage: entry.targetLanguage,
    promptSet: entry.promptSet,
    type: entry.type,
    modelNames: [...entry.modelNames],
    slidingWindow: entry.slidingWindow ? { ...entry.slidingWindow } : undefined,
    requestOptions: entry.requestOptions
      ? clonePersistedChatRequestOptions(entry.requestOptions)
      : undefined,
    models: entry.models ? { ...entry.models } : undefined,
    reviewIterations: entry.reviewIterations,
  };

  const steps = cloneTranslationProcessorStepConfigs(entry.steps);
  if (steps) {
    result.steps = steps;
  }

  return result;
}

export function cloneTranslators(
  translators: Record<string, TranslatorEntry> | undefined,
): Record<string, TranslatorEntry> | undefined {
  if (!translators) {
    return undefined;
  }

  const result: Record<string, TranslatorEntry> = {};
  for (const [name, entry] of Object.entries(translators)) {
    result[name] = cloneTranslatorEntry(entry);
  }

  return result;
}

export function cloneTranslationProcessorConfig(
  config: TranslationProcessorConfig | undefined,
): TranslationProcessorConfig | undefined {
  if (!config) {
    return undefined;
  }

  const result: TranslationProcessorConfig = {
    workflow: config.workflow,
    modelNames: [...config.modelNames],
    slidingWindow: config.slidingWindow ? { ...config.slidingWindow } : undefined,
    requestOptions: config.requestOptions
      ? clonePersistedChatRequestOptions(config.requestOptions)
      : undefined,
    models: config.models ? { ...config.models } : undefined,
    reviewIterations: config.reviewIterations,
  };

  const steps = cloneTranslationProcessorStepConfigs(config.steps);
  if (steps) {
    result.steps = steps;
  }

  return result;
}

export function cloneGlossaryExtractorConfig(
  config: GlossaryExtractorConfig | undefined,
): GlossaryExtractorConfig | undefined {
  if (!config) {
    return undefined;
  }

  return {
    modelNames: [...config.modelNames],
    maxCharsPerBatch: config.maxCharsPerBatch,
    occurrenceTopK: config.occurrenceTopK,
    occurrenceTopP: config.occurrenceTopP,
    requestOptions: config.requestOptions
      ? clonePersistedChatRequestOptions(config.requestOptions)
      : undefined,
  };
}

export function cloneGlossaryUpdaterConfig(
  config: GlossaryUpdaterConfig | undefined,
): GlossaryUpdaterConfig | undefined {
  if (!config) {
    return undefined;
  }

  return {
    workflow: config.workflow,
    modelNames: [...config.modelNames],
    requestOptions: config.requestOptions
      ? clonePersistedChatRequestOptions(config.requestOptions)
      : undefined,
  };
}

export function clonePlotSummaryConfig(
  config: PlotSummaryConfig | undefined,
): PlotSummaryConfig | undefined {
  if (!config) {
    return undefined;
  }

  return {
    modelNames: [...config.modelNames],
    fragmentsPerBatch: config.fragmentsPerBatch,
    maxContextSummaries: config.maxContextSummaries,
    requestOptions: config.requestOptions
      ? clonePersistedChatRequestOptions(config.requestOptions)
      : undefined,
  };
}

export function cloneAlignmentRepairConfig(
  config: AlignmentRepairConfig | undefined,
): AlignmentRepairConfig | undefined {
  if (!config) {
    return undefined;
  }

  return {
    modelNames: [...config.modelNames],
    requestOptions: config.requestOptions
      ? clonePersistedChatRequestOptions(config.requestOptions)
      : undefined,
  };
}

export function cloneProfiles(
  profiles: Record<string, PersistedLlmClientConfig>,
): Record<string, PersistedLlmClientConfig> {
  const result: Record<string, PersistedLlmClientConfig> = {};
  for (const [profileName, profile] of Object.entries(profiles)) {
    result[profileName] = clonePersistedLlmClientConfig(profile);
  }

  return result;
}

export function clonePersistedLlmClientConfig(
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

export function clonePersistedVectorStoreConfig(
  config: PersistedVectorStoreConfig,
): PersistedVectorStoreConfig {
  return {
    provider: config.provider,
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    apiKeyEnv: config.apiKeyEnv,
    defaultCollection: config.defaultCollection,
    distance: config.distance,
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    extraHeaders: config.extraHeaders ? { ...config.extraHeaders } : undefined,
    options: config.options ? cloneJsonObject(config.options) : undefined,
  };
}

function normalizeRequestConfig(
  value: unknown,
  sourceLabel: string,
): PersistedLlmRequestConfig {
  if (!isRecord(value)) {
    throw new Error(`请求配置必须是对象: ${sourceLabel}`);
  }

  const systemPromptValue = readAliasedConfigValue(
    value,
    ["systemPrompt", "system_prompt"],
    sourceLabel,
  );
  const temperatureValue = readAliasedConfigValue(
    value,
    ["temperature"],
    sourceLabel,
  );
  const maxTokensValue = readAliasedConfigValue(
    value,
    ["maxTokens", "max_tokens"],
    sourceLabel,
  );
  const topPValue = readAliasedConfigValue(value, ["topP", "top_p"], sourceLabel);
  const extraBodyValue = readAliasedConfigValue(
    value,
    ["extraBody", "extra_body"],
    sourceLabel,
  );
  const systemPrompt = readOptionalStringAllowEmpty(
    systemPromptValue,
    `${sourceLabel}.systemPrompt`,
  );
  const temperature = readOptionalFiniteNumber(
    temperatureValue,
    `${sourceLabel}.temperature`,
  );
  const maxTokens = readOptionalFiniteNumber(
    maxTokensValue,
    `${sourceLabel}.maxTokens`,
  );
  const topP = readOptionalFiniteNumber(topPValue, `${sourceLabel}.topP`);
  const extraBody = normalizeOptionalJsonObject(
    extraBodyValue,
    `${sourceLabel}.extraBody`,
  );

  return {
    systemPrompt,
    temperature,
    maxTokens,
    topP,
    extraBody,
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
  const systemPromptValue = readAliasedConfigValue(
    value,
    ["systemPrompt", "system_prompt"],
    sourceLabel,
  );
  if (systemPromptValue !== undefined) {
    result.systemPrompt = readOptionalStringAllowEmpty(
      systemPromptValue,
      `${sourceLabel}.systemPrompt`,
    );
  }
  const temperatureValue = readAliasedConfigValue(
    value,
    ["temperature"],
    sourceLabel,
  );
  if (temperatureValue !== undefined) {
    result.temperature = readOptionalFiniteNumber(
      temperatureValue,
      `${sourceLabel}.temperature`,
    );
  }
  const maxTokensValue = readAliasedConfigValue(
    value,
    ["maxTokens", "max_tokens"],
    sourceLabel,
  );
  if (maxTokensValue !== undefined) {
    result.maxTokens = readOptionalFiniteNumber(
      maxTokensValue,
      `${sourceLabel}.maxTokens`,
    );
  }
  const topPValue = readAliasedConfigValue(
    value,
    ["topP", "top_p"],
    sourceLabel,
  );
  if (topPValue !== undefined) {
    result.topP = readOptionalFiniteNumber(topPValue, `${sourceLabel}.topP`);
  }
  const extraBodyValue = readAliasedConfigValue(
    value,
    ["extraBody", "extra_body"],
    sourceLabel,
  );
  if (extraBodyValue !== undefined) {
    result.extraBody = normalizeOptionalJsonObject(
      extraBodyValue,
      `${sourceLabel}.extraBody`,
    );
  }

  return result;
}

function readAliasedConfigValue(
  value: Record<string, unknown>,
  keys: readonly string[],
  sourceLabel: string,
): unknown {
  const matchedKeys = keys.filter((key) => value[key] !== undefined);
  if (matchedKeys.length > 1) {
    throw new Error(
      `${sourceLabel} 中 ${matchedKeys.join(" / ")} 只能配置其中一个`,
    );
  }
  const matchedKey = matchedKeys[0];
  return matchedKey === undefined ? undefined : value[matchedKey];
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

function normalizeTranslatorMetadata(
  value: unknown,
  sourceLabel: string,
): TranslatorMetadata | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error(`翻译器元数据必须是对象: ${sourceLabel}`);
  }

  const title = readOptionalStringAllowEmpty(value.title, `${sourceLabel}.title`)?.trim();
  const description = readOptionalStringAllowEmpty(
    value.description,
    `${sourceLabel}.description`,
  )?.trim();

  if (!title && !description) {
    return undefined;
  }

  return {
    title: title || undefined,
    description: description || undefined,
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

function normalizeVectorStoreProvider(
  value: unknown,
  sourceLabel: string,
): PersistedVectorStoreConfig["provider"] {
  if (value === "qdrant" || value === "chroma") {
    return value;
  }

  throw new Error(`vector provider 非法: ${sourceLabel}`);
}

function normalizeVectorDistance(
  value: unknown,
  sourceLabel: string,
): PersistedVectorStoreConfig["distance"] {
  if (value === undefined) {
    return "cosine";
  }

  if (
    value === "cosine" ||
    value === "dot" ||
    value === "euclid" ||
    value === "manhattan"
  ) {
    return value;
  }

  throw new Error(`vector distance 非法: ${sourceLabel}`);
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

function normalizeOptionalStringMap(
  value: unknown,
  sourceLabel: string,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error(`字符串映射必须是对象: ${sourceLabel}`);
  }

  const result: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    const normalized = readOptionalStringAllowEmpty(entryValue, `${sourceLabel}.${key}`);
    if (normalized === undefined) {
      throw new Error(`${sourceLabel}.${key} 必须是字符串`);
    }
    result[key] = normalized;
  }

  return Object.keys(result).length > 0 ? result : undefined;
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

export function pruneEmptyVectorConfig(
  config: GlobalVectorConfig | undefined,
): GlobalVectorConfig | undefined {
  if (!config || Object.keys(config.stores).length === 0) {
    return undefined;
  }

  return cloneVectorConfig(config);
}

function readRequiredString(value: unknown, sourceLabel: string): string {
  const result = readOptionalString(value, sourceLabel);
  if (!result) {
    throw new Error(`必须配置非空字符串: ${sourceLabel}`);
  }

  return result;
}

function readRequiredStringArray(value: unknown, sourceLabel: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`必须配置非空字符串数组: ${sourceLabel}`);
  }

  const result: string[] = [];
  for (const [index, entry] of value.entries()) {
    const normalized = readRequiredString(entry, `${sourceLabel}[${index}]`);
    if (!result.includes(normalized)) {
      result.push(normalized);
    }
  }

  if (result.length === 0) {
    throw new Error(`必须配置至少一个模型: ${sourceLabel}`);
  }

  return result;
}

function readRequiredModelNames(
  value: Record<string, unknown>,
  sourceLabel: string,
): string[] {
  if (value.modelNames !== undefined) {
    return readRequiredStringArray(value.modelNames, `${sourceLabel}.modelNames`);
  }

  return [readRequiredString(value.modelName, `${sourceLabel}.modelName`)];
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

function readOptionalUnitInterval(value: unknown, sourceLabel: string): number | undefined {
  const result = readOptionalFiniteNumber(value, sourceLabel);
  if (result === undefined) {
    return undefined;
  }

  if (result <= 0 || result > 1) {
    throw new Error(`字段必须大于 0 且不超过 1: ${sourceLabel}`);
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

function normalizeOptionalWorkspaceEntries(
  value: unknown,
  sourceLabel: string,
): WorkspaceEntry[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries: WorkspaceEntry[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isRecord(item)) continue;
    const name = readOptionalString(item.name, `${sourceLabel}[${i}].name`);
    const dir = readOptionalString(item.dir, `${sourceLabel}[${i}].dir`);
    const lastOpenedAt = readOptionalString(item.lastOpenedAt, `${sourceLabel}[${i}].lastOpenedAt`);
    if (name && dir && lastOpenedAt) {
      entries.push({ name, dir, lastOpenedAt });
    }
  }

  return entries.length > 0 ? entries : undefined;
}

function cloneWorkspaceEntry(entry: WorkspaceEntry): WorkspaceEntry {
  return { name: entry.name, dir: entry.dir, lastOpenedAt: entry.lastOpenedAt };
}
