/**
 * 项目服务：管理当前活跃翻译项目的完整生命周期。
 *
 * 从 TUI 的 ProjectContext 提取业务逻辑，去除 React 依赖，
 * 改用 EventBus 发布状态变更事件。
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { GlobalConfigManager } from '../../config/manager.ts';
import {
  RepetitionPatternFixer,
  buildRepetitionPatternFixTasks,
  type RepetitionPatternFixResult,
  type RepetitionPatternFixTask,
} from '../../consistency/repetition-pattern-fixer.ts';
import { WorkspaceRegistry } from '../../config/workspace-registry.ts';
import { TranslationGlobalConfig, type TranslationProcessorConfig } from '../../project/config.ts';
import { PromptManager } from '../../project/prompt-manager.ts';
import { TranslationProject } from '../../project/translation-project.ts';
import { TranslationFileHandlerFactory } from '../../file-handlers/factory.ts';
import { NatureDialogKeepNameFileHandler } from '../../file-handlers/nature-dialog-file-handler.ts';
import { FullTextGlossaryScanner } from '../../glossary/index.ts';
import { GlossaryPersisterFactory } from '../../glossary/persister.ts';
import type { GlossaryTermCategory } from '../../glossary/glossary.ts';
import {
  FileRequestHistoryLogger,
  readHistoryDetailFromLogDir,
  readHistoryDigestFromLogDir,
  readHistoryEntriesFromLogDir,
  readHistoryPageFromLogDir,
  type LlmRequestHistoryDetail,
  type LlmRequestHistoryDigest,
  type LlmRequestHistoryPage,
} from '../../llm/history.ts';
import type { LlmRequestHistoryEntry } from '../../llm/types.ts';
import { PlotSummarizer } from '../../project/plot-summarizer.ts';
import type {
  RepetitionPatternAnalysisOptions,
  RepetitionPatternAnalysisResult,
} from '../../project/repetition-pattern-analysis.ts';
import { StoryTopology } from '../../project/story-topology.ts';
import { DefaultTextSplitter } from '../../project/translation-document-manager.ts';
import type { Logger } from '../../project/logger.ts';
import type {
  GlossaryImportResult,
  ProjectExportResult,
  StoryTopologyDescriptor,
  TranslationProjectSnapshot,
  TranslationStepQueueEntrySnapshot,
  TranslationStepQueueSnapshot,
  WorkspaceChapterDescriptor,
  WorkspaceConfig,
  WorkspaceConfigPatch,
} from '../../project/types.ts';
import type { EventBus } from './event-bus.ts';
import { extractArchiveToDirectory } from './archive-extractor.ts';
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
  importFormat?: string;
  translatorName?: string;
  textSplitMaxChars?: number;
  importTranslation?: boolean;
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

export interface RepetitionPatternConsistencyFixProgress {
  status: 'running' | 'done' | 'error';
  llmProfileName: string;
  totalPatterns: number;
  completedPatterns: number;
  failedPatterns: number;
  runningPatterns: string[];
  lastAppliedPatternText?: string;
  errorMessage?: string;
}

export interface ImportedArchiveChapter {
  chapterId: number;
  filePath: string;
}

export interface ImportedArchiveFailedFile {
  filePath: string;
  error: string;
}

export interface ImportArchiveChaptersResult {
  ok: boolean;
  addedCount: number;
  failedCount: number;
  addedChapters: ImportedArchiveChapter[];
  failedFiles: ImportedArchiveFailedFile[];
}

export class ProjectServiceUserInputError extends Error {}

export interface TranslationProjectProgressSnapshot
  extends Omit<
    TranslationProjectSnapshot,
    'activeWorkItems' | 'readyWorkItems'
  > {
  queueSnapshots: Array<
    Omit<TranslationStepQueueSnapshot, 'entries'> & { entries: [] }
  >;
  activeWorkItems: [];
  readyWorkItems: [];
}

export interface ProjectStatus {
  hasProject: boolean;
  isBusy: boolean;
  plotSummaryReady: boolean;
  plotSummaryProgress: PlotSummaryProgress | null;
  scanDictionaryProgress: ScanDictionaryProgress | null;
  snapshot: TranslationProjectProgressSnapshot | null;
}

export interface TranslationPreviewUnit {
  index: number;
  sourceText: string;
  translatedText: string;
  hasTranslation: boolean;
}

export interface TranslationPreviewChapter {
  chapter: WorkspaceChapterDescriptor;
  units: TranslationPreviewUnit[];
}

export interface ProjectResourceVersions {
  dictionaryRevision: number;
  chaptersRevision: number;
  topologyRevision: number;
  workspaceConfigRevision: number;
}

// ─── Service ────────────────────────────────────────────

export class ProjectService {
  private project: TranslationProject | null = null;
  private snapshot: TranslationProjectProgressSnapshot | null = null;
  private fullSnapshot: TranslationProjectSnapshot | null = null;
  private topology: StoryTopology | null = null;
  private isBusy = false;
  private processingToken = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private plotSummaryProgress: PlotSummaryProgress | null = null;
  private scanDictionaryProgress: ScanDictionaryProgress | null = null;
  private repetitionPatternConsistencyFixProgress: RepetitionPatternConsistencyFixProgress | null =
    null;
  private plotSummaryReady = false;
  private resourceVersions: ProjectResourceVersions = {
    dictionaryRevision: 0,
    chaptersRevision: 0,
    topologyRevision: 0,
    workspaceConfigRevision: 0,
  };

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

  getSnapshot(): TranslationProjectProgressSnapshot | null {
    return this.snapshot;
  }

  getSnapshotWithEntries(): TranslationProjectSnapshot | null {
    return this.fullSnapshot;
  }

  getQueueEntries(stepId: string): TranslationStepQueueEntrySnapshot[] {
    if (!this.project) {
      return [];
    }
    return this.project.getQueueSnapshot(stepId).entries;
  }

  getWorkspaceConfig(): WorkspaceConfig | null {
    return this.project?.getWorkspaceConfig() ?? null;
  }

  getChapterDescriptors(): WorkspaceChapterDescriptor[] {
    return this.project?.getChapterDescriptors() ?? [];
  }

  getTopology(): StoryTopologyDescriptor | null {
    return this.project?.getStoryTopologyDescriptor() ?? null;
  }

  getResourceVersions(): ProjectResourceVersions {
    return { ...this.resourceVersions };
  }

  getChapterPreview(chapterId: number): TranslationPreviewChapter | null {
    if (!this.project?.getChapterDescriptor(chapterId)) {
      return null;
    }
    return this.project.getChapterTranslationPreview(chapterId);
  }

  getRepeatedPatterns(
    options: RepetitionPatternAnalysisOptions = {},
  ): RepetitionPatternAnalysisResult | null {
    return this.project?.analyzeRepeatedPatterns(options) ?? null;
  }

  async updateRepeatedPatternTranslation(input: {
    chapterId: number;
    fragmentIndex: number;
    lineIndex: number;
    translation: string;
  }): Promise<void> {
    if (this.isBusy) {
      throw new ProjectServiceUserInputError('正在执行其他操作，请稍候');
    }
    if (!this.project) {
      throw new ProjectServiceUserInputError('当前没有已初始化的项目');
    }

    this.isBusy = true;
    this.log(
      'info',
      `正在保存一致性分析译文：Ch${input.chapterId}/F${input.fragmentIndex + 1}/L${input.lineIndex + 1}`,
    );
    try {
      await this.project.updateTranslatedLine(
        input.chapterId,
        input.fragmentIndex,
        input.lineIndex,
        input.translation,
      );
      this.refreshSnapshot();
      this.markChaptersChanged();
      this.log('success', '一致性分析译文已保存');
    } finally {
      this.isBusy = false;
    }
  }

  getRepeatedPatternTranslationContext(input: {
    chapterId: number;
    unitIndex: number;
  }): {
    chapterId: number;
    unitIndex: number;
    startUnitIndex: number;
    endUnitIndexExclusive: number;
    entries: Array<{
      unitIndex: number;
      content: string;
      isFocus: boolean;
    }>;
  } | null {
    if (!this.project?.getChapterDescriptor(input.chapterId)) {
      return null;
    }

    const preview = this.project.getChapterTranslationPreview(input.chapterId);
    const contextRadius = 3;
    const startUnitIndex = Math.max(0, input.unitIndex - contextRadius);
    const endUnitIndexExclusive = Math.min(
      preview.units.length,
      input.unitIndex + contextRadius + 1,
    );
    const handler = new NatureDialogKeepNameFileHandler();
    const entries = preview.units
      .slice(startUnitIndex, endUnitIndexExclusive)
      .map((unit, offset) => {
        const unitIndex = startUnitIndex + offset;
        return {
          unitIndex: unitIndex + 1,
          content: handler
            .formatTranslationUnits([
              {
                source: unit.sourceText,
                target: unit.hasTranslation ? [unit.translatedText] : [],
              },
            ])
            .trimEnd(),
          isFocus: unitIndex === input.unitIndex,
        };
      });

    return {
      chapterId: input.chapterId,
      unitIndex: input.unitIndex + 1,
      startUnitIndex: startUnitIndex + 1,
      endUnitIndexExclusive,
      entries,
    };
  }

  getRepetitionPatternConsistencyFixProgress(): RepetitionPatternConsistencyFixProgress | null {
    return this.repetitionPatternConsistencyFixProgress
      ? {
          ...this.repetitionPatternConsistencyFixProgress,
          runningPatterns: [...this.repetitionPatternConsistencyFixProgress.runningPatterns],
        }
      : null;
  }

  async startRepetitionPatternConsistencyFix(input: {
    llmProfileName: string;
    minOccurrences?: number;
    minLength?: number;
    maxResults?: number;
  }): Promise<RepetitionPatternConsistencyFixProgress> {
    if (this.isBusy) {
      throw new ProjectServiceUserInputError('正在执行其他操作，请稍候');
    }
    if (!this.project) {
      throw new ProjectServiceUserInputError('当前没有已初始化的项目');
    }
    if (this.repetitionPatternConsistencyFixProgress?.status === 'running') {
      throw new ProjectServiceUserInputError('表达统一修复任务正在运行');
    }

    const llmProfileName = input.llmProfileName.trim();
    if (!llmProfileName) {
      throw new ProjectServiceUserInputError('请选择一个 LLM 配置');
    }

    const manager = new GlobalConfigManager();
    await manager.getRequiredLlmProfile(llmProfileName);

    const analysis = this.project.analyzeRepeatedPatterns({
      minOccurrences: input.minOccurrences,
      minLength: input.minLength,
      maxResults: input.maxResults,
    });
    const tasks = buildRepetitionPatternFixTasks(analysis);

    this.clearRepetitionPatternConsistencyFixProgress();
    this.isBusy = true;
    this.repetitionPatternConsistencyFixProgress = {
      status: tasks.length > 0 ? 'running' : 'done',
      llmProfileName,
      totalPatterns: tasks.length,
      completedPatterns: 0,
      failedPatterns: 0,
      runningPatterns: [],
    };

    if (tasks.length === 0) {
      this.log('info', '当前没有需要 AI 统一的重复 Pattern');
      this.isBusy = false;
      return this.getRepetitionPatternConsistencyFixProgress()!;
    }

    const project = this.project;
    this.log(
      'info',
      `开始执行表达统一修复，共 ${tasks.length} 个 Pattern，LLM=${llmProfileName}`,
    );

    void this.runRepetitionPatternConsistencyFix({
      project,
      llmProfileName,
      tasks,
    });

    return this.getRepetitionPatternConsistencyFixProgress()!;
  }

  clearRepetitionPatternConsistencyFixProgress(): void {
    if (this.repetitionPatternConsistencyFixProgress?.status === 'running') {
      throw new ProjectServiceUserInputError('表达统一修复任务仍在运行，暂时不能关闭进度');
    }
    this.repetitionPatternConsistencyFixProgress = null;
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

  async getRequestHistoryDigest(): Promise<LlmRequestHistoryDigest> {
    if (!this.project) {
      return {
        total: 0,
        latestId: 0,
      };
    }
    const projectDir = this.project.getWorkspaceFileManifest().projectDir;
    return readHistoryDigestFromLogDir(join(projectDir, 'logs'));
  }

  async getRequestHistoryPage(options: {
    limit?: number;
    beforeId?: number;
  }): Promise<LlmRequestHistoryPage> {
    if (!this.project) {
      return {
        items: [],
        total: 0,
        latestId: 0,
      };
    }
    const projectDir = this.project.getWorkspaceFileManifest().projectDir;
    return readHistoryPageFromLogDir(join(projectDir, 'logs'), options);
  }

  async getRequestHistoryDetail(id: number): Promise<LlmRequestHistoryDetail | null> {
    if (!this.project) {
      return null;
    }
    const projectDir = this.project.getWorkspaceFileManifest().projectDir;
    return readHistoryDetailFromLogDir(join(projectDir, 'logs'), id);
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
            textSplitMaxChars: input.textSplitMaxChars,
            customRequirements: [],
          },
          {
            textSplitter:
              typeof input.textSplitMaxChars === 'number'
                ? new DefaultTextSplitter(input.textSplitMaxChars)
                : undefined,
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

        await nextProject.reconcileImportedTranslations(
          nextProject.getChapterDescriptors().map((chapter) => chapter.id),
          {
            importTranslation: input.importTranslation ?? false,
          },
        );

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
      this.fullSnapshot = nextProject.getProjectSnapshot();
      this.snapshot = toProgressSnapshot(this.fullSnapshot);
      this.resetResourceVersions(1);
      this.startPolling();

      this.log(
        'success',
        `${hasConfig ? '已打开工作区' : '已初始化项目'}：${this.snapshot?.projectName ?? ''}`,
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
        if (!extractorConfig || extractorConfig.modelNames.length === 0) {
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
          provider.getChatClientWithFallback(extractorConfig.modelNames),
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
        this.markDictionaryChanged();
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
      this.markDictionaryChanged();
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
      this.markDictionaryChanged();
      this.log('success', `字典条目已删除：${term}`);
    });
  }

  async importGlossary(filePath: string): Promise<void> {
    await this.runAction('导入术语表', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');
      const result = await this.project.importGlossary(filePath);
      await this.project.saveProgress();
      this.refreshSnapshot();
      this.markDictionaryChanged();
      this.log(
        'success',
        `术语表导入完成：${result.termCount} 项（新增 ${result.newTermCount}，更新 ${result.updatedTermCount}）`,
      );
    });
  }

  async importGlossaryFromContent(
    content: string,
    format: 'csv' | 'tsv',
  ): Promise<GlossaryImportResult> {
    if (this.isBusy) {
      throw new ProjectServiceUserInputError('正在执行其他操作，请稍候');
    }
    if (!this.project) {
      throw new ProjectServiceUserInputError('当前没有已初始化的项目');
    }
    if (!content.trim()) {
      throw new ProjectServiceUserInputError('粘贴内容不能为空');
    }

    this.isBusy = true;
    this.log('info', `正在导入粘贴术语（${format.toUpperCase()}）...`);
    const projectDir = this.project.getWorkspaceFileManifest().projectDir;
    const tempPath = join(
      projectDir,
      'Data',
      '.tmp',
      `glossary-paste-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${format}`,
    );

    try {
      await mkdir(dirname(tempPath), { recursive: true });
      await writeFile(tempPath, content, 'utf8');
      const importedGlossary =
        await GlossaryPersisterFactory.getPersister(tempPath).loadGlossary(tempPath);
      const importedTerms = importedGlossary
        .getAllTerms()
        .map((term) => ({
          term: term.term.trim(),
          translation: term.translation,
          description: term.description,
        }))
        .filter((term) => term.term.length > 0);

      const glossary = this.project.getGlossary();
      if (!glossary) {
        throw new ProjectServiceUserInputError('当前项目还没有术语表');
      }

      let newTermCount = 0;
      let updatedTermCount = 0;
      for (const term of importedTerms) {
        const existing = glossary.getTerm(term.term);
        const nextTerm = {
          term: term.term,
          translation: term.translation,
          description: term.description,
          category: existing?.category,
          totalOccurrenceCount: existing?.totalOccurrenceCount ?? 0,
          textBlockOccurrenceCount: existing?.textBlockOccurrenceCount ?? 0,
        };

        if (existing) {
          glossary.updateTerm(term.term, nextTerm);
          updatedTermCount += 1;
        } else {
          glossary.addTerm(nextTerm);
          newTermCount += 1;
        }
      }

      const result: GlossaryImportResult = {
        filePath: `pasted.${format}`,
        termCount: importedTerms.length,
        newTermCount,
        updatedTermCount,
      };

      await this.project.saveProgress();
      this.refreshSnapshot();
      this.markDictionaryChanged();
      this.log(
        'success',
        `术语粘贴导入完成：${result.termCount} 项（新增 ${result.newTermCount}，更新 ${result.updatedTermCount}）`,
      );
      return result;
    } catch (error) {
      this.log('error', `术语粘贴导入失败：${toMsg(error)}`);
      throw error;
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
      this.isBusy = false;
    }
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
        if (!plotConfig || plotConfig.modelNames.length === 0) {
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
          provider.getChatClientWithFallback(plotConfig.modelNames),
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
      this.markChaptersChanged();
      this.markTopologyChanged();
      this.log(
        'success',
        `已添加章节 ${result.chapterId}（${result.fragmentCount} 文本块）`,
      );
    });
  }

  async importChaptersFromArchive(input: {
    archiveBuffer: ArrayBuffer;
    archiveFileName: string;
    importFormat?: string;
    importPattern?: string;
    importTranslation?: boolean;
  }): Promise<ImportArchiveChaptersResult> {
    if (this.isBusy) {
      throw new ProjectServiceUserInputError('正在执行其他操作，请稍候');
    }
    if (!this.project) {
      throw new ProjectServiceUserInputError('当前没有已初始化的项目');
    }

    this.isBusy = true;
    this.log('info', '正在从压缩包追加章节...');

    const project = this.project;
    const workspaceDir = project.getWorkspaceFileManifest().projectDir;
    const importRootRelativePath = `Data/.archive-import/${Date.now()}`;
    const importRootAbsolutePath = join(workspaceDir, ...importRootRelativePath.split('/'));

    try {
      await mkdir(importRootAbsolutePath, { recursive: true });
      const extractedFiles = await extractArchiveToDirectory(
        importRootAbsolutePath,
        input.archiveBuffer,
        {
          archiveFileName: input.archiveFileName,
          stripSingleRoot: true,
        },
      );

      const matchedFiles = await resolveImportedArchiveTextFiles(
        importRootAbsolutePath,
        extractedFiles,
        input.importPattern,
      );
      if (matchedFiles.length === 0) {
        throw new ProjectServiceUserInputError(
          '压缩包中没有文件匹配追加 Pattern，或匹配文件不是可识别的文本文件',
        );
      }

      const normalizedImportFormat = normalizeOptionalString(input.importFormat);
      const normalizedImportTranslation = input.importTranslation ?? false;
      const addedChapters: ImportedArchiveChapter[] = [];
      const failedFiles: ImportedArchiveFailedFile[] = [];
      const descriptors = project.getChapterDescriptors();
      let nextChapterId =
        descriptors.length > 0
          ? Math.max(...descriptors.map((descriptor) => descriptor.id)) + 1
          : 1;

      for (const relativeArchivePath of matchedFiles) {
        const absoluteFilePath = join(importRootAbsolutePath, ...relativeArchivePath.split('/'));
        const targetRelativePath = await resolveAppendTargetRelativePath(
          workspaceDir,
          relativeArchivePath,
        );
        const targetAbsolutePath = join(workspaceDir, ...targetRelativePath.split('/'));

        try {
          await mkdir(dirname(targetAbsolutePath), { recursive: true });
          await rename(absoluteFilePath, targetAbsolutePath);

          const result = await project.addChapter(nextChapterId, targetRelativePath, {
            format: normalizedImportFormat,
            importTranslation: normalizedImportTranslation,
          });
          nextChapterId += 1;
          addedChapters.push({
            chapterId: result.chapterId,
            filePath: result.filePath,
          });
        } catch (error) {
          await rm(targetAbsolutePath, { force: true }).catch(() => undefined);
          failedFiles.push({
            filePath: targetRelativePath,
            error: toMsg(error),
          });
        }
      }

      if (addedChapters.length === 0) {
        this.log('warning', `压缩包追加未成功：${failedFiles.length} 个文件均导入失败`);
        return {
          ok: false,
          addedCount: 0,
          failedCount: failedFiles.length,
          addedChapters,
          failedFiles,
        };
      }

      this.refreshSnapshot();
      this.markChaptersChanged();
      this.markTopologyChanged();

      if (failedFiles.length > 0) {
        this.log(
          'warning',
          `压缩包追加完成：成功 ${addedChapters.length} 个章节，失败 ${failedFiles.length} 个文件`,
        );
      } else {
        this.log('success', `压缩包追加完成：新增 ${addedChapters.length} 个章节`);
      }

      return {
        ok: failedFiles.length === 0,
        addedCount: addedChapters.length,
        failedCount: failedFiles.length,
        addedChapters,
        failedFiles,
      };
    } catch (error) {
      this.log('error', `压缩包追加失败：${toMsg(error)}`);
      throw error;
    } finally {
      await rm(importRootAbsolutePath, { recursive: true, force: true }).catch(() => undefined);
      this.isBusy = false;
    }
  }

  async removeChapter(chapterId: number): Promise<void> {
    await this.runAction('删除章节', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');
      await this.project.removeChapter(chapterId);
      this.refreshSnapshot();
      this.markChaptersChanged();
      this.markTopologyChanged();
      this.log('success', `章节 ${chapterId} 已移除`);
    });
  }

  async removeChapters(
    chapterIds: number[],
    options: { cascadeBranches?: boolean } = {},
  ): Promise<void> {
    await this.runAction('批量删除章节', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');
      await this.project.removeChapters(chapterIds, options);
      this.refreshSnapshot();
      this.markChaptersChanged();
      this.markTopologyChanged();
      this.log('success', `已批量移除 ${chapterIds.length} 个章节`);
    });
  }

  async reorderChapters(chapterIds: number[]): Promise<void> {
    await this.runAction('保存章节排序', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');
      await this.project.reorderChapters(chapterIds);
      this.markChaptersChanged();
      this.markTopologyChanged();
    });
  }

  async createStoryBranch(input: {
    name: string;
    parentRouteId?: string;
    forkAfterChapterId: number;
    chapterIds?: number[];
  }): Promise<void> {
    await this.runAction('创建剧情分支', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');
      const routeId = this.createNextBranchRouteId();
      await this.project.createStoryBranch({
        id: routeId,
        name: input.name,
        parentRouteId: input.parentRouteId,
        forkAfterChapterId: input.forkAfterChapterId,
        chapterIds: input.chapterIds,
      });
      this.refreshSnapshot();
      this.markChaptersChanged();
      this.markTopologyChanged();
      this.log('success', `已创建分支“${input.name}”`);
    });
  }

  async updateStoryRoute(
    routeId: string,
    patch: { name?: string; forkAfterChapterId?: number },
  ): Promise<void> {
    await this.runAction('更新剧情路线', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');
      await this.project.updateStoryRoute(routeId, patch);
      this.refreshSnapshot();
      this.markChaptersChanged();
      this.markTopologyChanged();
      this.log('success', `路线 ${routeId} 已更新`);
    });
  }

  async removeStoryRoute(routeId: string): Promise<void> {
    await this.runAction('删除剧情路线', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');
      await this.project.removeStoryRoute(routeId);
      this.refreshSnapshot();
      this.markChaptersChanged();
      this.markTopologyChanged();
      this.log('success', `路线 ${routeId} 已删除`);
    });
  }

  async reorderStoryRouteChapters(routeId: string, chapterIds: number[]): Promise<void> {
    await this.runAction('保存路线章节顺序', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');
      await this.project.reorderStoryRouteChapters(routeId, chapterIds);
      this.refreshSnapshot();
      this.markChaptersChanged();
      this.markTopologyChanged();
    });
  }

  async moveChapterToRoute(
    chapterId: number,
    targetRouteId: string,
    targetIndex: number,
  ): Promise<void> {
    await this.runAction('移动章节到路线', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');
      await this.project.moveChapterToRoute(chapterId, targetRouteId, targetIndex);
      this.refreshSnapshot();
      this.markChaptersChanged();
      this.markTopologyChanged();
    });
  }

  // ─── Config ─────────────────────────────────────────

  async updateWorkspaceConfig(patch: WorkspaceConfigPatch): Promise<void> {
    await this.runAction('保存工作区配置', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');
      await this.project.updateWorkspaceConfig(patch);
      this.refreshSnapshot();
      this.markWorkspaceConfigChanged();
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
        this.markChaptersChanged();
        this.log('success', '已清空所有译文');
      }
      if (options.clearGlossary) {
        await this.project.clearGlossary();
        this.markDictionaryChanged();
        this.log('success', '已清除术语表');
      } else if (options.clearGlossaryTranslations) {
        await this.project.clearGlossaryTranslations();
        this.markDictionaryChanged();
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
      this.markChaptersChanged();
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
    this.fullSnapshot = null;
    this.topology = null;
    this.plotSummaryProgress = null;
    this.scanDictionaryProgress = null;
    this.isBusy = false;
    this.resetResourceVersions(0);
  }

  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      if (!this.project) return;
      try {
        const previousSnapshot = this.snapshot;
        const nextLifecycle = this.project.getLifecycleSnapshot();
        const nextProgress = this.project.getProgressSnapshot();

        // 空闲阶段无需每秒推送同构快照，避免 SSE 长时间占用带宽。
        const lifecycleChanged =
          previousSnapshot?.lifecycle.status !== nextLifecycle.status;
        const queueChanged =
          previousSnapshot?.lifecycle.queuedWorkItems !== nextLifecycle.queuedWorkItems ||
          previousSnapshot?.lifecycle.activeWorkItems !== nextLifecycle.activeWorkItems;
        const progressChanged =
          previousSnapshot?.progress.translatedChapters !==
            nextProgress.translatedChapters ||
          previousSnapshot?.progress.translatedFragments !==
            nextProgress.translatedFragments;

        if (!previousSnapshot || lifecycleChanged || queueChanged || progressChanged) {
          if (progressChanged) {
            this.markChaptersChanged();
          }
          this.refreshSnapshot();
        }
      } catch {
        // ignore
      }
    }, 1000);
  }

  private refreshSnapshot(): void {
    if (!this.project) {
      this.snapshot = null;
      this.fullSnapshot = null;
      this.topology = null;
      return;
    }
    this.fullSnapshot = this.project.getProjectSnapshot();
    this.snapshot = toProgressSnapshot(this.fullSnapshot);
    this.topology = this.project.getStoryTopology() ?? null;
    this.broadcastSnapshot();
  }

  private createNextBranchRouteId(): string {
    const topology = this.project?.getStoryTopologyDescriptor();
    const existingIds = new Set(topology?.routes.map((route) => route.id) ?? []);
    let sequence = Math.max(1, existingIds.size);
    while (existingIds.has(`branch-${sequence}`)) {
      sequence += 1;
    }
    return `branch-${sequence}`;
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

  private resetResourceVersions(value: number): void {
    this.resourceVersions = {
      dictionaryRevision: value,
      chaptersRevision: value,
      topologyRevision: value,
      workspaceConfigRevision: value,
    };
  }

  private markDictionaryChanged(): void {
    this.resourceVersions.dictionaryRevision += 1;
  }

  private markChaptersChanged(): void {
    this.resourceVersions.chaptersRevision += 1;
  }

  private markTopologyChanged(): void {
    this.resourceVersions.topologyRevision += 1;
  }

  private markWorkspaceConfigChanged(): void {
    this.resourceVersions.workspaceConfigRevision += 1;
  }

  private async runRepetitionPatternConsistencyFix(params: {
    project: TranslationProject;
    llmProfileName: string;
    tasks: RepetitionPatternFixTask[];
  }): Promise<void> {
    let provider: ReturnType<TranslationGlobalConfig['createProvider']> | undefined;

    try {
      const manager = new GlobalConfigManager();
      const llmProfile = await manager.getRequiredLlmProfile(params.llmProfileName);
      provider = new TranslationGlobalConfig({
        llm: {
          profiles: {
            [params.llmProfileName]: llmProfile,
          },
        },
      }).createProvider();
      const projectDir = params.project.getWorkspaceFileManifest().projectDir;
      provider.setHistoryLogger(
        new FileRequestHistoryLogger(join(projectDir, 'logs'), 'consistency_fix_requests'),
      );

      const fixer = new RepetitionPatternFixer(provider.getChatClient(params.llmProfileName), {
        logger: this.createLogger(),
      });
      const runningPatterns = new Set<string>();
      const taskResults = new Map<
        number,
        | { type: 'success'; value: RepetitionPatternFixResult }
        | { type: 'error'; task: RepetitionPatternFixTask; errorMessage: string }
      >();

      let nextTaskIndex = 0;
      let nextApplyIndex = 0;
      let flushChain = Promise.resolve();

      const syncProgress = (
        patch: Partial<RepetitionPatternConsistencyFixProgress> = {},
      ): void => {
        if (!this.repetitionPatternConsistencyFixProgress) {
          return;
        }
        this.repetitionPatternConsistencyFixProgress = {
          ...this.repetitionPatternConsistencyFixProgress,
          ...patch,
          runningPatterns: [...runningPatterns],
        };
      };

      const flushCompletedResults = async () => {
        while (taskResults.has(nextApplyIndex)) {
          const entry = taskResults.get(nextApplyIndex)!;
          taskResults.delete(nextApplyIndex);

          if (entry.type === 'success') {
            const appliedCount = await this.applyRepetitionPatternFixResult(
              params.project,
              entry.value,
            );
            syncProgress({
              completedPatterns:
                this.repetitionPatternConsistencyFixProgress!.completedPatterns + 1,
              lastAppliedPatternText: entry.value.task.patternText,
            });
            this.log(
              'success',
              `表达统一修复完成：${entry.value.task.patternText}（${appliedCount} 条译文更新）`,
            );
          } else {
            syncProgress({
              failedPatterns:
                this.repetitionPatternConsistencyFixProgress!.failedPatterns + 1,
            });
            this.log(
              'error',
              `表达统一修复失败：${entry.task.patternText}：${entry.errorMessage}`,
            );
          }

          nextApplyIndex += 1;
        }
      };

      const scheduleFlush = async () => {
        flushChain = flushChain.then(() => flushCompletedResults());
        await flushChain;
      };

      const worker = async () => {
        while (true) {
          const taskIndex = nextTaskIndex;
          nextTaskIndex += 1;
          if (taskIndex >= params.tasks.length) {
            return;
          }

          const task = params.tasks[taskIndex]!;
          runningPatterns.add(task.patternText);
          syncProgress();
          this.log('info', `表达统一修复处理中：${task.patternText}`);

          try {
            const value = await fixer.executeTask(task);
            taskResults.set(taskIndex, { type: 'success', value });
          } catch (error) {
            taskResults.set(taskIndex, {
              type: 'error',
              task,
              errorMessage: toMsg(error),
            });
          } finally {
            runningPatterns.delete(task.patternText);
            syncProgress();
            await scheduleFlush();
          }
        }
      };

      const concurrency = Math.max(
        1,
        Math.min(params.tasks.length, llmProfile.maxParallelRequests ?? 4),
      );
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      await flushChain;

      const failedPatterns = this.repetitionPatternConsistencyFixProgress?.failedPatterns ?? 0;
      const finalStatus = failedPatterns > 0 ? 'error' : 'done';
      syncProgress({
        status: finalStatus,
        errorMessage:
          finalStatus === 'error'
            ? `表达统一修复已完成，但有 ${failedPatterns} 个 Pattern 失败`
            : undefined,
      });
      this.log(
        finalStatus === 'done' ? 'success' : 'warning',
        finalStatus === 'done'
          ? `表达统一修复全部完成，共 ${params.tasks.length} 个 Pattern`
          : `表达统一修复已结束，成功 ${params.tasks.length - failedPatterns} 个，失败 ${failedPatterns} 个`,
      );
    } catch (error) {
      if (this.repetitionPatternConsistencyFixProgress) {
        this.repetitionPatternConsistencyFixProgress = {
          ...this.repetitionPatternConsistencyFixProgress,
          status: 'error',
          errorMessage: toMsg(error),
          runningPatterns: [],
        };
      }
      this.log('error', `表达统一修复执行失败：${toMsg(error)}`);
    } finally {
      this.isBusy = false;
      await provider?.closeAll();
    }
  }

  private async applyRepetitionPatternFixResult(
    project: TranslationProject,
    result: RepetitionPatternFixResult,
  ): Promise<number> {
    let appliedCount = 0;

    for (const update of result.updates) {
      const chapter = project.getDocumentManager().getChapterById(update.location.chapterId);
      const currentTranslation =
        chapter?.fragments[update.location.fragmentIndex]?.translation.lines[
          update.location.lineIndex
        ] ?? '';
      if (currentTranslation === update.translation) {
        continue;
      }

      await project.updateTranslatedLine(
        update.location.chapterId,
        update.location.fragmentIndex,
        update.location.lineIndex,
        update.translation,
      );
      appliedCount += 1;
    }

    if (appliedCount > 0) {
      await project.saveProgress();
      this.refreshSnapshot();
      this.markChaptersChanged();
    }

    return appliedCount;
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

function toProgressSnapshot(
  snapshot: TranslationProjectSnapshot | null,
): TranslationProjectProgressSnapshot | null {
  if (!snapshot) {
    return null;
  }

  return {
    ...snapshot,
    queueSnapshots: snapshot.queueSnapshots.map(({ entries: _entries, ...queue }) => ({
      ...queue,
      entries: [],
    })),
    activeWorkItems: [],
    readyWorkItems: [],
  };
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

function normalizeOptionalString(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeImportPattern(importPattern?: string): string | undefined {
  const normalizedPattern = importPattern?.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  return normalizedPattern ? normalizedPattern : undefined;
}

function buildImportGlobPatterns(importPattern: string): string[] {
  const patterns = [importPattern];
  if (!importPattern.includes('/')) {
    patterns.push(`**/${importPattern}`);
  }
  return [...new Set(patterns)];
}

function isVisibleWorkspaceFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (lower.includes('/__macosx/') || lower.startsWith('__macosx/')) {
    return false;
  }
  if (lower.includes('/.') || lower.startsWith('.')) {
    return false;
  }
  return true;
}

async function resolveImportedArchiveTextFiles(
  rootDir: string,
  extractedFiles: string[],
  importPattern?: string,
): Promise<string[]> {
  const normalizedPattern = normalizeImportPattern(importPattern);
  const visibleFiles = extractedFiles.filter((filePath) => isVisibleWorkspaceFile(filePath));

  const candidateFiles = normalizedPattern
    ? visibleFiles.filter((filePath) => {
        const normalizedFilePath = filePath.replace(/\\/g, '/');
        return buildImportGlobPatterns(normalizedPattern).some((pattern) =>
          new Bun.Glob(pattern).match(normalizedFilePath),
        );
      })
    : visibleFiles;

  const detectedFiles = await Promise.all(
    candidateFiles.map(async (filePath) =>
      (await isLikelyTextFile(join(rootDir, ...filePath.split('/')))) ? filePath : null,
    ),
  );
  return detectedFiles
    .filter((filePath): filePath is string => Boolean(filePath))
    .sort((left, right) => left.localeCompare(right));
}

async function isLikelyTextFile(filePath: string): Promise<boolean> {
  const sample = new Uint8Array(await Bun.file(filePath).slice(0, 4096).arrayBuffer());
  if (sample.length === 0) {
    return true;
  }

  let controlCharCount = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return false;
    }
    if ((byte < 9 || (byte > 13 && byte < 32)) && byte !== 27) {
      controlCharCount += 1;
    }
  }

  return controlCharCount / sample.length < 0.05;
}

const RESERVED_WORKSPACE_PREFIXES = ['data/', 'logs/', 'export/'];

async function resolveAppendTargetRelativePath(
  workspaceDir: string,
  archiveRelativePath: string,
): Promise<string> {
  const normalizedArchivePath = archiveRelativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const baseRelativePath = RESERVED_WORKSPACE_PREFIXES.some((prefix) =>
    normalizedArchivePath.toLowerCase().startsWith(prefix),
  )
    ? `sources/${normalizedArchivePath}`
    : normalizedArchivePath;

  const absolutePath = join(workspaceDir, ...baseRelativePath.split('/'));
  if (!(await fileExists(absolutePath))) {
    return baseRelativePath;
  }

  const extension = extname(baseRelativePath);
  const baseName = basename(baseRelativePath, extension);
  const dirName = dirname(baseRelativePath).replace(/\\/g, '/');

  let sequence = 1;
  while (true) {
    const candidateName = `${baseName}__append_${sequence}${extension}`;
    const candidateRelativePath =
      dirName === '.' ? candidateName : `${dirName}/${candidateName}`;
    const candidateAbsolutePath = join(workspaceDir, ...candidateRelativePath.split('/'));
    if (!(await fileExists(candidateAbsolutePath))) {
      return candidateRelativePath;
    }
    sequence += 1;
  }
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

  if (!translatorName) {
    throw new Error('当前工作区未配置翻译器，请先在工作区配置中选择命名翻译器。');
  }

  const entry = await manager.getTranslator(translatorName);
  if (!entry) {
    throw new Error(`未找到名为 "${translatorName}" 的翻译器`);
  }

  const processorConfig: TranslationProcessorConfig = {
    workflow: entry.type,
    modelNames: entry.modelNames,
    slidingWindow: entry.slidingWindow,
    requestOptions: entry.requestOptions,
    models: entry.models,
    reviewIterations: entry.reviewIterations,
  };

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

  return runtimeConfig.createTranslationProcessor({
    provider,
    logger,
    promptManager: new PromptManager({
      translationPromptSet: entry.promptSet,
    }),
  });
}

async function maybePersistProgress(
  project: TranslationProject,
  result: { outputText?: string },
): Promise<void> {
  if (result.outputText) {
    await project.saveProgress();
  }
}
