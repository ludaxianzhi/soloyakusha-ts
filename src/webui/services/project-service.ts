/**
 * 项目服务：管理当前活跃翻译项目的完整生命周期。
 *
 * 从 TUI 的 ProjectContext 提取业务逻辑，去除 React 依赖，
 * 改用 EventBus 发布状态变更事件。
 */

import { join } from 'node:path';
import { GlobalConfigManager } from '../../config/manager.ts';
import { WorkspaceRegistry } from '../../config/workspace-registry.ts';
import { TranslationGlobalConfig } from '../../project/config.ts';
import type { TranslationProcessorConfig } from '../../project/config.ts';
import { TranslationProject } from '../../project/translation-project.ts';
import { TranslationFileHandlerFactory } from '../../file-handlers/factory.ts';
import { FullTextGlossaryScanner } from '../../glossary/index.ts';
import type { GlossaryTermCategory } from '../../glossary/glossary.ts';
import {
  FileRequestHistoryLogger,
  readHistoryEntriesFromLogDir,
} from '../../llm/history.ts';
import type { LlmRequestHistoryEntry } from '../../llm/types.ts';
import { PlotSummarizer } from '../../project/plot-summarizer.ts';
import { StoryTopology } from '../../project/story-topology.ts';
import type { Logger } from '../../project/logger.ts';
import type {
  TranslationProjectSnapshot,
  ProjectExportResult,
  WorkspaceChapterDescriptor,
  WorkspaceConfig,
  WorkspaceConfigPatch,
} from '../../project/types.ts';
import type { EventBus } from './event-bus.ts';
import type { WorkspaceManager } from './workspace-manager.ts';

// ─── Types ──────────────────────────────────────────────

export interface BranchImportInput {
  routeId: string;
  routeName: string;
  forkAfterChapterId: number;
  chapterPaths: string[];
}

export interface InitializeProjectInput {
  projectName: string;
  projectDir: string;
  chapterPaths: string[];
  glossaryPath?: string;
  srcLang?: string;
  tgtLang?: string;
  importFormat?: string;
  translatorName?: string;
  branches?: BranchImportInput[];
}

export interface PlotSummaryProgress {
  status: 'running' | 'done' | 'error';
  totalChapters: number;
  completedChapters: number;
  totalBatches: number;
  completedBatches: number;
  currentChapterId?: number;
  errorMessage?: string;
}

export interface ScanDictionaryProgress {
  status: 'running' | 'done' | 'error';
  totalBatches: number;
  completedBatches: number;
  totalLines: number;
  errorMessage?: string;
}

export interface ProjectStatus {
  hasProject: boolean;
  isBusy: boolean;
  plotSummaryReady: boolean;
  plotSummaryProgress: PlotSummaryProgress | null;
  scanDictionaryProgress: ScanDictionaryProgress | null;
  snapshot: TranslationProjectSnapshot | null;
}

// ─── Service ────────────────────────────────────────────

export class ProjectService {
  private project: TranslationProject | null = null;
  private snapshot: TranslationProjectSnapshot | null = null;
  private topology: StoryTopology | null = null;
  private isBusy = false;
  private processingToken = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private plotSummaryProgress: PlotSummaryProgress | null = null;
  private scanDictionaryProgress: ScanDictionaryProgress | null = null;
  private plotSummaryReady = false;

  constructor(
    private readonly eventBus: EventBus,
    private readonly workspaceManager: WorkspaceManager,
  ) {}

  // ─── Queries ────────────────────────────────────────

  getStatus(): ProjectStatus {
    return {
      hasProject: this.project !== null,
      isBusy: this.isBusy,
      plotSummaryReady: this.plotSummaryReady,
      plotSummaryProgress: this.plotSummaryProgress,
      scanDictionaryProgress: this.scanDictionaryProgress,
      snapshot: this.snapshot,
    };
  }

  getSnapshot(): TranslationProjectSnapshot | null {
    return this.snapshot;
  }

  getWorkspaceConfig(): WorkspaceConfig | null {
    return this.project?.getWorkspaceConfig() ?? null;
  }

  getChapterDescriptors(): WorkspaceChapterDescriptor[] {
    return this.project?.getChapterDescriptors() ?? [];
  }

