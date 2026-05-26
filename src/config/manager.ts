/**
 * 提供用户目录下全局配置文件的读取、校验与更新能力。
 *
 * 当前管理：
 * - 命名 Chat LLM 配置
 * - 唯一 Embedding 配置
 * - 翻译器、术语提取、术语更新、情节总结等模块默认配置
 *
 * @module config/manager
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createLlmClientConfig } from "../llm/types.ts";
import type { LlmClientConfig } from "../llm/types.ts";
import { TranslationGlobalConfig } from "../project/config.ts";
import { createVectorStoreConfig } from "../vector/types.ts";
import type { VectorStoreConfig } from "../vector/types.ts";
import type {
  AlignmentRepairConfig,
  GlossaryExtractorConfig,
  GlossaryUpdaterConfig,
  PlotSummaryConfig,
  TranslationProcessorConfig,
} from "../project/config.ts";
import type {
  GlobalConfigDocument,
  GlobalConfigManagerOptions,
  GlobalLlmConfig,
  GlobalStyleLibraryConfig,
  GlobalTranslationConfig,
  GlobalVectorConfig,
  ProofreaderEntry,
  PersistedLlmClientConfig,
  PersistedStyleLibraryConfig,
  PersistedVectorStoreConfig,
  TranslatorEntry,
  WorkspaceEntry,
} from "./types.ts";
import {
  DEFAULT_GLOBAL_CONFIG_DIR_NAME,
  DEFAULT_GLOBAL_CONFIG_FILE_NAME,
} from "./types.ts";
import {
  cloneDocument,
  cloneGlossaryExtractorConfig,
  cloneGlossaryUpdaterConfig,
  cloneLlmConfig,
  cloneProofreaderEntry,
  cloneProofreaders,
  clonePersistedLlmClientConfig,
  clonePersistedStyleLibraryConfig,
  clonePersistedVectorStoreConfig,
  clonePlotSummaryConfig,
  cloneAlignmentRepairConfig,
  cloneProfiles,
  cloneStyleLibraryConfig,
  cloneTranslationConfig,
  cloneTranslationProcessorConfig,
  cloneTranslatorEntry,
  cloneVectorConfig,
  createEmptyDocument,
  normalizeGlossaryExtractorConfig,
  normalizeGlossaryUpdaterConfig,
  normalizeGlobalConfigDocument,
  normalizePersistedLlmClientConfig,
  normalizeProofreaderEntry,
  normalizePersistedStyleLibraryConfig,
  normalizePersistedVectorStoreConfig,
  normalizePlotSummaryConfig,
  normalizeAlignmentRepairConfig,
  normalizeTranslationProcessorConfig,
  normalizeTranslatorEntry,
  pruneEmptyStyleLibraryConfig,
  pruneEmptyTranslationConfig,
  pruneEmptyVectorConfig,
} from "./document-codec.ts";

export const BUILTIN_STYLE_LIBRARY_VECTOR_STORE_NAME = "builtin-memory";

const BUILTIN_STYLE_LIBRARY_VECTOR_STORE_FILE_NAME = "style-library-memory.sqlite";

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

  async getVectorConfig(): Promise<GlobalVectorConfig | undefined> {
    return cloneVectorConfig((await this.loadDocument()).vector);
  }

  async getStyleLibraryConfig(): Promise<GlobalStyleLibraryConfig | undefined> {
    return cloneStyleLibraryConfig((await this.loadDocument()).styleLibraries);
  }

  async getTranslationConfig(): Promise<GlobalTranslationConfig | undefined> {
    return cloneTranslationConfig((await this.loadDocument()).translation);
  }

  async getTranslationProcessorConfig(): Promise<TranslationProcessorConfig | undefined> {
    return cloneTranslationProcessorConfig(
      (await this.loadDocument()).translation?.translationProcessor,
    );
  }

  async getProofreadProcessorConfig(): Promise<TranslationProcessorConfig | undefined> {
    const translation = (await this.loadDocument()).translation;
    return cloneTranslationProcessorConfig(
      translation?.proofreaders?.default ?? translation?.proofreadProcessor,
    );
  }

  async getProofreaders(): Promise<Record<string, ProofreaderEntry> | undefined> {
    return cloneProofreaders((await this.loadDocument()).translation?.proofreaders);
  }

  async listProofreaderNames(): Promise<string[]> {
    const proofreaders = (await this.loadDocument()).translation?.proofreaders ?? {};
    return Object.keys(proofreaders).sort();
  }

  async getProofreader(name: string): Promise<ProofreaderEntry | undefined> {
    const proofreaders = (await this.loadDocument()).translation?.proofreaders ?? {};
    const entry = proofreaders[name];
    return entry ? cloneProofreaderEntry(entry) : undefined;
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

  async setProofreadProcessorConfig(
    config?: TranslationProcessorConfig,
  ): Promise<TranslationProcessorConfig | undefined> {
    console.log('[Config] setProofreadProcessorConfig: minCommentLevel =',
      config?.minCommentLevel, '(type:', typeof config?.minCommentLevel, ')');
    const saved = await this.setProofreader(
      "default",
      config
        ? normalizeProofreaderEntry(config, "translation.proofreaders.default")
        : undefined,
      { removeWhenUndefined: true },
    );
    return cloneTranslationProcessorConfig(saved);
  }

  async setProofreader(
    name: string,
    entry: ProofreaderEntry | undefined,
    options: { removeWhenUndefined?: boolean } = {},
  ): Promise<ProofreaderEntry | undefined> {
    validateProofreaderName(name);
    const document = await this.loadDocument();
    const translation = document.translation ?? {};
    translation.proofreaders = translation.proofreaders ?? {};

    if (entry === undefined) {
      if (options.removeWhenUndefined) {
        delete translation.proofreaders[name];
      }
    } else {
      translation.proofreaders[name] = normalizeProofreaderEntry(
        entry,
        `translation.proofreaders.${name}`,
      );
    }

    if (translation.proofreaders && Object.keys(translation.proofreaders).length === 0) {
      translation.proofreaders = undefined;
    }

    document.translation = pruneEmptyTranslationConfig(translation);
    await this.persistDocument(document);
    const saved = document.translation?.proofreaders?.[name];
    return saved ? cloneProofreaderEntry(saved) : undefined;
  }

  async removeProofreader(name: string): Promise<boolean> {
    const document = await this.loadDocument();
    const proofreaders = document.translation?.proofreaders;
    if (!proofreaders || !proofreaders[name]) {
      return false;
    }

    delete proofreaders[name];
    document.translation = pruneEmptyTranslationConfig(document.translation);
    await this.persistDocument(document);
    return true;
  }

  async getGlossaryExtractorConfig(): Promise<GlossaryExtractorConfig | undefined> {
    return cloneGlossaryExtractorConfig((await this.loadDocument()).translation?.glossaryExtractor);
  }

  async setGlossaryExtractorConfig(
    config?: GlossaryExtractorConfig,
  ): Promise<GlossaryExtractorConfig | undefined> {
    const document = await this.loadDocument();
    const translation = document.translation ?? {};
    translation.glossaryExtractor = config
      ? normalizeGlossaryExtractorConfig(config, "translation.glossaryExtractor")
      : undefined;
    document.translation = pruneEmptyTranslationConfig(translation);
    await this.persistDocument(document);
    return cloneGlossaryExtractorConfig(document.translation?.glossaryExtractor);
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

  async getPlotSummaryConfig(): Promise<PlotSummaryConfig | undefined> {
    return clonePlotSummaryConfig((await this.loadDocument()).translation?.plotSummary);
  }

  async setPlotSummaryConfig(
    config?: PlotSummaryConfig,
  ): Promise<PlotSummaryConfig | undefined> {
    const document = await this.loadDocument();
    const translation = document.translation ?? {};
    translation.plotSummary = config
      ? normalizePlotSummaryConfig(config, "translation.plotSummary")
      : undefined;
    document.translation = pruneEmptyTranslationConfig(translation);
    await this.persistDocument(document);
    return clonePlotSummaryConfig(document.translation?.plotSummary);
  }

  async getAlignmentRepairConfig(): Promise<AlignmentRepairConfig | undefined> {
    return cloneAlignmentRepairConfig((await this.loadDocument()).translation?.alignmentRepair);
  }

  async setAlignmentRepairConfig(
    config?: AlignmentRepairConfig,
  ): Promise<AlignmentRepairConfig | undefined> {
    const document = await this.loadDocument();
    const translation = document.translation ?? {};
    translation.alignmentRepair = config
      ? normalizeAlignmentRepairConfig(config, "translation.alignmentRepair")
      : undefined;
    document.translation = pruneEmptyTranslationConfig(translation);
    await this.persistDocument(document);
    return cloneAlignmentRepairConfig(document.translation?.alignmentRepair);
  }

  async getTranslationGlobalConfig(): Promise<TranslationGlobalConfig> {
    const document = await this.loadDocument();
    return TranslationGlobalConfig.fromParsedObject({
      llm: {
        profiles: cloneProfiles(document.llm.profiles),
        embedding: document.llm.embedding
          ? clonePersistedLlmClientConfig(document.llm.embedding)
          : undefined,
        embeddingProfiles: document.llm.embeddingProfiles
          ? cloneProfiles(document.llm.embeddingProfiles)
          : undefined,
      },
      translation: cloneTranslationConfig(document.translation),
    });
  }

  async listTranslatorNames(): Promise<string[]> {
    const translators = (await this.loadDocument()).translation?.translators ?? {};
    return Object.keys(translators).sort();
  }

  async getTranslator(name: string): Promise<TranslatorEntry | undefined> {
    const translators = (await this.loadDocument()).translation?.translators ?? {};
    const entry = translators[name];
    return entry ? cloneTranslatorEntry(entry) : undefined;
  }

  async setTranslator(
    name: string,
    entry: TranslatorEntry,
  ): Promise<TranslatorEntry> {
    validateTranslatorName(name);
    const document = await this.loadDocument();
    const translation = document.translation ?? {};
    translation.translators = translation.translators ?? {};
    const normalized = normalizeTranslatorEntry(
      entry,
      `translation.translators.${name}`,
    );
    translation.translators[name] = normalized;
    document.translation = pruneEmptyTranslationConfig(translation);
    await this.persistDocument(document);
    return cloneTranslatorEntry(normalized);
  }

  async removeTranslator(name: string): Promise<boolean> {
    const document = await this.loadDocument();
    const translators = document.translation?.translators;
    if (!translators || !translators[name]) {
      return false;
    }

    delete translators[name];
    document.translation = pruneEmptyTranslationConfig(document.translation);
    await this.persistDocument(document);
    return true;
  }

  async listLlmProfileNames(): Promise<string[]> {
    return Object.entries((await this.loadDocument()).llm.profiles)
      .filter(([, profile]) => profile.modelType === "chat")
      .map(([name]) => name)
      .sort();
  }

  async getDefaultLlmProfileName(): Promise<string | undefined> {
    return (await this.loadDocument()).llm.defaultProfileName;
  }

  async setDefaultLlmProfileName(profileName?: string): Promise<void> {
    const document = await this.loadDocument();
    if (profileName !== undefined) {
      const profile = document.llm.profiles[profileName];
      if (!profile) {
        throw new Error(`未找到名为 '${profileName}' 的 LLM 全局配置`);
      }
      if (profile.modelType !== "chat") {
        throw new Error(`默认 LLM 配置必须是 chat 类型: ${profileName}`);
      }
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
    if (normalized.modelType !== "chat") {
      throw new Error(`命名 LLM 配置必须是 chat 类型: ${profileName}`);
    }

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
    if (next.modelType !== "chat") {
      throw new Error(`命名 LLM 配置必须是 chat 类型: ${profileName}`);
    }

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

  /**
   * @deprecated 兼容层 — 读取旧版全局嵌入配置。
   * 新代码应使用 {@link getEmbeddingProfile} 或 {@link listEmbeddingProfiles}。
   * 移除清单见 {@link migrateEmbeddingIfNeeded}。
   */
  async getEmbeddingConfig(): Promise<PersistedLlmClientConfig | undefined> {
    await this.migrateEmbeddingIfNeeded();
    const embedding = (await this.loadDocument()).llm.embedding;
    return embedding ? clonePersistedLlmClientConfig(embedding) : undefined;
  }

  /**
   * @deprecated 兼容层 — 保存旧版全局嵌入配置。
   * 新代码应使用 {@link setEmbeddingProfile}。
   * 移除清单见 {@link migrateEmbeddingIfNeeded}。
   */
  async setEmbeddingConfig(
    config?: PersistedLlmClientConfig,
  ): Promise<PersistedLlmClientConfig | undefined> {
    const document = await this.loadDocument();
    const normalized = config
      ? normalizePersistedLlmClientConfig(config, "llm.embedding")
      : undefined;
    if (normalized && normalized.modelType !== "embedding") {
      throw new Error("嵌入模型配置必须是 embedding 类型");
    }

    document.llm.embedding = normalized;
    await this.persistDocument(document);
    return normalized ? clonePersistedLlmClientConfig(normalized) : undefined;
  }

  async getRequiredEmbeddingConfig(): Promise<PersistedLlmClientConfig> {
    await this.migrateEmbeddingIfNeeded();
    const config = await this.getEmbeddingConfig();
    if (!config) {
      throw new Error("未配置全局嵌入模型");
    }

    return config;
  }

  async getResolvedEmbeddingConfig(): Promise<LlmClientConfig> {
    return createLlmClientConfig(await this.getRequiredEmbeddingConfig());
  }

  // ─── Embedding Profiles CRUD ────────────────────────

  async listEmbeddingProfileNames(): Promise<string[]> {
    await this.migrateEmbeddingIfNeeded();
    return Object.keys((await this.loadDocument()).llm.embeddingProfiles ?? {}).sort();
  }

  async listEmbeddingProfiles(): Promise<Record<string, PersistedLlmClientConfig>> {
    await this.migrateEmbeddingIfNeeded();
    const profiles = (await this.loadDocument()).llm.embeddingProfiles ?? {};
    return cloneProfiles(profiles);
  }

  async getEmbeddingProfile(name: string): Promise<PersistedLlmClientConfig | undefined> {
    await this.migrateEmbeddingIfNeeded();
    const profiles = (await this.loadDocument()).llm.embeddingProfiles ?? {};
    const config = profiles[name];
    return config ? clonePersistedLlmClientConfig(config) : undefined;
  }

  async setEmbeddingProfile(
    name: string,
    config: PersistedLlmClientConfig,
  ): Promise<PersistedLlmClientConfig> {
    validateProfileName(name);
    const document = await this.loadDocument();
    const normalized = normalizePersistedLlmClientConfig(
      config,
      `llm.embeddingProfiles.${name}`,
    );
    if (normalized.modelType !== "embedding") {
      throw new Error("嵌入模型预设必须是 embedding 类型");
    }

    const embeddingProfiles = document.llm.embeddingProfiles ?? {};
    embeddingProfiles[name] = normalized;
    document.llm.embeddingProfiles = embeddingProfiles;
    await this.persistDocument(document);
    return clonePersistedLlmClientConfig(normalized);
  }

  async deleteEmbeddingProfile(name: string): Promise<boolean> {
    validateProfileName(name);
    const document = await this.loadDocument();
    const embeddingProfiles = document.llm.embeddingProfiles;
    if (!embeddingProfiles?.[name]) {
      return false;
    }

    delete embeddingProfiles[name];
    if (Object.keys(embeddingProfiles).length === 0) {
      document.llm.embeddingProfiles = undefined;
    }

    await this.persistDocument(document);
    return true;
  }

  async getRequiredEmbeddingConfigByName(name: string): Promise<PersistedLlmClientConfig> {
    await this.migrateEmbeddingIfNeeded();
    const config = await this.getEmbeddingProfile(name);
    if (!config) {
      throw new Error(`未找到名为 '${name}' 的嵌入模型预设`);
    }
    return config;
  }

  async getResolvedEmbeddingConfigByName(name: string): Promise<LlmClientConfig> {
    return createLlmClientConfig(await this.getRequiredEmbeddingConfigByName(name));
  }

  async listVectorStoreNames(): Promise<string[]> {
    return Object.keys((await this.loadDocument()).vector?.stores ?? {}).sort();
  }

  async getDefaultVectorStoreName(): Promise<string | undefined> {
    return (await this.loadDocument()).vector?.defaultStoreName;
  }

  async setDefaultVectorStoreName(storeName?: string): Promise<void> {
    const document = await this.loadDocument();
    const vector = document.vector ?? { stores: {} };
    if (storeName !== undefined && !vector.stores[storeName]) {
      throw new Error(`未找到名为 '${storeName}' 的向量数据库配置`);
    }

    vector.defaultStoreName = storeName;
    document.vector = pruneEmptyVectorConfig(vector);
    await this.persistDocument(document);
  }

  async getVectorStore(
    storeName: string,
  ): Promise<PersistedVectorStoreConfig | undefined> {
    const store = (await this.loadDocument()).vector?.stores[storeName];
    return store ? clonePersistedVectorStoreConfig(store) : undefined;
  }

  async getRequiredVectorStore(storeName?: string): Promise<PersistedVectorStoreConfig> {
    const document = await this.loadDocument();
    const resolvedName = storeName ?? document.vector?.defaultStoreName;
    if (!resolvedName) {
      throw new Error("未提供向量数据库配置名称，且未设置默认向量数据库配置");
    }

    const store = document.vector?.stores[resolvedName];
    if (!store) {
      throw new Error(`未找到名为 '${resolvedName}' 的向量数据库配置`);
    }

    return clonePersistedVectorStoreConfig(store);
  }

  async getResolvedVectorStoreConfig(storeName?: string): Promise<VectorStoreConfig> {
    return createVectorStoreConfig(await this.getRequiredVectorStore(storeName));
  }

  async getResolvedStyleLibraryVectorStoreConfig(storeName: string): Promise<VectorStoreConfig> {
    const registered = await this.getVectorStore(storeName);
    if (registered) {
      return createVectorStoreConfig(registered);
    }

    if (storeName === BUILTIN_STYLE_LIBRARY_VECTOR_STORE_NAME) {
      return createVectorStoreConfig({
        provider: "sqlite-memory",
        endpoint: join(dirname(this.filePath), BUILTIN_STYLE_LIBRARY_VECTOR_STORE_FILE_NAME),
      });
    }

    throw new Error(`未找到名为 '${storeName}' 的向量数据库配置`);
  }

  async setVectorStore(
    storeName: string,
    config: PersistedVectorStoreConfig,
  ): Promise<PersistedVectorStoreConfig> {
    validateVectorStoreName(storeName);
    const document = await this.loadDocument();
    const vector = document.vector ?? { stores: {} };
    const normalized = normalizePersistedVectorStoreConfig(
      config,
      `vector.stores.${storeName}`,
    );

    vector.stores[storeName] = normalized;
    document.vector = pruneEmptyVectorConfig(vector);
    await this.persistDocument(document);
    return clonePersistedVectorStoreConfig(normalized);
  }

  async removeVectorStore(storeName: string): Promise<boolean> {
    validateVectorStoreName(storeName);
    const document = await this.loadDocument();
    const vector = document.vector;
    if (!vector?.stores[storeName]) {
      return false;
    }

    delete vector.stores[storeName];
    if (vector.defaultStoreName === storeName) {
      vector.defaultStoreName = undefined;
    }

    document.vector = pruneEmptyVectorConfig(vector);
    await this.persistDocument(document);
    return true;
  }

  async listStyleLibraryNames(): Promise<string[]> {
    return Object.keys((await this.loadDocument()).styleLibraries?.libraries ?? {}).sort();
  }

  async getStyleLibrary(
    libraryName: string,
  ): Promise<PersistedStyleLibraryConfig | undefined> {
    const library = (await this.loadDocument()).styleLibraries?.libraries[libraryName];
    return library ? clonePersistedStyleLibraryConfig(library) : undefined;
  }

  async getRequiredStyleLibrary(libraryName: string): Promise<PersistedStyleLibraryConfig> {
    const library = await this.getStyleLibrary(libraryName);
    if (!library) {
      throw new Error(`未找到名为 '${libraryName}' 的风格库配置`);
    }

    return library;
  }

  async setStyleLibrary(
    libraryName: string,
    config: PersistedStyleLibraryConfig,
  ): Promise<PersistedStyleLibraryConfig> {
    validateStyleLibraryName(libraryName);
    const document = await this.loadDocument();
    const styleLibraries = document.styleLibraries ?? { libraries: {} };
    const normalized = normalizePersistedStyleLibraryConfig(
      config,
      `styleLibraries.libraries.${libraryName}`,
    );
    styleLibraries.libraries[libraryName] = normalized;
    document.styleLibraries = pruneEmptyStyleLibraryConfig(styleLibraries);
    await this.persistDocument(document);
    return clonePersistedStyleLibraryConfig(normalized);
  }

  async removeStyleLibrary(libraryName: string): Promise<boolean> {
    validateStyleLibraryName(libraryName);
    const document = await this.loadDocument();
    const styleLibraries = document.styleLibraries;
    if (!styleLibraries?.libraries[libraryName]) {
      return false;
    }

    delete styleLibraries.libraries[libraryName];
    document.styleLibraries = pruneEmptyStyleLibraryConfig(styleLibraries);
    await this.persistDocument(document);
    return true;
  }

  async getRecentWorkspaces(): Promise<WorkspaceEntry[]> {
    const document = await this.loadDocument();
    return document.recentWorkspaces ? [...document.recentWorkspaces] : [];
  }

  /** 将工作区记录到注册表（已存在时更新 lastOpenedAt，并将其移到列表最前）。 */
  async addRecentWorkspace(entry: { name: string; dir: string }): Promise<void> {
    const document = await this.loadDocument();
    const entries = document.recentWorkspaces ?? [];
    const existing = entries.findIndex((e) => e.dir === entry.dir);
    const updated: WorkspaceEntry = { ...entry, lastOpenedAt: new Date().toISOString() };
    if (existing !== -1) {
      entries.splice(existing, 1);
    }
    entries.unshift(updated);
    document.recentWorkspaces = entries.slice(0, 20);
    await this.persistDocument(document);
  }

  async removeRecentWorkspace(dir: string): Promise<void> {
    const document = await this.loadDocument();
    const entries = document.recentWorkspaces ?? [];
    document.recentWorkspaces = entries.filter((e) => e.dir !== dir);
    await this.persistDocument(document);
  }

  /**
   * 将旧的 llm.embedding 单值配置迁移到 llm.embeddingProfiles。
   *
   * ## 迁移逻辑
   *
   * **触发条件**：`llm.embedding` 存在 **且** `llm.embeddingProfiles` 为空或不存在。
   *
   * **迁移操作**：
   * 1. 将 `llm.embedding` 的值原样复制到 `llm.embeddingProfiles["default"]`
   * 2. 将 `llm.embedding` 置为 `undefined`
   * 3. 持久化文档到磁盘，更新内存缓存
   *
   * **调用时机**：在所有读取 embedding 配置的 public 方法入口处调用
   * （`getEmbeddingConfig`, `getEmbeddingProfile`, `listEmbeddingProfiles` 等）。
   *
   * ---
   *
   * ## 后续移除清单
   *
   * 当确认所有用户的 config.json 都已迁移（`llm.embedding` 字段不再存在）后，
   * 按以下顺序移除兼容代码：
   *
   * ### 1. 删除迁移方法本身
   * - 删除本方法 `migrateEmbeddingIfNeeded()`
   * - 删除所有调用点（`getEmbeddingConfig`, `getEmbeddingProfile`, `listEmbeddingProfiles`,
   *   `getRequiredEmbeddingConfig`, `getRequiredEmbeddingConfigByName`, `getTranslationGlobalConfig`）
   *
   * ### 2. 删除旧单值字段
   * - `src/config/types.ts:GlobalLlmConfig.embedding` — 删除该字段及 `@deprecated` 注释
   * - `src/project/config.ts:TranslationGlobalLlmConfig.embedding` — 删除该字段
   *
   * ### 3. 清理 codec 层
   * - `src/config/document-codec.ts:normalizeGlobalConfigDocument` — 删除 `embedding` 字段的解析逻辑
   *   （约 10 行，搜索 `llmValue.embedding`）
   * - `src/config/document-codec.ts:cloneLlmConfig` — 删除 `embedding:` 行
   *
   * ### 4. 清理 manager 层
   * - 删除 `getEmbeddingConfig()`（约 4 行）
   * - 删除 `setEmbeddingConfig()`（约 14 行）
   * - 删除 `getRequiredEmbeddingConfig()`（约 8 行）
   * - 删除 `getResolvedEmbeddingConfig()`（约 3 行）
   *
   * ### 5. 清理 project config
   * - `src/project/config.ts:createProvider` — 删除 `llm.embedding` 的展开
   * - `src/project/config.ts:getEmbeddingConfig` — 删除该方法
   * - `src/project/config.ts:GLOBAL_EMBEDDING_CLIENT_NAME` — 可保留（风格库 fallback 仍使用）
   *
   * ### 6. 清理 config service / routes（可选）
   * - `src/webui/services/config-service.ts:getEmbeddingConfig/setEmbeddingConfig` — 标记为
   *   `@deprecated` 的包装方法可直接删除
   *
   * ### 7. 清理文档
   * - 删除本注释块
   */
  private async migrateEmbeddingIfNeeded(): Promise<void> {
    const document = await this.loadDocument();
    if (!document.llm.embedding) {
      return;
    }
    if (document.llm.embeddingProfiles && Object.keys(document.llm.embeddingProfiles).length > 0) {
      return;
    }

    const defaultName = "default";
    document.llm.embeddingProfiles = document.llm.embeddingProfiles ?? {};
    document.llm.embeddingProfiles[defaultName] = document.llm.embedding;
    document.llm.embedding = undefined;

    await this.persistDocument(document);
    this.cachedDocument = document;
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

function validateProfileName(profileName: string): void {
  if (profileName.trim().length === 0) {
    throw new Error("LLM profile 名称不能为空字符串");
  }
}

function validateTranslatorName(name: string): void {
  if (name.trim().length === 0) {
    throw new Error("翻译器名称不能为空字符串");
  }
}

function validateProofreaderName(name: string): void {
  if (name.trim().length === 0) {
    throw new Error("校对器名称不能为空字符串");
  }
}

function validateVectorStoreName(name: string): void {
  if (name.trim().length === 0) {
    throw new Error("向量数据库配置名称不能为空字符串");
  }
}

function validateStyleLibraryName(name: string): void {
  if (name.trim().length === 0) {
    throw new Error("风格库名称不能为空字符串");
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
