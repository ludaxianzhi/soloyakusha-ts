/**
 * 全局配置服务：LLM Profile、翻译器、辅助功能配置的 CRUD 包装。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { GlobalConfigManager } from '../../config/manager.ts';
import { PcaProjection } from '../../llm/pca-embedding-client.ts';
import type {
  PersistedLlmClientConfig,
  PersistedVectorStoreConfig,
  TranslatorEntry,
} from '../../config/types.ts';
import type {
  GlossaryExtractorConfig,
  GlossaryUpdaterConfig,
  PlotSummaryConfig,
  AlignmentRepairConfig,
} from '../../project/config.ts';
import {
  TranslationProcessorFactory,
  type TranslationProcessorWorkflowMetadata,
} from '../../project/translation-processor-factory.ts';
import { VectorStoreClientProvider } from '../../vector/provider.ts';

export type VectorConnectionTrigger =
  | 'startup'
  | 'save'
  | 'manual'
  | 'set-default';

export type VectorStoreConnectionStatus = {
  state: 'idle' | 'checking' | 'connected' | 'error';
  checkedAt?: string;
  error?: string;
  trigger?: VectorConnectionTrigger;
};

type ConfigServiceOptions = {
  manager?: GlobalConfigManager;
};

const DEFAULT_WEBUI_VECTOR_STORE_NAME = 'default';

export class ConfigService {
  private readonly manager: GlobalConfigManager;
  private readonly vectorConnectionStatuses = new Map<
    string,
    VectorStoreConnectionStatus
  >();

  constructor(options: ConfigServiceOptions = {}) {
    this.manager = options.manager ?? new GlobalConfigManager();
  }

  // === LLM Profiles ===

  async listLlmProfiles(): Promise<{
    names: string[];
    defaultName?: string;
  }> {
    const names = await this.manager.listLlmProfileNames();
    const defaultName =
      (await this.manager.getDefaultLlmProfileName()) ?? undefined;
    return { names, defaultName };
  }

  async getLlmProfile(
    name: string,
  ): Promise<PersistedLlmClientConfig | undefined> {
    return this.manager.getLlmProfile(name);
  }

  async setLlmProfile(
    name: string,
    config: PersistedLlmClientConfig,
  ): Promise<void> {
    await this.manager.setLlmProfile(name, config);
  }

  async removeLlmProfile(name: string): Promise<boolean> {
    return this.manager.removeLlmProfile(name);
  }

  async setDefaultLlmProfile(name: string | undefined): Promise<void> {
    await this.manager.setDefaultLlmProfileName(name);
  }

  async getEmbeddingConfig(): Promise<PersistedLlmClientConfig | undefined> {
    return this.manager.getEmbeddingConfig();
  }

  async setEmbeddingConfig(
    config: PersistedLlmClientConfig | undefined,
  ): Promise<void> {
    this.validateEmbeddingPcaConfig(config);
    await this.manager.setEmbeddingConfig(config);
  }

  async uploadEmbeddingPcaWeights(input: {
    fileName: string;
    content: Uint8Array;
  }): Promise<{ filePath: string }> {
    const extension = extname(input.fileName).toLowerCase();
    if (extension !== '.json') {
      throw new Error('PCA 权重文件必须是 .json 格式');
    }

    const text = new TextDecoder().decode(input.content);
    PcaProjection.fromJsonString(text);

    const configDir = dirname(this.manager.getFilePath());
    const targetDir = join(configDir, 'pca-weights');
    await mkdir(targetDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[.:]/g, '-');
    const baseName = this.sanitizeFileName(input.fileName).replace(/\.json$/i, '');
    const targetPath = join(targetDir, `${timestamp}-${baseName}.json`);
    await writeFile(targetPath, input.content);

    return { filePath: targetPath };
  }

  // === Vector Stores ===

  async initializeVectorStoreConnections(): Promise<void> {
    const storeName = await this.resolveManagedVectorStoreName();
    if (!storeName) {
      return;
    }
    await this.tryConnectSavedVectorStore(storeName, 'startup');
  }

  async getVectorStoreConfig(): Promise<{
    config: PersistedVectorStoreConfig | undefined;
    status: VectorStoreConnectionStatus;
  }> {
    const storeName = await this.resolveManagedVectorStoreName();
    if (!storeName) {
      return {
        config: undefined,
        status: { state: 'idle' },
      };
    }
    return {
      config: await this.manager.getVectorStore(storeName),
      status:
        this.vectorConnectionStatuses.get(storeName) ?? ({ state: 'idle' } as const),
    };
  }

  async saveVectorStoreConfig(
    config: PersistedVectorStoreConfig,
  ): Promise<{
    config: PersistedVectorStoreConfig;
    connection: VectorStoreConnectionStatus;
  }> {
    const storeName =
      (await this.resolveManagedVectorStoreName()) ?? DEFAULT_WEBUI_VECTOR_STORE_NAME;
    const saved = await this.manager.setVectorStore(storeName, config);
    await this.manager.setDefaultVectorStoreName(storeName);
    const connection = await this.tryConnectVectorStore(storeName, saved, 'save');
    return {
      config: saved,
      connection,
    };
  }

  async clearVectorStoreConfig(): Promise<boolean> {
    const storeName = await this.resolveManagedVectorStoreName();
    if (!storeName) {
      return false;
    }
    const removed = await this.manager.removeVectorStore(storeName);
    if (removed) {
      this.vectorConnectionStatuses.delete(storeName);
    }
    return removed;
  }

  async connectVectorStoreConfig(input: {
    config?: PersistedVectorStoreConfig;
  }): Promise<VectorStoreConnectionStatus> {
    if (input.config) {
      return this.tryConnectVectorStore(
        await this.resolveManagedVectorStoreName(),
        input.config,
        'manual',
      );
    }
    const storeName = await this.resolveManagedVectorStoreName();
    if (!storeName) {
      throw new Error('当前未保存向量数据库配置');
    }
    return this.tryConnectSavedVectorStore(storeName, 'manual');
  }

  // === Translators ===

  async listTranslators(): Promise<{
    names: string[];
  }> {
    const names = await this.manager.listTranslatorNames();
    return { names };
  }

  async getTranslator(name: string): Promise<TranslatorEntry | undefined> {
    return this.manager.getTranslator(name);
  }

  async setTranslator(name: string, entry: TranslatorEntry): Promise<void> {
    await this.manager.setTranslator(name, entry);
  }

  async removeTranslator(name: string): Promise<boolean> {
    return this.manager.removeTranslator(name);
  }

  listTranslatorWorkflows(): TranslationProcessorWorkflowMetadata[] {
    return TranslationProcessorFactory.listWorkflowMetadata();
  }

  // === Auxiliary Configs ===

  async getGlossaryExtractorConfig(): Promise<
    GlossaryExtractorConfig | undefined
  > {
    return this.manager.getGlossaryExtractorConfig();
  }

  async setGlossaryExtractorConfig(
    config?: GlossaryExtractorConfig,
  ): Promise<void> {
    await this.manager.setGlossaryExtractorConfig(config);
  }

  async getGlossaryUpdaterConfig(): Promise<
    GlossaryUpdaterConfig | undefined
  > {
    return this.manager.getGlossaryUpdaterConfig();
  }

  async setGlossaryUpdaterConfig(
    config?: GlossaryUpdaterConfig,
  ): Promise<void> {
    await this.manager.setGlossaryUpdaterConfig(config);
  }

  async getPlotSummaryConfig(): Promise<PlotSummaryConfig | undefined> {
    return this.manager.getPlotSummaryConfig();
  }

  async setPlotSummaryConfig(config?: PlotSummaryConfig): Promise<void> {
    await this.manager.setPlotSummaryConfig(config);
  }

  async getAlignmentRepairConfig(): Promise<
    AlignmentRepairConfig | undefined
  > {
    return this.manager.getAlignmentRepairConfig();
  }

  async setAlignmentRepairConfig(
    config?: AlignmentRepairConfig,
  ): Promise<void> {
    await this.manager.setAlignmentRepairConfig(config);
  }

  /** 获取 GlobalConfigManager 实例（供 project-service 共用）。 */
  getManager(): GlobalConfigManager {
    return this.manager;
  }

  private async tryConnectSavedVectorStore(
    name: string,
    trigger: VectorConnectionTrigger,
  ): Promise<VectorStoreConnectionStatus> {
    const config = await this.manager.getRequiredVectorStore(name);
    return this.tryConnectVectorStore(name, config, trigger);
  }

  private async tryConnectVectorStore(
    name: string | undefined,
    config: PersistedVectorStoreConfig,
    trigger: VectorConnectionTrigger,
  ): Promise<VectorStoreConnectionStatus> {
    if (name) {
      this.vectorConnectionStatuses.set(name, {
        state: 'checking',
        trigger,
      });
    }

    const provider = new VectorStoreClientProvider();
    try {
      provider.register('__probe__', config);
      await provider.getClient('__probe__').probeConnection();
      const status: VectorStoreConnectionStatus = {
        state: 'connected',
        checkedAt: new Date().toISOString(),
        trigger,
      };
      if (name) {
        this.vectorConnectionStatuses.set(name, status);
      }
      return status;
    } catch (error) {
      const status: VectorStoreConnectionStatus = {
        state: 'error',
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
        trigger,
      };
      if (name) {
        this.vectorConnectionStatuses.set(name, status);
      }
      return status;
    } finally {
      await provider.closeAll();
    }
  }

  private async resolveManagedVectorStoreName(): Promise<string | undefined> {
    const defaultName = await this.manager.getDefaultVectorStoreName();
    if (defaultName) {
      return defaultName;
    }
    const names = await this.manager.listVectorStoreNames();
    return names[0];
  }

  private validateEmbeddingPcaConfig(
    config: PersistedLlmClientConfig | undefined,
  ): void {
    if (!config?.pca?.enabled) {
      return;
    }

    const weightsFilePath = config.pca.weightsFilePath?.trim();
    if (!weightsFilePath) {
      throw new Error('启用 PCA 时必须提供权重文件路径');
    }

    PcaProjection.fromJsonFile(weightsFilePath);
  }

  private sanitizeFileName(fileName: string): string {
    const normalized = fileName.trim().replace(/[/\\:*?"<>|]+/g, '-');
    return normalized.length > 0 ? normalized : 'pca-weights';
  }
}