  getGlossaryTerms(): Array<{
    term: string;
    translation: string;
    description?: string;
    category?: string;
    status?: string;
    totalOccurrenceCount?: number;
    textBlockOccurrenceCount?: number;
  }> {
    const glossary = this.project?.getGlossary();
    if (!glossary) return [];
    return glossary.getAllTerms().map((t) => ({
      term: t.term,
      translation: t.translation,
      description: t.description,
      category: t.category,
      status: t.status,
      totalOccurrenceCount: t.totalOccurrenceCount,
      textBlockOccurrenceCount: t.textBlockOccurrenceCount,
    }));
  }

  async getRequestHistory(): Promise<LlmRequestHistoryEntry[]> {
    if (!this.project) return [];
    try {
      const projectDir = this.project.getWorkspaceFileManifest().projectDir;
      return await readHistoryEntriesFromLogDir(join(projectDir, 'logs'));
    } catch {
      return [];
    }
  }

  // ─── Lifecycle ──────────────────────────────────────

  async initializeProject(input: InitializeProjectInput): Promise<boolean> {
    if (this.isBusy) {
      this.log('warning', '正在执行其他操作，请稍候');
      return false;
    }

    const normalizedDir = input.projectDir.trim();
    if (!normalizedDir) {
      this.log('warning', '工作区路径不能为空');
      return false;
    }

    this.isBusy = true;
    this.processingToken += 1;

    try {
      const configPath = join(normalizedDir, 'Data', 'workspace-config.json');
      const hasConfig = await fileExists(configPath);

      let nextProject: TranslationProject;
      let nextTopology: StoryTopology | null = null;

      if (hasConfig) {
        this.log('info', `检测到已有工作区，正在打开：${normalizedDir}`);
        nextProject = await TranslationProject.openWorkspace(normalizedDir);
        nextTopology = nextProject.getStoryTopology() ?? null;
        if (nextTopology) {
          this.log('info', `已加载剧情拓扑（${nextTopology.getAllRoutes().length} 条路线）`);
        }
        this.plotSummaryReady = nextProject.hasPlotSummaries();
      } else {
        const chapterPaths = input.chapterPaths
          .map((p) => p.trim())
          .filter(Boolean);
        if (!input.projectName.trim()) {
          this.log('warning', '项目名称不能为空');
          return false;
        }
        if (chapterPaths.length === 0) {
          this.log('warning', '至少需要提供一个章节文件');
          return false;
        }

        const allChapterPaths = [...chapterPaths];
        const branches = input.branches ?? [];
        for (const branch of branches) {
          allChapterPaths.push(...branch.chapterPaths);
        }

        this.log('info', `正在初始化项目：${input.projectName.trim()}`);
        nextProject = new TranslationProject(
          {
            projectName: input.projectName.trim(),
            projectDir: normalizedDir,
            chapters: allChapterPaths.map((filePath, index) => ({
              id: index + 1,
              filePath,
            })),
            glossary: input.glossaryPath?.trim()
              ? { path: input.glossaryPath.trim(), autoFilter: true }
              : undefined,
            customRequirements: [
              input.srcLang?.trim()
                ? `源语言: ${input.srcLang.trim()}`
                : undefined,
              input.tgtLang?.trim()
                ? `目标语言: ${input.tgtLang.trim()}`
                : undefined,
            ].filter((v): v is string => Boolean(v)),
          },
          {
            fileHandlerResolver: input.importFormat
              ? () =>
                  TranslationFileHandlerFactory.getHandler(input.importFormat!)
              : undefined,
          },
        );
        await nextProject.initialize();

        if (branches.length > 0) {
          nextTopology = StoryTopology.createEmpty();
          const mainChapterIds = chapterPaths.map((_, i) => i + 1);
          nextTopology.setMainRouteChapters(mainChapterIds);

          let offset = chapterPaths.length;
          for (const branch of branches) {
            const branchIds = branch.chapterPaths.map(
              (_, i) => offset + i + 1,
            );
            offset += branch.chapterPaths.length;
            nextTopology.addBranch({
              id: branch.routeId,
              name: branch.routeName,
              forkAfterChapterId: branch.forkAfterChapterId,
              chapters: branchIds,
            });
            this.log(
              'info',
              `已添加支线"${branch.routeName}"（${branchIds.length} 章节）`,
            );
          }
          await nextProject.saveStoryTopology(nextTopology);
        }

        this.plotSummaryReady = false;
      }

      await applyWorkspacePreferences(nextProject, {
        importFormat: input.importFormat,
        translatorName: input.translatorName,
      });

      if (!hasConfig) {
        await nextProject.saveProgress();
        this.log('info', '工作区初始化数据已即时保存');
      }

      // Register workspace
      const registry = new WorkspaceRegistry();
      await registry.touchWorkspace({
        name: nextProject.getProjectSnapshot().projectName,
        dir: normalizedDir,
      });

      this.closeInternal();
      this.project = nextProject;
      this.topology = nextTopology;
      this.snapshot = nextProject.getProjectSnapshot();
      this.startPolling();

      this.log(
        'success',
        `${hasConfig ? '已打开工作区' : '已初始化项目'}：${this.snapshot.projectName}`,
      );
      this.broadcastSnapshot();
      return true;
    } catch (error) {
      this.log('error', `初始化项目失败：${toMsg(error)}`);
      return false;
    } finally {
      this.isBusy = false;
    }
  }

