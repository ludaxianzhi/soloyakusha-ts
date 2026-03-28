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
import type {
  GlossaryExtractorConfig,
  GlossaryUpdaterConfig,
  PlotSummaryConfig,
  TranslationProcessorConfig,
} from "../project/config.ts";
import type {
  GlobalConfigDocument,
  GlobalConfigManagerOptions,
  GlobalLlmConfig,
  GlobalTranslationConfig,
  PersistedLlmClientConfig,
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
  clonePersistedLlmClientConfig,
  clonePlotSummaryConfig,
  cloneProfiles,
  cloneTranslationConfig,
  cloneTranslationProcessorConfig,
  createEmptyDocument,
  normalizeGlossaryExtractorConfig,
  normalizeGlossaryUpdaterConfig,
  normalizeGlobalConfigDocument,
  normalizePersistedLlmClientConfig,
  normalizePlotSummaryConfig,
  normalizeTranslationProcessorConfig,
  pruneEmptyTranslationConfig,
} from "./document-codec.ts";

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
    return cloneTranslationProcessorConfig(
      (await this.loadDocument()).translation?.translationProcessor,
    );
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

  async getTranslationGlobalConfig(): Promise<TranslationGlobalConfig> {
    const document = await this.loadDocument();
    return TranslationGlobalConfig.fromParsedObject({
      llm: {
        profiles: cloneProfiles(document.llm.profiles),
        embedding: document.llm.embedding
          ? clonePersistedLlmClientConfig(document.llm.embedding)
          : undefined,
      },
      translation: cloneTranslationConfig(document.translation),
    });
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

  async getEmbeddingConfig(): Promise<PersistedLlmClientConfig | undefined> {
    const embedding = (await this.loadDocument()).llm.embedding;
    return embedding ? clonePersistedLlmClientConfig(embedding) : undefined;
  }

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
    const config = await this.getEmbeddingConfig();
    if (!config) {
      throw new Error("未配置全局嵌入模型");
    }

    return config;
  }

  async getResolvedEmbeddingConfig(): Promise<LlmClientConfig> {
    return createLlmClientConfig(await this.getRequiredEmbeddingConfig());
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

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
