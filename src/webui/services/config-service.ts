/**
 * 全局配置服务：LLM Profile、翻译器、辅助功能配置的 CRUD 包装。
 */

import { GlobalConfigManager } from '../../config/manager.ts';
import type {
  PersistedLlmClientConfig,
  TranslatorEntry,
} from '../../config/types.ts';
import type {
  GlossaryExtractorConfig,
  GlossaryUpdaterConfig,
  PlotSummaryConfig,
  AlignmentRepairConfig,
} from '../../project/config.ts';

export class ConfigService {
  private manager = new GlobalConfigManager();

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
    await this.manager.setEmbeddingConfig(config);
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
}