  async startTranslation(): Promise<void> {
    await this.runAction('启动翻译流程', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');

      if (!this.project.hasPlotSummaries()) {
        this.log(
          'warning',
          '尚未生成情节大纲，可能影响翻译效果',
        );
      }

      const lifecycle = await this.project.startTranslation();
      this.refreshSnapshot();
      this.log(
        'success',
        `翻译流程已启动，当前状态：${lifecycle.status}`,
      );
      if (lifecycle.status === 'running') {
        this.startTranslationLoop(this.project);
      }
    });
  }

  async pauseTranslation(): Promise<void> {
    await this.runAction('暂停翻译流程', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');
      const lifecycle = await this.project.stopTranslation();
      this.refreshSnapshot();
      this.log('success', `已提交暂停请求，当前状态：${lifecycle.status}`);
    });
  }

  async resumeTranslation(): Promise<void> {
    await this.runAction('恢复翻译流程', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');

      if (!this.project.hasPlotSummaries()) {
        this.log('warning', '尚未生成情节大纲，可能影响翻译效果');
      }

      const lifecycle = await this.project.startTranslation();
      this.refreshSnapshot();
      this.log('success', `翻译流程已恢复，当前状态：${lifecycle.status}`);
      if (lifecycle.status === 'running') {
        this.startTranslationLoop(this.project);
      }
    });
  }

  async abortTranslation(): Promise<void> {
    await this.runAction('中止翻译流程', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');
      this.processingToken += 1;
      const lifecycle = await this.project.abortTranslation(
        'webui_abort_requested',
      );
      this.refreshSnapshot();
      this.log('warning', `翻译流程已中止，当前状态：${lifecycle.status}`);
    });
  }

  // ─── Dictionary / Glossary ──────────────────────────

  async scanDictionary(): Promise<void> {
    if (this.isBusy) {
      this.log('warning', '正在执行其他操作，请稍候');
      return;
    }
    if (!this.project) {
      this.log('warning', '当前没有已初始化的项目');
      return;
    }

    this.clearTaskProgressUi('all');
    this.isBusy = true;
    this.scanDictionaryProgress = {
      status: 'running',
      totalBatches: 0,
      completedBatches: 0,
      totalLines: 0,
    };
    this.broadcastScanProgress();
    this.log('info', '扫描项目字典...');

    const project = this.project;

    void (async () => {
      try {
        const manager = new GlobalConfigManager();
        const globalConfig = await manager.getTranslationGlobalConfig();
        const extractorConfig = globalConfig.getGlossaryExtractorConfig();
        if (!extractorConfig?.modelName) {
          throw new Error('未配置术语提取 LLM，请先设置术语提取模型');
        }

        const provider = new TranslationGlobalConfig({
          llm: globalConfig.llm,
        }).createProvider();
        const projectDir = project.getWorkspaceFileManifest().projectDir;
        provider.setHistoryLogger(
          new FileRequestHistoryLogger(
            join(projectDir, 'logs'),
            'glossary_scan_requests',
          ),
        );

        const scanner = new FullTextGlossaryScanner(
          provider.getChatClient(extractorConfig.modelName),
          this.createLogger(),
        );

        const lines = scanner.collectLinesFromDocumentManager(
          project.getDocumentManager(),
        );
        const batches = scanner.buildBatches(lines, {
          maxCharsPerBatch: extractorConfig.maxCharsPerBatch,
        });

        this.log(
          'info',
          `术语扫描开始，共 ${lines.length} 行，分 ${batches.length} 个批次`,
        );
        this.scanDictionaryProgress = {
          status: 'running',
          totalBatches: batches.length,
          completedBatches: 0,
          totalLines: lines.length,
        };
        this.broadcastScanProgress();

        const result = await scanner.scanLines(lines, {
          maxCharsPerBatch: extractorConfig.maxCharsPerBatch,
          occurrenceTopK: extractorConfig.occurrenceTopK,
          occurrenceTopP: extractorConfig.occurrenceTopP,
          requestOptions: extractorConfig.requestOptions,
          seedTerms: project.getGlossary()?.getAllTerms(),
          onBatchProgress: (completed, total) => {
            this.scanDictionaryProgress = {
              ...this.scanDictionaryProgress!,
              completedBatches: completed,
            };
            this.broadcastScanProgress();
            this.log('info', `术语扫描批次 ${completed}/${total} 完成`);
          },
        });

        project.replaceGlossary(result.glossary);
        await project.saveProgress();
        this.refreshSnapshot();
        this.scanDictionaryProgress = {
          status: 'done',
          totalBatches: batches.length,
          completedBatches: batches.length,
          totalLines: lines.length,
        };
        this.broadcastScanProgress();
        this.log(
          'success',
          `术语提取完成，共 ${result.glossary.getAllTerms().length} 个条目`,
        );
      } catch (error) {
        this.log('error', `扫描字典失败：${toMsg(error)}`);
        this.scanDictionaryProgress = {
          ...this.scanDictionaryProgress!,
          status: 'error',
          errorMessage: toMsg(error),
        };
        this.broadcastScanProgress();
      } finally {
        this.isBusy = false;
      }
    })();
  }

  async updateDictionaryTerm(args: {
    originalTerm?: string;
    term: string;
    translation: string;
    description?: string;
    category?: string;
  }): Promise<void> {
    await this.runAction('保存字典条目', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');
      const glossary = this.project.getGlossary();
      if (!glossary) throw new Error('当前项目还没有字典');

      const existing = args.originalTerm
        ? glossary.getTerm(args.originalTerm)
        : glossary.getTerm(args.term);

      const nextTerm = {
        term: args.term,
        translation: args.translation,
        description: args.description,
        category: normalizeGlossaryCategory(args.category),
        totalOccurrenceCount: existing?.totalOccurrenceCount ?? 0,
        textBlockOccurrenceCount: existing?.textBlockOccurrenceCount ?? 0,
      };

      if (existing) {
        glossary.updateTerm(args.originalTerm ?? args.term, nextTerm);
      } else {
        glossary.addTerm(nextTerm);
      }

      await this.project.saveProgress();
      this.refreshSnapshot();
      this.log('success', `字典条目已保存：${args.term}`);
    });
  }

  async deleteDictionaryTerm(term: string): Promise<void> {
    await this.runAction('删除字典条目', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');
      const glossary = this.project.getGlossary();
      if (!glossary) throw new Error('当前项目还没有字典');
      glossary.removeTerm(term);
      await this.project.saveProgress();
      this.refreshSnapshot();
      this.log('success', `字典条目已删除：${term}`);
    });
  }

  async importGlossary(filePath: string): Promise<void> {
    await this.runAction('导入术语表', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');
      const result = await this.project.importGlossary(filePath);
      await this.project.saveProgress();
      this.refreshSnapshot();
      this.log(
        'success',
        `术语表导入完成：${result.termCount} 项（新增 ${result.newTermCount}，更新 ${result.updatedTermCount}）`,
      );
    });
  }

  async exportGlossary(outputPath: string): Promise<void> {
    await this.runAction('导出术语表', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');
      await this.project.exportGlossary(outputPath);
      this.log('success', `术语表已导出到：${outputPath}`);
    });
  }

  // ─── Plot Summary ───────────────────────────────────

  async startPlotSummary(): Promise<void> {
    if (this.isBusy) {
      this.log('warning', '正在执行其他操作，请稍候');
      return;
    }
    if (!this.project) {
      this.log('warning', '当前没有已初始化的项目');
      return;
    }

    this.clearTaskProgressUi('all');
    this.isBusy = true;
    this.plotSummaryProgress = {
      status: 'running',
      totalChapters: 0,
      completedChapters: 0,
      totalBatches: 0,
      completedBatches: 0,
    };
    this.broadcastPlotProgress();

    const project = this.project;

    void (async () => {
      try {
        const manager = new GlobalConfigManager();
        const globalConfig = await manager.getTranslationGlobalConfig();
        const plotConfig = globalConfig.getPlotSummaryConfig();
        if (!plotConfig?.modelName) {
          throw new Error('未配置情节总结 LLM');
        }

        const runtimeConfig = new TranslationGlobalConfig({
          llm: globalConfig.llm,
        });
        const provider = runtimeConfig.createProvider();
        const documentManager = project.getDocumentManager();
        const projectDir = project.getWorkspaceFileManifest().projectDir;

        provider.setHistoryLogger(
          new FileRequestHistoryLogger(
            join(projectDir, 'logs'),
            'plot_summary_requests',
          ),
        );

        const summaryPath = join(projectDir, 'Data', 'plot-summaries.json');
        const currentTopology = project.getStoryTopology();

        const summarizer = new PlotSummarizer(
          { provider, modelName: plotConfig.modelName },
          documentManager,
          summaryPath,
          {
            fragmentsPerBatch: plotConfig.fragmentsPerBatch,
            maxContextSummaries: plotConfig.maxContextSummaries,
            requestOptions: plotConfig.requestOptions,
            logger: this.createLogger(),
            topology: currentTopology,
          },
        );
        await summarizer.loadSummaries();

        const chapters = documentManager.getAllChapters();
        const totalChapters = chapters.length;
        const fragmentsPerBatch = plotConfig.fragmentsPerBatch ?? 5;
        let totalBatches = 0;
        for (const ch of chapters) {
          totalBatches += Math.ceil(ch.fragments.length / fragmentsPerBatch);
        }

        let completedChapters = 0;
        let completedBatches = 0;
        this.plotSummaryProgress = {
          status: 'running',
          totalChapters,
          completedChapters: 0,
          totalBatches,
          completedBatches: 0,
        };
        this.broadcastPlotProgress();

        for (const chapter of chapters) {
          this.log(
            'info',
            `开始总结章节 ${chapter.id}（${chapter.fragments.length} 个文本块）`,
          );
          this.plotSummaryProgress = {
            ...this.plotSummaryProgress,
            currentChapterId: chapter.id,
          };
          this.broadcastPlotProgress();

          let fragmentIndex = 0;
          while (fragmentIndex < chapter.fragments.length) {
            const count = Math.min(
              fragmentsPerBatch,
              chapter.fragments.length - fragmentIndex,
            );
            await summarizer.summarizeFragments(
              chapter.id,
              fragmentIndex,
              count,
            );
            fragmentIndex += count;
            completedBatches += 1;
            this.plotSummaryProgress = {
              ...this.plotSummaryProgress,
              completedBatches,
              completedChapters,
            };
            this.broadcastPlotProgress();
          }

          completedChapters += 1;
          this.log('success', `章节 ${chapter.id} 总结完成`);
          this.plotSummaryProgress = {
            ...this.plotSummaryProgress,
            completedChapters,
          };
          this.broadcastPlotProgress();
        }

        this.plotSummaryProgress = {
          status: 'done',
          totalChapters,
          completedChapters,
          totalBatches,
          completedBatches,
        };
        this.broadcastPlotProgress();
        await project.reloadNarrativeArtifacts();
        this.topology = project.getStoryTopology() ?? null;
        this.plotSummaryReady = project.hasPlotSummaries();
        this.log(
          'success',
          `情节大纲完成（${totalChapters} 章节，${completedBatches} 批）`,
        );
      } catch (error) {
        this.log('error', `情节总结失败：${toMsg(error)}`);
        this.plotSummaryProgress = {
          ...this.plotSummaryProgress!,
          status: 'error',
          errorMessage: toMsg(error),
        };
        this.broadcastPlotProgress();
      } finally {
        this.isBusy = false;
      }
    })();
  }

  clearTaskProgressUi(task: 'scan' | 'plot' | 'all' = 'all'): void {
    if (task === 'scan' || task === 'all') {
      this.scanDictionaryProgress = null;
      this.broadcastScanProgress();
    }
    if (task === 'plot' || task === 'all') {
      this.plotSummaryProgress = null;
      this.broadcastPlotProgress();
    }
  }

  // ─── Export ─────────────────────────────────────────

  async exportProject(
    formatName: string,
  ): Promise<ProjectExportResult | null> {
    if (!this.project) {
      this.log('warning', '当前没有已初始化的项目');
      return null;
    }

    let result: ProjectExportResult | null = null;
    await this.runAction('导出翻译文件', async () => {
      const exported = await this.project!.exportProject(formatName);
      result = exported;
      this.log(
        'success',
        `导出完成：${exported.totalChapters} 章节，${exported.totalUnits} 翻译单元 → ${exported.exportDir}`,
      );
    });
    return result;
  }

  // ─── Chapter Management ─────────────────────────────

  async addChapter(
    filePath: string,
    options?: { format?: string; importTranslation?: boolean },
  ): Promise<void> {
    await this.runAction('添加章节', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');
      const descriptors = this.project.getChapterDescriptors();
      const nextId =
        descriptors.length > 0
          ? Math.max(...descriptors.map((d) => d.id)) + 1
          : 1;
      const result = await this.project.addChapter(nextId, filePath, options);
      this.refreshSnapshot();
      this.log(
        'success',
        `已添加章节 ${result.chapterId}（${result.fragmentCount} 文本块）`,
      );
    });
  }

  async removeChapter(chapterId: number): Promise<void> {
    await this.runAction('删除章节', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');
      await this.project.removeChapter(chapterId);
      this.refreshSnapshot();
      this.log('success', `章节 ${chapterId} 已移除`);
    });
  }

  async reorderChapters(chapterIds: number[]): Promise<void> {
    await this.runAction('保存章节排序', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');
      await this.project.reorderChapters(chapterIds);
    });
  }

  // ─── Config ─────────────────────────────────────────

  async updateWorkspaceConfig(patch: WorkspaceConfigPatch): Promise<void> {
    await this.runAction('保存工作区配置', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');
      await this.project.updateWorkspaceConfig(patch);
      this.refreshSnapshot();
    });
  }

  // ─── Reset ──────────────────────────────────────────

  async resetProject(options: {
    clearAllTranslations?: boolean;
    clearGlossary?: boolean;
    clearGlossaryTranslations?: boolean;
    clearPlotSummaries?: boolean;
  }): Promise<void> {
    await this.runAction('重置项目', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');

      if (options.clearAllTranslations) {
        await this.project.clearAllTranslations();
        this.log('success', '已清空所有译文');
      }
      if (options.clearGlossary) {
        await this.project.clearGlossary();
        this.log('success', '已清除术语表');
      } else if (options.clearGlossaryTranslations) {
        await this.project.clearGlossaryTranslations();
        this.log('success', '已清除术语表译文');
      }
      if (options.clearPlotSummaries) {
        await this.project.clearPlotSummaries();
        this.plotSummaryReady = false;
        this.log('success', '已清除情节大纲');
      }
      this.refreshSnapshot();
    });
  }

  async clearChapterTranslations(chapterIds: number[]): Promise<void> {
    await this.runAction('清除章节译文', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');
      await this.project.clearChapterTranslations(chapterIds);
      this.refreshSnapshot();
      this.log('success', `已清除 ${chapterIds.length} 个章节的译文`);
    });
  }

  // ─── Workspace Close / Remove ───────────────────────

  closeWorkspace(): void {
    this.closeInternal();
    this.log('info', '已关闭当前工作区');
    this.broadcastSnapshot();
  }

  async removeWorkspace(): Promise<void> {
    const dir = this.project?.getWorkspaceFileManifest().projectDir;
    this.closeInternal();
    if (dir) {
      await this.workspaceManager.removeWorkspace(dir);
      this.log('success', `工作区已移除：${dir}`);
    }
    this.broadcastSnapshot();
  }

  // ─── Internal ───────────────────────────────────────

  private closeInternal(): void {
    this.processingToken += 1;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.project = null;
    this.snapshot = null;
    this.topology = null;
    this.plotSummaryProgress = null;
    this.scanDictionaryProgress = null;
    this.isBusy = false;
  }

  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      if (!this.project) return;
      try {
        this.snapshot = this.project.getProjectSnapshot();
        this.broadcastSnapshot();
      } catch {
        // ignore
      }
    }, 1000);
  }

  private refreshSnapshot(): void {
    if (!this.project) {
      this.snapshot = null;
      return;
    }
    this.snapshot = this.project.getProjectSnapshot();
    this.broadcastSnapshot();
  }

  private broadcastSnapshot(): void {
    this.eventBus.emit({
      type: 'snapshot',
      data: this.snapshot,
    });
  }

  private broadcastScanProgress(): void {
    this.eventBus.emit({
      type: 'scanProgress',
      data: this.scanDictionaryProgress,
    });
  }

  private broadcastPlotProgress(): void {
    this.eventBus.emit({
      type: 'plotProgress',
      data: this.plotSummaryProgress,
    });
  }

  private async runAction(
    label: string,
    action: () => Promise<void>,
  ): Promise<void> {
    if (this.isBusy) {
      this.log('warning', `正在执行其他操作，请稍候：${label}`);
      return;
    }
    this.isBusy = true;
    this.log('info', `${label}...`);
    try {
      await action();
    } catch (error) {
      this.log('error', `${label}失败：${toMsg(error)}`);
    } finally {
      this.isBusy = false;
    }
  }

  private startTranslationLoop(currentProject: TranslationProject): void {
    const token = ++this.processingToken;

    void (async () => {
      try {
        const processor = await createProcessorForProject(
          currentProject,
          (level, msg) => this.log(level, msg),
        );
        this.log('info', '翻译处理器已就绪，开始调度队列');

        while (this.processingToken === token) {
          const lifecycle = currentProject.getLifecycleSnapshot();
          if (
            lifecycle.status !== 'running' &&
            lifecycle.status !== 'stopping'
          ) {
            break;
          }

          let workItems: Awaited<
            ReturnType<TranslationProject['dispatchReadyWorkItems']>
          >;
          try {
            workItems = await currentProject.dispatchReadyWorkItems();
          } catch (error) {
            const msg = toMsg(error);
            if (msg.includes('停止中') || msg.includes('尚未启动')) break;
            throw error;
          }

          if (workItems.length === 0) {
            await delay(400);
            this.refreshSnapshot();
            continue;
          }

          const pendingItems = [...workItems];
          while (pendingItems.length > 0) {
            if (this.processingToken !== token) return;
            const item = pendingItems.shift()!;

            this.log(
              'info',
              `处理 ${item.stepId} · Ch${item.chapterId}/F${item.fragmentIndex + 1}`,
            );

            try {
              const result = await processor.processWorkItem(item, {
                glossary: currentProject.getGlossary(),
                documentManager: currentProject.getDocumentManager(),
              });
              if (this.processingToken !== token) return;

              await currentProject.submitWorkResult({
                runId: item.runId,
                stepId: item.stepId,
                chapterId: item.chapterId,
                fragmentIndex: item.fragmentIndex,
                outputText: result.outputText,
              });
              await maybePersistProgress(currentProject, result);
              this.refreshSnapshot();
              this.log(
                'success',
                `完成 ${item.stepId} · Ch${item.chapterId}/F${item.fragmentIndex + 1}`,
              );
            } catch (error) {
              if (this.processingToken !== token) return;
              try {
                await currentProject.submitWorkResult({
                  runId: item.runId,
                  stepId: item.stepId,
                  chapterId: item.chapterId,
                  fragmentIndex: item.fragmentIndex,
                  success: false,
                  errorMessage: toMsg(error),
                });
              } catch {
                // ignore
              }
              this.refreshSnapshot();
              this.log(
                'error',
                `处理失败 ${item.stepId} · Ch${item.chapterId}/F${item.fragmentIndex + 1}：${toMsg(error)}`,
              );
            }

            try {
              const newItems =
                await currentProject.dispatchReadyWorkItems();
              pendingItems.push(...newItems);
            } catch (err) {
              const msg = toMsg(err);
              if (msg.includes('停止中') || msg.includes('尚未启动')) break;
              throw err;
            }
          }
        }

        this.refreshSnapshot();
      } catch (error) {
        this.log('error', `翻译执行循环异常：${toMsg(error)}`);
        this.refreshSnapshot();
      }
    })();
  }

  private log(level: 'error' | 'warning' | 'info' | 'success', message: string): void {
    this.eventBus.addLog(level, message);
  }

  private createLogger(): Logger {
    return {
      info: (msg: string) => this.log('info', msg),
      warn: (msg: string) => this.log('warning', msg),
      error: (msg: string) => this.log('error', msg),
      debug: () => {},
    };
  }
}

// ─── Helpers (from TUI ProjectContext) ─────────────────

function toMsg(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const file = Bun.file(path);
    return await file.exists();
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const GLOSSARY_CATEGORIES = new Set([
  'personName',
  'placeName',
  'properNoun',
  'personTitle',
  'catchphrase',
]);

function normalizeGlossaryCategory(
  value?: string,
): GlossaryTermCategory | undefined {
  if (!value || !GLOSSARY_CATEGORIES.has(value)) return undefined;
  return value as GlossaryTermCategory;
}

async function applyWorkspacePreferences(
  project: TranslationProject,
  prefs: { importFormat?: string; translatorName?: string },
): Promise<void> {
  const patch: WorkspaceConfigPatch = {};
  if (prefs.importFormat) {
    patch.defaultImportFormat = prefs.importFormat;
    patch.defaultExportFormat = prefs.importFormat;
  }
  if (prefs.translatorName) {
    patch.translator = { translatorName: prefs.translatorName };
  }
  if (Object.keys(patch).length > 0) {
    await project.updateWorkspaceConfig(patch);
  }
}

async function createProcessorForProject(
  project: TranslationProject,
  log: (
    level: 'error' | 'info' | 'warning' | 'success',
    msg: string,
  ) => void,
) {
  const manager = new GlobalConfigManager();
  const workspaceConfig = project.getWorkspaceConfig();
  const translatorName = workspaceConfig.translator?.translatorName;

  let processorConfig: TranslationProcessorConfig;

  if (translatorName) {
    const entry = await manager.getTranslator(translatorName);
    if (!entry) {
      throw new Error(`未找到名为 "${translatorName}" 的翻译器`);
    }
    processorConfig = {
      workflow: entry.type,
      modelName: entry.modelName,
      slidingWindow: entry.slidingWindow,
      requestOptions: entry.requestOptions,
      models: entry.models,
      reviewIterations: entry.reviewIterations,
    };
  } else {
    const globalConfig = await manager.getTranslationGlobalConfig();
    processorConfig = globalConfig.getTranslationProcessorConfig();
  }

  const globalConfig = await manager.getTranslationGlobalConfig();
  const runtimeConfig = new TranslationGlobalConfig({
    llm: globalConfig.llm,
    translation: {
      translationProcessor: processorConfig,
      glossaryUpdater: globalConfig.getGlossaryUpdaterConfig(),
      alignmentRepair: globalConfig.getAlignmentRepairConfig(),
    },
  });

  const provider = runtimeConfig.createProvider();
  const projectDir = project.getWorkspaceFileManifest().projectDir;
  provider.setHistoryLogger(
    new FileRequestHistoryLogger(
      join(projectDir, 'logs'),
      'translation_requests',
    ),
  );

  const logger: Logger = {
    info: (msg: string) => log('info', msg),
    warn: (msg: string) => log('warning', msg),
    error: (msg: string) => log('error', msg),
    debug: () => {},
  };

  return runtimeConfig.createTranslationProcessor({ provider, logger });
}

async function maybePersistProgress(
  project: TranslationProject,
  result: { outputText?: string },
): Promise<void> {
  if (result.outputText) {
    await project.saveProgress();
  }
}

