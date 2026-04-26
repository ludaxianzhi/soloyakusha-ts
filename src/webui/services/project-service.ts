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
import {
  GLOBAL_EMBEDDING_CLIENT_NAME,
  TranslationGlobalConfig,
  type TranslationProcessorConfig,
} from '../../project/config.ts';
import { buildContextNetworkDataFromTinyChunkGraph } from '../../project/context/context-network-builder.ts';
import {
  collectSourceTextBlocks,
  collectSourceTextTinyChunks,
  upsertGlobalPatternTerm,
} from '../../project/pipeline/default-translation-pipeline.ts';
import {
  PromptManager,
  type ChapterTranslationAssistantConversationTurn,
  type ChapterTranslationAssistantMode,
  type ChapterTranslationAssistantPromptInput,
  type ChapterTranslationAssistantSelectedUnit,
} from '../../project/processing/prompt-manager.ts';
import type { TranslationWorkItem } from '../../project/pipeline/pipeline.ts';
import { ContextNetworkOrderingStrategy } from '../../project/pipeline/context-network-ordering.ts';
import { GlossaryDependencyOrderingStrategy } from '../../project/pipeline/glossary-dependency-ordering.ts';
import { TranslationProcessorFactory } from '../../project/processing/translation-processor-factory.ts';
import type { ProofreadProcessor } from '../../project/processing/proofread-processor.ts';
import { TranslationProject } from '../../project/pipeline/translation-project.ts';
import {
  DEFAULT_WORKSPACE_PIPELINE_STRATEGY,
  openWorkspaceConfig,
} from '../../project/pipeline/translation-project-workspace.ts';
import type { TranslationProcessor } from '../../project/processing/translation-processor.ts';
import { TranslationFileHandlerFactory } from '../../file-handlers/factory.ts';
import { NatureDialogKeepNameFileHandler } from '../../file-handlers/nature-dialog-file-handler.ts';
import { FullTextGlossaryScanner, type FullTextGlossaryScanBatch, type FullTextGlossaryScanLine } from '../../glossary/scanner.ts';
import { GlossaryPersisterFactory } from '../../glossary/persister.ts';
import { Glossary } from '../../glossary/glossary.ts';
import type { GlossaryTerm, GlossaryTermCategory } from '../../glossary/glossary.ts';
import {
  readHistoryEntriesFromLogDir,
  type LlmRequestHistoryDetail,
  type LlmRequestHistoryDigest,
  type LlmRequestHistoryPage,
} from '../../llm/history.ts';
import type { ChatRequestOptions } from '../../llm/types.ts';
import type { LlmRequestHistoryEntry } from '../../llm/types.ts';
import { PlotSummarizer } from '../../project/context/plot-summarizer.ts';
import type {
  ChapterTranslationEditorDiagnostic,
  ChapterTranslationEditorGlossaryMatch,
  ChapterTranslationEditorLineUpdate,
  ChapterTranslationEditorRepetitionMatch,
  EditableTranslationFormat,
} from '../../project/context/chapter-translation-editor.ts';
import type {
  RepetitionPatternAnalysisOptions,
  RepetitionPatternAnalysisResult,
  SavedRepetitionPatternAnalysisResult,
} from '../../project/analysis/repetition-pattern-analysis.ts';
import { StoryTopology } from '../../project/context/story-topology.ts';
import { DefaultTextSplitter } from '../../project/document/translation-document-manager.ts';
import type { Logger } from '../../project/logger.ts';
import { computeChunkLinkGraph } from '../../vector/chunk-link-graph.ts';
import { createVectorStoreConfig } from '../../vector/types.ts';
import type {
  GlossaryImportResult,
  ProofreadTaskMode,
  ProofreadTaskState,
  ProjectExportResult,
  StoryTopologyDescriptor,
  TranslationProjectSnapshot,
  TranslationStepQueueEntrySnapshot,
  TranslationStepQueueSnapshot,
  WorkspaceChapterDescriptor,
  WorkspaceConfig,
  WorkspaceConfigPatch,
  WorkspacePipelineStrategy,
} from '../../project/types.ts';
import type { EventBus } from './event-bus.ts';
import { extractArchiveToDirectory } from './archive-extractor.ts';
import type { RequestHistoryService } from './request-history-service.ts';
import type { UsageStatsService } from './usage-stats-service.ts';
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
  pipelineStrategy?: WorkspacePipelineStrategy;
  textSplitMaxChars?: number;
  importTranslation?: boolean;
  branches?: BranchImportInput[];
}

export type ContextNetworkVectorStoreType = 'registered' | 'memory';

export interface ContextNetworkBuildResult {
  vectorStoreType: ContextNetworkVectorStoreType;
  fragmentCount: number;
  edgeCount: number;
  minEdgeStrength: number;
}

export interface PlotSummaryProgress {
  status: 'running' | 'paused' | 'done' | 'error';
  totalChapters: number;
  completedChapters: number;
  totalBatches: number;
  completedBatches: number;
  currentChapterId?: number;
  errorMessage?: string;
}

export interface ScanDictionaryProgress {
  status: 'running' | 'paused' | 'done' | 'error';
  totalBatches: number;
  completedBatches: number;
  totalLines: number;
  currentBatchIndex?: number;
  errorMessage?: string;
}

export interface ProofreadProgress {
  status: 'running' | 'paused' | 'done' | 'error';
  mode: ProofreadTaskMode;
  totalChapters: number;
  completedChapters: number;
  totalBatches: number;
  completedBatches: number;
  currentChapterId?: number;
  chapterIds: number[];
  warningCount: number;
  lastWarningMessage?: string;
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

type ResumableTaskStatus = 'running' | 'paused' | 'done' | 'error';

interface ScanDictionaryTaskState {
  status: ResumableTaskStatus;
  totalLines: number;
  totalBatches: number;
  completedBatches: number;
  nextBatchIndex: number;
  lines: FullTextGlossaryScanLine[];
  batches: FullTextGlossaryScanBatch[];
  glossary: Glossary;
  requestOptions?: ChatRequestOptions;
  maxCharsPerBatch?: number;
  occurrenceTopK?: number;
  occurrenceTopP?: number;
  abortRequested: boolean;
  errorMessage?: string;
}

interface PlotSummaryTaskState {
  status: ResumableTaskStatus;
  totalChapters: number;
  completedChapters: number;
  totalBatches: number;
  completedBatches: number;
  nextChapterIndex: number;
  nextFragmentIndex: number;
  chapters: Array<{ chapterId: number; fragmentCount: number }>;
  requestOptions?: ChatRequestOptions;
  fragmentsPerBatch: number;
  maxContextSummaries: number;
  summaryPath: string;
  abortRequested: boolean;
  errorMessage?: string;
}

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
  proofreadProgress: ProofreadProgress | null;
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

export interface ChapterTranslationEditorDocument {
  baseline: {
    chapterId: number;
    format: EditableTranslationFormat;
    unitCount: number;
    rawLineCount: number;
  };
  content: string;
  units: Array<{
    unitIndex: number;
    fragmentIndex: number;
    lineIndex: number;
    sourceText: string;
    translatedText: string;
    targetCandidates: string[];
  }>;
  diagnostics: ChapterTranslationEditorDiagnostic[];
  glossaryMatches: ChapterTranslationEditorGlossaryMatch[];
  repetitionMatches: ChapterTranslationEditorRepetitionMatch[];
}

export interface ChapterTranslationAssistantRequest {
  chapterId: number;
  format: EditableTranslationFormat;
  llmProfileName: string;
  mode: ChapterTranslationAssistantMode;
  selectedUnits: ChapterTranslationAssistantSelectedUnit[];
  conversationTurns: ChapterTranslationAssistantConversationTurn[];
  instruction: string;
  glossaryHints: string[];
  repetitionHints: string[];
}

export interface ChapterTranslationAssistantResponse {
  assistantText: string;
}

export interface ChapterTranslationEditorValidationResult {
  baseline: ChapterTranslationEditorDocument['baseline'];
  content: string;
  normalizedContent: string;
  parsedUnitCount: number;
  rawLineCount: number;
  hasLineCountChange: boolean;
  lineCountDelta: number;
  diagnostics: ChapterTranslationEditorDiagnostic[];
  updates: ChapterTranslationEditorLineUpdate[];
  canApply: boolean;
}

export interface ApplyChapterTranslationEditorResult {
  validation: ChapterTranslationEditorValidationResult;
  appliedUpdateCount: number;
}

export interface ProjectResourceVersions {
  dictionaryRevision: number;
  chaptersRevision: number;
  topologyRevision: number;
  workspaceConfigRevision: number;
  repetitionPatternsRevision: number;
}

type TranslationExecutionRuntime = {
  processor: TranslationProcessor;
  maxConcurrentWorkItems: number;
  close: () => Promise<void>;
};

type ProofreadExecutionRuntime = {
  processor: ProofreadProcessor;
  maxConcurrentWorkItems: number;
  close: () => Promise<void>;
};

type ProjectServiceOptions = {
  createTranslationRuntime?: typeof createProcessorForProject;
  createProofreadRuntime?: typeof createProofreadProcessorForProject;
};

const DEFAULT_TRANSLATION_MAX_CONCURRENT_WORK_ITEMS = 4;

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
  private proofreadProgress: ProofreadProgress | null = null;
  private scanTaskState: ScanDictionaryTaskState | null = null;
  private plotTaskState: PlotSummaryTaskState | null = null;
  private proofreadTaskState: ProofreadTaskState | null = null;
  private repetitionPatternConsistencyFixProgress: RepetitionPatternConsistencyFixProgress | null =
    null;
  private plotSummaryReady = false;
  private resourceVersions: ProjectResourceVersions = {
    dictionaryRevision: 0,
    chaptersRevision: 0,
    topologyRevision: 0,
    workspaceConfigRevision: 0,
    repetitionPatternsRevision: 0,
  };

  constructor(
    private readonly eventBus: EventBus,
    private readonly workspaceManager: WorkspaceManager,
    private readonly requestHistoryService: RequestHistoryService,
    private readonly usageStatsService: UsageStatsService,
    private readonly options: ProjectServiceOptions = {},
  ) {}

  // ─── Queries ────────────────────────────────────────

  getStatus(): ProjectStatus {
    return {
      hasProject: this.project !== null,
      isBusy: this.isBusy,
      plotSummaryReady: this.plotSummaryReady,
      plotSummaryProgress: this.plotSummaryProgress,
      scanDictionaryProgress: this.scanDictionaryProgress,
      proofreadProgress: this.proofreadProgress,
      snapshot: this.snapshot,
    };
  }

  getSnapshot(): TranslationProjectProgressSnapshot | null {
    return this.snapshot;
  }

  getSnapshotWithEntries(): TranslationProjectSnapshot | null {
    if (!this.project) {
      return null;
    }
    return this.project.getProjectSnapshot();
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

  getChapterTranslationEditorDocument(
    chapterId: number,
    format: EditableTranslationFormat,
  ): ChapterTranslationEditorDocument | null {
    if (!this.project?.getChapterDescriptor(chapterId)) {
      return null;
    }
    return this.project.getChapterTranslationEditorDocument(chapterId, format);
  }

  validateChapterTranslationEditorContent(input: {
    chapterId: number;
    format: EditableTranslationFormat;
    content: string;
  }): ChapterTranslationEditorValidationResult {
    if (!this.project) {
      throw new ProjectServiceUserInputError('当前没有已初始化的项目');
    }
    return this.project.validateChapterTranslationEditorContent(
      input.chapterId,
      input.format,
      input.content,
    );
  }

  async applyChapterTranslationEditorContent(input: {
    chapterId: number;
    format: EditableTranslationFormat;
    content: string;
  }): Promise<ApplyChapterTranslationEditorResult> {
    if (this.isBusy) {
      throw new ProjectServiceUserInputError('正在执行其他操作，请稍候');
    }
    if (!this.project) {
      throw new ProjectServiceUserInputError('当前没有已初始化的项目');
    }

    this.isBusy = true;
    try {
      const validation = await this.project.applyChapterTranslationEditorContent(
        input.chapterId,
        input.format,
        input.content,
      );
      const appliedUpdateCount = validation.updates.filter((update) => update.changed).length;
      if (validation.canApply) {
        this.refreshSnapshot();
        this.markChaptersChanged();
      }
      return {
        validation,
        appliedUpdateCount: validation.canApply ? appliedUpdateCount : 0,
      };
    } finally {
      this.isBusy = false;
    }
  }

  getRepeatedPatterns(options: { chapterIds?: number[] } = {}): SavedRepetitionPatternAnalysisResult | null {
    return this.project?.getSavedRepeatedPatterns(options) ?? null;
  }

  async scanRepeatedPatterns(
    options: RepetitionPatternAnalysisOptions = {},
  ): Promise<SavedRepetitionPatternAnalysisResult> {
    if (this.isBusy) {
      throw new ProjectServiceUserInputError('正在执行其他操作，请稍候');
    }
    if (!this.project) {
      throw new ProjectServiceUserInputError('当前没有已初始化的项目');
    }

    this.isBusy = true;
    this.log('info', '正在扫描并保存重复 Pattern...');
    try {
      const result = await this.project.scanAndSaveRepeatedPatterns(options);
      this.markRepeatedPatternsChanged();
      this.log('success', `重复 Pattern 已保存（${result.patterns.length} 个 Pattern）`);
      return result;
    } finally {
      this.isBusy = false;
    }
  }

  hydrateRepeatedPatterns(input: {
    chapterIds?: number[];
    patternTexts?: string[];
  }): RepetitionPatternAnalysisResult | null {
    return this.project?.hydrateSavedRepeatedPatterns(input) ?? null;
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

  async runChapterTranslationAssistant(
    input: ChapterTranslationAssistantRequest,
  ): Promise<ChapterTranslationAssistantResponse> {
    if (!this.project?.getChapterDescriptor(input.chapterId)) {
      throw new ProjectServiceUserInputError('当前没有可用的章节');
    }

    const mode = input.mode;
    if (!['question', 'modify', 'polish'].includes(mode)) {
      throw new ProjectServiceUserInputError('不支持的 AI 辅助模式');
    }

    const instruction = input.instruction.trim();
    if (!instruction) {
      throw new ProjectServiceUserInputError('请输入要发送给 AI 的内容');
    }

    if (input.selectedUnits.length === 0) {
      throw new ProjectServiceUserInputError('请先选中至少一个翻译单元');
    }

    const manager = new GlobalConfigManager();
    const llmProfileName = input.llmProfileName.trim();
    if (!llmProfileName) {
      throw new ProjectServiceUserInputError('请选择一个可用的 LLM 配置');
    }

    const llmProfile = await manager.getRequiredLlmProfile(llmProfileName);
    if (llmProfile.modelType !== 'chat') {
      throw new ProjectServiceUserInputError('所选 LLM 配置不是 chat 类型');
    }

    const runtimeConfig = new TranslationGlobalConfig({
      llm: {
        profiles: {
          assistant: llmProfile,
        },
      },
    });
    const provider = runtimeConfig.createProvider();
    provider.setHistoryLogger(
      this.createRequestHistoryLogger('chapter_editor_assistant_requests', this.project),
    );

    const promptManager = new PromptManager();
    const selectedSourceTextLength = input.selectedUnits.reduce(
      (total, unit) => total + unit.sourceText.length,
      0,
    );
    const renderedPrompt = await promptManager.renderChapterTranslationAssistantPrompt({
      mode,
      selectedUnits: input.selectedUnits.map((unit) => ({
        id: unit.id,
        sourceText: unit.sourceText,
        translatedText: unit.translatedText,
      })),
      conversationTurns: input.conversationTurns.map((turn) => ({
        role: turn.role,
        content: turn.content,
      })),
      instruction,
      glossaryHints: input.glossaryHints,
      repetitionHints: input.repetitionHints,
    });

    const chatClient = provider.getChatClient('assistant');
    const assistantText = await chatClient.singleTurnRequest(renderedPrompt.userPrompt, {
      requestConfig: {
        systemPrompt: renderedPrompt.systemPrompt,
        temperature: mode === 'question' ? 0.4 : 0.2,
        maxTokens: mode === 'question' ? 1200 : 1800,
      },
      meta: {
        label: '章节 AI 辅助',
        feature: 'chapter-editor',
        operation: mode,
        component: 'webui',
        workflow: 'assistant',
        stage: mode,
        context: {
          chapterId: input.chapterId,
          format: input.format,
          selectedUnitCount: input.selectedUnits.length,
          selectedSourceTextLength,
          llmProfileName,
        },
      },
    });

    return { assistantText: assistantText.trim() };
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
    chapterIds?: number[];
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

    const analysis = this.project.hydrateSavedRepeatedPatterns({
      chapterIds: input.chapterIds,
    });
    if (!analysis) {
      throw new ProjectServiceUserInputError('当前还没有已保存的重复 Pattern 扫描结果');
    }
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
    return this.requestHistoryService.getDigest();
  }

  async getRequestHistoryPage(options: {
    limit?: number;
    beforeId?: number;
  }): Promise<LlmRequestHistoryPage> {
    return this.requestHistoryService.getPage(options);
  }

  async getRequestHistoryDetail(id: number): Promise<LlmRequestHistoryDetail | null> {
    return this.requestHistoryService.getDetail(id);
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
        const existingConfig = await openWorkspaceConfig(normalizedDir);
        nextProject = await TranslationProject.openWorkspace(normalizedDir, {
          orderingStrategy: createWorkspaceOrderingStrategy(existingConfig.pipelineStrategy),
        });
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
            orderingStrategy: createWorkspaceOrderingStrategy(input.pipelineStrategy),
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
        pipelineStrategy: input.pipelineStrategy,
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
      await this.restoreProofreadTaskState(nextProject);
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

  async startProofread(input: {
    chapterIds: number[];
    mode?: ProofreadTaskMode;
  }): Promise<void> {
    if (this.isBusy) {
      this.log('warning', '正在执行其他操作，请稍候');
      return;
    }
    if (!this.project) {
      this.log('warning', '当前没有已初始化的项目');
      return;
    }
    if (this.proofreadTaskState?.status === 'running') {
      throw new ProjectServiceUserInputError('校对任务正在运行');
    }

    const project = this.project;
    const task = this.createProofreadTaskState(project, input.chapterIds, input.mode ?? 'linear');
    task.status = 'running';
    task.abortRequested = false;
    task.errorMessage = undefined;
    task.updatedAt = new Date().toISOString();
    this.clearTaskProgressUi('proofread');
    this.proofreadTaskState = task;
    await project.saveProofreadTaskState(task);

    this.log(
      'info',
      `校对任务开始，共 ${task.totalChapters} 个章节，${task.totalBatches} 个片段，模式：${task.mode === 'linear' ? '线性校对' : '同时校对'}`,
    );
    this.isBusy = true;
    this.syncProofreadProgress(task);
    this.broadcastProofreadProgress();
    void this.runProofreadTask(project, task);
  }

  async resumeProofread(): Promise<void> {
    if (this.isBusy) {
      this.log('warning', '正在执行其他操作，请稍候');
      return;
    }
    if (!this.project) {
      throw new ProjectServiceUserInputError('当前没有已初始化的项目');
    }

    const task = this.proofreadTaskState ?? this.project.getProofreadTaskState();
    if (!task || task.status === 'done') {
      throw new ProjectServiceUserInputError('当前没有可恢复的校对任务');
    }
    if (task.status === 'running') {
      throw new ProjectServiceUserInputError('校对任务正在运行');
    }

    task.status = 'running';
    task.abortRequested = false;
    task.errorMessage = undefined;
    task.updatedAt = new Date().toISOString();
    this.proofreadTaskState = task;
    await this.project.saveProofreadTaskState(task);

    this.log(
      'info',
      `继续校对任务，已完成 ${task.completedBatches}/${task.totalBatches} 个片段`,
    );
    this.isBusy = true;
    this.syncProofreadProgress(task);
    this.broadcastProofreadProgress();
    void this.runProofreadTask(this.project, task);
  }

  async abortProofread(): Promise<void> {
    if (this.proofreadTaskState?.status !== 'running') {
      throw new ProjectServiceUserInputError('当前没有正在运行的校对任务');
    }

    this.proofreadTaskState.abortRequested = true;
    this.proofreadTaskState.updatedAt = new Date().toISOString();
    await this.project?.saveProofreadTaskState(this.proofreadTaskState);
    this.log('warning', '已提交校对任务中止请求');
  }

  async forceAbortProofread(): Promise<void> {
    if (!this.project || this.proofreadTaskState?.status !== 'running') {
      throw new ProjectServiceUserInputError('当前没有正在运行的校对任务');
    }

    this.processingToken += 1;
    this.isBusy = false;
    this.proofreadTaskState.status = 'paused';
    this.proofreadTaskState.abortRequested = false;
    this.proofreadTaskState.currentChapterId = undefined;
    this.proofreadTaskState.errorMessage = undefined;
    this.proofreadTaskState.updatedAt = new Date().toISOString();
    await this.project.saveProofreadTaskState(this.proofreadTaskState);
    this.syncProofreadProgress(this.proofreadTaskState);
    this.broadcastProofreadProgress();
    this.log('warning', '已强行中止校对任务，当前正在处理的片段结果将被丢弃');
  }

  async removeProofreadTask(): Promise<void> {
    if (!this.project) {
      throw new ProjectServiceUserInputError('当前没有已初始化的项目');
    }

    const task = this.proofreadTaskState ?? this.project.getProofreadTaskState();
    if (!task) {
      throw new ProjectServiceUserInputError('当前没有可移除的校对任务');
    }

    if (task.status === 'running') {
      this.processingToken += 1;
      this.isBusy = false;
      this.log('warning', '已移除正在运行的校对任务，当前正在处理的片段结果将被丢弃');
    } else {
      this.log('info', '已移除校对任务');
    }

    this.proofreadTaskState = null;
    await this.project.saveProofreadTaskState(undefined);
    this.clearTaskProgressUi('proofread');
  }

  private createProofreadTaskState(
    project: TranslationProject,
    chapterIds: number[],
    mode: ProofreadTaskMode,
  ): ProofreadTaskState {
    const uniqueChapterIds = [...new Set(chapterIds)];
    if (uniqueChapterIds.length === 0) {
      throw new ProjectServiceUserInputError('请至少选择一个已翻译完成的章节来创建校对任务');
    }

    const chapterDescriptors = project.getChapterDescriptors();
    const chapterById = new Map(chapterDescriptors.map((chapter) => [chapter.id, chapter] as const));
    const invalidChapters = uniqueChapterIds.filter((chapterId) => {
      const descriptor = chapterById.get(chapterId);
      if (!descriptor) {
        return true;
      }
      return descriptor.sourceLineCount > 0 && descriptor.translatedLineCount < descriptor.sourceLineCount;
    });
    if (invalidChapters.length > 0) {
      throw new ProjectServiceUserInputError(
        `以下章节尚未翻译完成，不能创建校对任务：${invalidChapters.join(', ')}`,
      );
    }

    const orderedChapterIds = sortProofreadChapterIds(project, uniqueChapterIds, mode);
    const documentManager = project.getDocumentManager();
    const chapters = orderedChapterIds.map((chapterId) => ({
      chapterId,
      fragmentCount: documentManager.getChapterFragmentCount(chapterId),
      completedFragmentIndices: [],
    }));
    const totalBatches = chapters.reduce((sum, chapter) => sum + chapter.fragmentCount, 0);
    const now = new Date().toISOString();

    return {
      taskId: `proofread-${Date.now()}`,
      mode,
      status: 'paused',
      chapterIds: orderedChapterIds,
      chapters,
      totalChapters: chapters.length,
      completedChapters: 0,
      totalBatches,
      completedBatches: 0,
      nextChapterIndex: 0,
      nextFragmentIndex: 0,
      currentChapterId: chapters[0]?.chapterId,
      warningCount: 0,
      abortRequested: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async runProofreadTask(
    project: TranslationProject,
    task: ProofreadTaskState,
  ): Promise<void> {
    const taskToken = this.processingToken;
    let runtime: ProofreadExecutionRuntime | undefined;

    try {
      runtime = await (this.options.createProofreadRuntime ?? createProofreadProcessorForProject)(
        project,
        (level, msg) => this.log(level, msg),
        this.requestHistoryService,
      );
      const proofreadRuntime = runtime;

      const maxConcurrentWorkItems =
        task.mode === 'simultaneous'
          ? Math.max(1, Math.floor(proofreadRuntime.maxConcurrentWorkItems))
          : 1;
      const pendingWorkItems = this.buildProofreadPendingWorkItems(task);
      const activeChapterCounts = new Map<number, number>();
      let nextWorkItemIndex = 0;
      let workerFailure: unknown;
      let persistChain = Promise.resolve();

      this.syncDerivedProofreadTaskState(task);
      this.syncProofreadProgress(task);
      this.broadcastProofreadProgress();

      if (task.mode === 'simultaneous') {
        this.log(
          'info',
          `同时校对已启用，待处理 ${pendingWorkItems.length} 个片段，并发上限 ${maxConcurrentWorkItems}`,
        );
      }

      const flushTaskState = async (refreshChapters = false): Promise<void> => {
        persistChain = persistChain.then(async () => {
          task.updatedAt = new Date().toISOString();
          this.syncDerivedProofreadTaskState(task, activeChapterCounts.keys());
          await project.saveProofreadTaskState(task);
          this.syncProofreadProgress(task);
          this.broadcastProofreadProgress();
          if (refreshChapters) {
            this.refreshSnapshot();
            this.markChaptersChanged();
          }
        });
        await persistChain;
      };

      const beginActiveChapter = (chapterId: number) => {
        activeChapterCounts.set(chapterId, (activeChapterCounts.get(chapterId) ?? 0) + 1);
        this.syncDerivedProofreadTaskState(task, activeChapterCounts.keys());
        this.syncProofreadProgress(task);
        this.broadcastProofreadProgress();
      };

      const endActiveChapter = (chapterId: number) => {
        const nextCount = (activeChapterCounts.get(chapterId) ?? 0) - 1;
        if (nextCount > 0) {
          activeChapterCounts.set(chapterId, nextCount);
        } else {
          activeChapterCounts.delete(chapterId);
        }
        this.syncDerivedProofreadTaskState(task, activeChapterCounts.keys());
        this.syncProofreadProgress(task);
        this.broadcastProofreadProgress();
      };

      const takeNextWorkItem = () => {
        const workItem = pendingWorkItems[nextWorkItemIndex];
        if (!workItem) {
          return undefined;
        }
        nextWorkItemIndex += 1;
        return workItem;
      };

      const worker = async () => {
        while (taskToken === this.processingToken && !task.abortRequested && !workerFailure) {
          const workItem = takeNextWorkItem();
          if (!workItem) {
            return;
          }

          beginActiveChapter(workItem.chapterId);
          try {
            const prepared = project.buildProofreadFragmentInput(
              workItem.chapterId,
              workItem.fragmentIndex,
            );
            if (prepared.blockedReason) {
              this.appendProofreadWarning(
                task,
                `章节 ${workItem.chapterId} / 片段 ${workItem.fragmentIndex + 1} 的依赖上下文不可用（${prepared.blockedReason}），已忽略该上下文继续校对`,
              );
              await flushTaskState(false);
            }

            const result = await proofreadRuntime.processor.process({
              sourceText: prepared.sourceText,
              currentTranslationText: prepared.currentTranslationText,
              contextView: prepared.contextView,
              glossary: project.getGlossary(),
              requirements: prepared.requirements,
              documentManager: project.getDocumentManager(),
              workItemRef: {
                chapterId: workItem.chapterId,
                fragmentIndex: workItem.fragmentIndex,
                stepId: 'proofread',
              },
            });

            if (
              taskToken !== this.processingToken ||
              task.abortRequested ||
              workerFailure !== undefined
            ) {
              return;
            }

            await project.getDocumentManager().updateTranslation(
              workItem.chapterId,
              workItem.fragmentIndex,
              result.outputText,
            );
            this.markProofreadFragmentCompleted(task, workItem.chapterIndex, workItem.fragmentIndex);
            await flushTaskState(true);
          } catch (error) {
            workerFailure ??= error;
            return;
          } finally {
            endActiveChapter(workItem.chapterId);
          }
        }
      };

      const workerCount = Math.max(1, Math.min(maxConcurrentWorkItems, pendingWorkItems.length || 1));
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      await persistChain;

      if (workerFailure !== undefined) {
        throw workerFailure;
      }

      if (taskToken !== this.processingToken) {
        return;
      }

      if (task.abortRequested) {
        task.status = 'paused';
        task.errorMessage = undefined;
        task.updatedAt = new Date().toISOString();
        await project.saveProofreadTaskState(task);
        this.syncProofreadProgress(task);
        this.broadcastProofreadProgress();
        this.log(
          'warning',
          `校对任务已中止，已完成 ${task.completedBatches}/${task.totalBatches} 个片段`,
        );
        return;
      }

      this.syncDerivedProofreadTaskState(task);
      task.status = 'done';
      task.completedChapters = task.totalChapters;
      task.completedBatches = task.totalBatches;
      task.nextChapterIndex = task.totalChapters;
      task.nextFragmentIndex = 0;
      task.currentChapterId = undefined;
      task.abortRequested = false;
      task.errorMessage = undefined;
      task.updatedAt = new Date().toISOString();
      await project.saveProofreadTaskState(task);
      this.refreshSnapshot();
      this.markChaptersChanged();
      this.markRepeatedPatternsChanged();
      this.syncProofreadProgress(task);
      this.broadcastProofreadProgress();
      this.log(
        'success',
        `校对任务完成（${task.totalChapters} 章节，${task.totalBatches} 个片段）`,
      );
    } catch (error) {
      if (taskToken !== this.processingToken) {
        return;
      }

      task.status = 'error';
      task.errorMessage = toMsg(error);
      task.updatedAt = new Date().toISOString();
      await project.saveProofreadTaskState(task);
      this.syncProofreadProgress(task);
      this.broadcastProofreadProgress();
      this.log('error', `校对任务失败：${task.errorMessage}`);
    } finally {
      await runtime?.close().catch(() => undefined);
      if (taskToken === this.processingToken) {
        this.isBusy = false;
      }
    }
  }

  private appendProofreadWarning(task: ProofreadTaskState, message: string): void {
    task.warningCount += 1;
    task.lastWarningMessage = message;
    task.updatedAt = new Date().toISOString();
    this.log('warning', message);
  }

  private buildProofreadPendingWorkItems(task: ProofreadTaskState): Array<{
    chapterIndex: number;
    chapterId: number;
    fragmentIndex: number;
  }> {
    const pendingWorkItems: Array<{
      chapterIndex: number;
      chapterId: number;
      fragmentIndex: number;
    }> = [];

    for (const [chapterIndex, chapter] of task.chapters.entries()) {
      const completedFragmentIndices = new Set(chapter.completedFragmentIndices ?? []);
      for (let fragmentIndex = 0; fragmentIndex < chapter.fragmentCount; fragmentIndex += 1) {
        if (!completedFragmentIndices.has(fragmentIndex)) {
          pendingWorkItems.push({
            chapterIndex,
            chapterId: chapter.chapterId,
            fragmentIndex,
          });
        }
      }
    }

    return pendingWorkItems;
  }

  private markProofreadFragmentCompleted(
    task: ProofreadTaskState,
    chapterIndex: number,
    fragmentIndex: number,
  ): void {
    const chapter = task.chapters[chapterIndex];
    if (!chapter) {
      return;
    }

    const nextCompletedFragmentIndices = new Set(chapter.completedFragmentIndices ?? []);
    nextCompletedFragmentIndices.add(fragmentIndex);
    chapter.completedFragmentIndices = [...nextCompletedFragmentIndices].sort((left, right) => left - right);
    task.updatedAt = new Date().toISOString();
  }

  private syncDerivedProofreadTaskState(
    task: ProofreadTaskState,
    activeChapterIds?: Iterable<number>,
  ): void {
    task.totalChapters = task.chapters.length;
    task.totalBatches = task.chapters.reduce((sum, chapter) => sum + chapter.fragmentCount, 0);
    task.completedBatches = task.chapters.reduce(
      (sum, chapter) => sum + (chapter.completedFragmentIndices?.length ?? 0),
      0,
    );
    task.completedChapters = task.chapters.filter(
      (chapter) => (chapter.completedFragmentIndices?.length ?? 0) >= chapter.fragmentCount,
    ).length;

    const normalizedActiveChapterIds = [...new Set(activeChapterIds ?? [])];
    for (const [chapterIndex, chapter] of task.chapters.entries()) {
      const completedFragmentIndices = new Set(chapter.completedFragmentIndices ?? []);
      for (let fragmentIndex = 0; fragmentIndex < chapter.fragmentCount; fragmentIndex += 1) {
        if (!completedFragmentIndices.has(fragmentIndex)) {
          task.nextChapterIndex = chapterIndex;
          task.nextFragmentIndex = fragmentIndex;
          task.currentChapterId = normalizedActiveChapterIds[0] ?? chapter.chapterId;
          return;
        }
      }
    }

    task.nextChapterIndex = task.chapters.length;
    task.nextFragmentIndex = 0;
    task.currentChapterId = normalizedActiveChapterIds[0];
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
    if (this.scanTaskState?.status === 'running') {
      throw new ProjectServiceUserInputError('术语扫描任务正在运行');
    }

    const project = this.project;
    const { scanner, extractorConfig } = await this.createGlossaryScanner(project);
    const isFreshRun = !this.scanTaskState || this.scanTaskState.status === 'done';

    if (isFreshRun) {
      this.clearTaskProgressUi('scan');
      this.scanTaskState = this.createGlossaryScanTask(project, scanner, extractorConfig);
      this.scanTaskState.status = 'running';
    } else {
      this.scanTaskState!.requestOptions = extractorConfig.requestOptions;
      this.scanTaskState!.maxCharsPerBatch = extractorConfig.maxCharsPerBatch;
      this.scanTaskState!.occurrenceTopK = extractorConfig.occurrenceTopK;
      this.scanTaskState!.occurrenceTopP = extractorConfig.occurrenceTopP;
      this.scanTaskState!.abortRequested = false;
      this.scanTaskState!.errorMessage = undefined;
      this.scanTaskState!.status = 'running';
    }

    const task = this.scanTaskState!;
    this.log(
      'info',
      isFreshRun
        ? `术语扫描开始，共 ${task.totalLines} 行，分 ${task.totalBatches} 个批次`
        : `继续术语扫描，已完成 ${task.completedBatches}/${task.totalBatches} 个批次`,
    );
    this.isBusy = true;
    this.syncScanDictionaryProgress(task);
    this.broadcastScanProgress();
    void this.runGlossaryScanTask(project, scanner, task);
  }

  async resumeGlossaryScan(): Promise<void> {
    await this.scanDictionary();
  }

  async abortGlossaryScan(): Promise<void> {
    if (this.scanTaskState?.status !== 'running') {
      throw new ProjectServiceUserInputError('当前没有正在运行的术语扫描任务');
    }

    this.scanTaskState.abortRequested = true;
    this.log('warning', '已提交术语扫描中止请求');
  }

  private createGlossaryScanTask(
    project: TranslationProject,
    scanner: FullTextGlossaryScanner,
    extractorConfig: {
      maxCharsPerBatch?: number;
      occurrenceTopK?: number;
      occurrenceTopP?: number;
      requestOptions?: ChatRequestOptions;
    },
  ): ScanDictionaryTaskState {
    const lines = scanner.collectLinesFromDocumentManager(project.getDocumentManager());
    const batches = scanner.buildBatches(lines, {
      maxCharsPerBatch: extractorConfig.maxCharsPerBatch,
    });
    return {
      status: 'paused',
      totalLines: lines.length,
      totalBatches: batches.length,
      completedBatches: 0,
      nextBatchIndex: 0,
      lines,
      batches,
      glossary: new Glossary(project.getGlossary()?.getAllTerms() ?? []),
      requestOptions: extractorConfig.requestOptions,
      maxCharsPerBatch: extractorConfig.maxCharsPerBatch,
      occurrenceTopK: extractorConfig.occurrenceTopK,
      occurrenceTopP: extractorConfig.occurrenceTopP,
      abortRequested: false,
    };
  }

  private async createGlossaryScanner(project: TranslationProject): Promise<{
    scanner: FullTextGlossaryScanner;
    extractorConfig: {
      maxCharsPerBatch?: number;
      occurrenceTopK?: number;
      occurrenceTopP?: number;
      requestOptions?: ChatRequestOptions;
    };
  }> {
    const manager = new GlobalConfigManager();
    const globalConfig = await manager.getTranslationGlobalConfig();
    const extractorConfig = globalConfig.getGlossaryExtractorConfig();
    if (!extractorConfig || extractorConfig.modelNames.length === 0) {
      throw new Error('未配置术语提取 LLM，请先设置术语提取模型');
    }

    const provider = new TranslationGlobalConfig({
      llm: globalConfig.llm,
    }).createProvider();
    provider.setHistoryLogger(
      this.createRequestHistoryLogger('glossary_scan_requests', project),
    );

    return {
      scanner: new FullTextGlossaryScanner(
        provider.getChatClientWithFallback(extractorConfig.modelNames),
        this.createLogger(),
      ),
      extractorConfig: {
        maxCharsPerBatch: extractorConfig.maxCharsPerBatch,
        occurrenceTopK: extractorConfig.occurrenceTopK,
        occurrenceTopP: extractorConfig.occurrenceTopP,
        requestOptions: extractorConfig.requestOptions,
      },
    };
  }

  private async runGlossaryScanTask(
    project: TranslationProject,
    scanner: FullTextGlossaryScanner,
    task: ScanDictionaryTaskState,
  ): Promise<void> {
    const taskToken = this.processingToken;

    try {
      while (task.nextBatchIndex < task.batches.length) {
        if (taskToken !== this.processingToken) {
          return;
        }
        if (task.abortRequested) {
          break;
        }

        const batch = task.batches[task.nextBatchIndex]!;
        const extractedEntities = await scanner.scanBatch(batch, {
          requestOptions: task.requestOptions,
        });

        if (taskToken !== this.processingToken) {
          return;
        }

        for (const entity of extractedEntities) {
          const existing = task.glossary.getTerm(entity.term);
          task.glossary.addTerm(this.mergeScannedGlossaryTerm(existing, entity));
        }

        task.completedBatches = batch.batchIndex + 1;
        task.nextBatchIndex = batch.batchIndex + 1;
        this.syncScanDictionaryProgress(task);
        this.broadcastScanProgress();
        this.log(
          'info',
          `术语扫描批次 ${task.completedBatches}/${task.totalBatches} 完成`,
        );
      }

      if (taskToken !== this.processingToken) {
        return;
      }

      if (task.abortRequested) {
        task.status = 'paused';
        task.errorMessage = undefined;
        this.syncScanDictionaryProgress(task);
        this.broadcastScanProgress();
        this.log(
          'warning',
          `术语扫描已中止，已完成 ${task.completedBatches}/${task.totalBatches} 个批次`,
        );
        return;
      }

      task.glossary.updateOccurrenceStats(
        task.lines.map((line) => ({
          blockId: line.blockId,
          text: line.text,
        })),
      );

      const filteredTerms = task.glossary
        .getAllTerms()
        .filter(
          (term) => term.totalOccurrenceCount > 0 && term.textBlockOccurrenceCount > 1,
        )
        .sort((left, right) => this.compareScannedGlossaryTerms(left, right));
      const retainedTerms = this.applyOccurrenceRankingFilters(filteredTerms, {
        occurrenceTopK: task.occurrenceTopK,
        occurrenceTopP: task.occurrenceTopP,
      });
      const retainedTermSet = new Set(retainedTerms.map((term) => term.term));
      for (const term of task.glossary.getAllTerms()) {
        if (!retainedTermSet.has(term.term)) {
          task.glossary.removeTerm(term.term);
        }
      }

      project.replaceGlossary(task.glossary);
      if ("bumpGlossaryDependencyRevision" in project) {
        await project.bumpGlossaryDependencyRevision();
      }
      await project.saveProgress();
      this.refreshSnapshot();
      this.markDictionaryChanged();

      task.status = 'done';
      task.errorMessage = undefined;
      task.completedBatches = task.totalBatches;
      task.nextBatchIndex = task.totalBatches;
      this.syncScanDictionaryProgress(task);
      this.broadcastScanProgress();
      this.log(
        'success',
        `术语提取完成，共 ${task.glossary.getAllTerms().length} 个条目`,
      );
    } catch (error) {
      if (taskToken !== this.processingToken) {
        return;
      }

      task.status = 'error';
      task.errorMessage = toMsg(error);
      this.syncScanDictionaryProgress(task);
      this.broadcastScanProgress();
      this.log('error', `扫描字典失败：${task.errorMessage}`);
    } finally {
      if (taskToken === this.processingToken) {
        this.isBusy = false;
      }
    }
  }

  private syncScanDictionaryProgress(task: ScanDictionaryTaskState): void {
    this.scanDictionaryProgress = {
      status: task.status,
      totalBatches: task.totalBatches,
      completedBatches: task.completedBatches,
      totalLines: task.totalLines,
      currentBatchIndex:
        task.nextBatchIndex > 0 && task.nextBatchIndex < task.totalBatches
          ? task.nextBatchIndex + 1
          : undefined,
      errorMessage: task.errorMessage,
    };
  }

  private mergeScannedGlossaryTerm(
    existing: ReturnType<Glossary['getAllTerms']>[number] | undefined,
    scanned: { term: string; category?: GlossaryTermCategory },
  ): GlossaryTerm {
    if (!existing) {
      return {
        term: scanned.term,
        translation: '',
        category: scanned.category,
      };
    }

    return {
      term: existing.term,
      translation: existing.translation,
      category: existing.category ?? scanned.category,
      totalOccurrenceCount: existing.totalOccurrenceCount,
      textBlockOccurrenceCount: existing.textBlockOccurrenceCount,
      description: existing.description,
    };
  }

  private compareScannedGlossaryTerms(
    left: {
      totalOccurrenceCount: number;
      textBlockOccurrenceCount: number;
      term: string;
    },
    right: {
      totalOccurrenceCount: number;
      textBlockOccurrenceCount: number;
      term: string;
    },
  ): number {
    return (
      right.textBlockOccurrenceCount - left.textBlockOccurrenceCount ||
      right.totalOccurrenceCount - left.totalOccurrenceCount ||
      left.term.localeCompare(right.term)
    );
  }

  private applyOccurrenceRankingFilters<T extends {
    totalOccurrenceCount: number;
    textBlockOccurrenceCount: number;
    term: string;
  }>(
    terms: ReadonlyArray<T>,
    options: { occurrenceTopK?: number; occurrenceTopP?: number },
  ): T[] {
    if (terms.length === 0) {
      this.validateOccurrenceRankingOptions(options);
      return [];
    }

    this.validateOccurrenceRankingOptions(options);

    let retainCount = terms.length;
    if (options.occurrenceTopK !== undefined) {
      retainCount = Math.min(retainCount, options.occurrenceTopK);
    }
    if (options.occurrenceTopP !== undefined) {
      retainCount = Math.min(retainCount, Math.ceil(terms.length * options.occurrenceTopP));
    }

    return terms.slice(0, retainCount);
  }

  private validateOccurrenceRankingOptions(options: {
    occurrenceTopK?: number;
    occurrenceTopP?: number;
  }): void {
    const { occurrenceTopK, occurrenceTopP } = options;
    if (
      occurrenceTopK !== undefined &&
      (!Number.isInteger(occurrenceTopK) || occurrenceTopK <= 0)
    ) {
      throw new Error('occurrenceTopK 必须是正整数');
    }
    if (
      occurrenceTopP !== undefined &&
      (typeof occurrenceTopP !== 'number' ||
        !Number.isFinite(occurrenceTopP) ||
        occurrenceTopP <= 0 ||
        occurrenceTopP > 1)
    ) {
      throw new Error('occurrenceTopP 必须在 (0, 1] 范围内');
    }
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
      if ("bumpGlossaryDependencyRevision" in this.project) {
        await this.project.bumpGlossaryDependencyRevision();
      }
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
      if ("bumpGlossaryDependencyRevision" in this.project) {
        await this.project.bumpGlossaryDependencyRevision();
      }
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
      if ("bumpGlossaryDependencyRevision" in this.project) {
        await this.project.bumpGlossaryDependencyRevision();
      }
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
    if (this.plotTaskState?.status === 'running') {
      throw new ProjectServiceUserInputError('情节总结任务正在运行');
    }

    const project = this.project;
    const { summarizer, plotConfig, chapters, totalBatches } =
      await this.createPlotSummaryRuntime(project);
    const isFreshRun = !this.plotTaskState || this.plotTaskState.status === 'done';

    if (isFreshRun) {
      this.clearTaskProgressUi('plot');
      this.plotTaskState = this.createPlotSummaryTaskState({
        project,
        plotConfig,
        chapters,
        totalBatches,
      });
      this.plotTaskState.status = 'running';
    } else {
      this.plotTaskState!.requestOptions = plotConfig.requestOptions;
      this.plotTaskState!.fragmentsPerBatch = plotConfig.fragmentsPerBatch ?? 5;
      this.plotTaskState!.maxContextSummaries = plotConfig.maxContextSummaries ?? 20;
      this.plotTaskState!.abortRequested = false;
      this.plotTaskState!.errorMessage = undefined;
      this.plotTaskState!.status = 'running';
    }

    const task = this.plotTaskState!;
    this.log(
      'info',
      isFreshRun
        ? `情节总结开始，共 ${task.totalChapters} 个章节，${task.totalBatches} 个批次`
        : `继续情节总结，已完成 ${task.completedBatches}/${task.totalBatches} 个批次`,
    );
    this.isBusy = true;
    this.syncPlotSummaryProgress(task);
    this.broadcastPlotProgress();
    void this.runPlotSummaryTask(project, summarizer, task);
  }

  async resumePlotSummary(): Promise<void> {
    await this.startPlotSummary();
  }

  async abortPlotSummary(): Promise<void> {
    if (this.plotTaskState?.status !== 'running') {
      throw new ProjectServiceUserInputError('当前没有正在运行的情节总结任务');
    }

    this.plotTaskState.abortRequested = true;
    this.log('warning', '已提交情节总结中止请求');
  }

  private async createPlotSummaryRuntime(project: TranslationProject): Promise<{
    summarizer: PlotSummarizer;
    plotConfig: {
      fragmentsPerBatch?: number;
      maxContextSummaries?: number;
      requestOptions?: ChatRequestOptions;
    };
    chapters: Array<{ chapterId: number; fragmentCount: number }>;
    totalBatches: number;
  }> {
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
    provider.setHistoryLogger(
      this.createRequestHistoryLogger('plot_summary_requests', project),
    );

    const projectDir = project.getWorkspaceFileManifest().projectDir;
    const summaryPath = join(projectDir, 'Data', 'plot-summaries.json');
    const topology = project.getStoryTopology();

    const summarizer = new PlotSummarizer(
      provider.getChatClientWithFallback(plotConfig.modelNames),
      documentManager,
      summaryPath,
      {
        fragmentsPerBatch: plotConfig.fragmentsPerBatch,
        maxContextSummaries: plotConfig.maxContextSummaries,
        requestOptions: plotConfig.requestOptions,
        logger: this.createLogger(),
        topology,
      },
    );
    await summarizer.loadSummaries();

    const chapters = documentManager
      .getAllChapters()
      .map((chapter) => ({
        chapterId: chapter.id,
        fragmentCount: chapter.fragments.length,
      }));
    const fragmentsPerBatch = plotConfig.fragmentsPerBatch ?? 5;
    let totalBatches = 0;
    for (const chapter of chapters) {
      totalBatches += Math.ceil(chapter.fragmentCount / fragmentsPerBatch);
    }

    return {
      summarizer,
      plotConfig: {
        fragmentsPerBatch: plotConfig.fragmentsPerBatch,
        maxContextSummaries: plotConfig.maxContextSummaries,
        requestOptions: plotConfig.requestOptions,
      },
      chapters,
      totalBatches,
    };
  }

  private createPlotSummaryTaskState(input: {
    project: TranslationProject;
    plotConfig: {
      fragmentsPerBatch?: number;
      maxContextSummaries?: number;
      requestOptions?: ChatRequestOptions;
    };
    chapters: Array<{ chapterId: number; fragmentCount: number }>;
    totalBatches: number;
  }): PlotSummaryTaskState {
    return {
      status: 'paused',
      totalChapters: input.chapters.length,
      completedChapters: 0,
      totalBatches: input.totalBatches,
      completedBatches: 0,
      nextChapterIndex: 0,
      nextFragmentIndex: 0,
      chapters: input.chapters,
      requestOptions: input.plotConfig.requestOptions,
      fragmentsPerBatch: input.plotConfig.fragmentsPerBatch ?? 5,
      maxContextSummaries: input.plotConfig.maxContextSummaries ?? 20,
      summaryPath: join(input.project.getWorkspaceFileManifest().projectDir, 'Data', 'plot-summaries.json'),
      abortRequested: false,
    };
  }

  private async runPlotSummaryTask(
    project: TranslationProject,
    summarizer: PlotSummarizer,
    task: PlotSummaryTaskState,
  ): Promise<void> {
    const taskToken = this.processingToken;

    try {
      for (let chapterIndex = task.nextChapterIndex; chapterIndex < task.chapters.length; chapterIndex += 1) {
        if (taskToken !== this.processingToken) {
          return;
        }
        if (task.abortRequested) {
          break;
        }

        const chapterMeta = task.chapters[chapterIndex]!;
        const chapter = project.getDocumentManager().getChapterById(chapterMeta.chapterId);
        if (!chapter) {
          throw new Error(`章节不存在: ${chapterMeta.chapterId}`);
        }

        this.log(
          'info',
          `开始总结章节 ${chapter.id}（${chapter.fragments.length} 个文本块）`,
        );
        const startFragmentIndex =
          chapterIndex === task.nextChapterIndex ? task.nextFragmentIndex : 0;
        task.nextChapterIndex = chapterIndex;
        task.nextFragmentIndex = startFragmentIndex;
        this.syncPlotSummaryProgress(task, chapter.id);
        this.broadcastPlotProgress();

        let fragmentIndex = startFragmentIndex;
        while (fragmentIndex < chapter.fragments.length) {
          if (taskToken !== this.processingToken) {
            return;
          }
          if (task.abortRequested) {
            break;
          }

          const count = Math.min(task.fragmentsPerBatch, chapter.fragments.length - fragmentIndex);
          await summarizer.summarizeFragments(chapter.id, fragmentIndex, count, {
            requestOptions: task.requestOptions,
          });
          fragmentIndex += count;
          task.completedBatches += 1;
          task.nextChapterIndex = chapterIndex;
          task.nextFragmentIndex = fragmentIndex;
          this.syncPlotSummaryProgress(task, chapter.id);
          this.broadcastPlotProgress();
        }

        if (task.abortRequested) {
          break;
        }

        task.completedChapters += 1;
        task.completedBatches = Math.min(task.completedBatches, task.totalBatches);
        task.nextChapterIndex = chapterIndex + 1;
        task.nextFragmentIndex = 0;
        this.syncPlotSummaryProgress(task, chapter.id);
        this.broadcastPlotProgress();
        this.log('success', `章节 ${chapter.id} 总结完成`);
      }

      if (taskToken !== this.processingToken) {
        return;
      }

      if (task.abortRequested) {
        task.status = 'paused';
        task.errorMessage = undefined;
        this.syncPlotSummaryProgress(task);
        this.broadcastPlotProgress();
        this.log(
          'warning',
          `情节总结已中止，已完成 ${task.completedBatches}/${task.totalBatches} 个批次`,
        );
        return;
      }

      task.status = 'done';
      task.errorMessage = undefined;
      task.completedChapters = task.totalChapters;
      task.completedBatches = task.totalBatches;
      task.nextChapterIndex = task.totalChapters;
      task.nextFragmentIndex = 0;
      this.syncPlotSummaryProgress(task);
      this.broadcastPlotProgress();
      await project.reloadNarrativeArtifacts();
      this.topology = project.getStoryTopology() ?? null;
      this.plotSummaryReady = project.hasPlotSummaries();
      this.log(
        'success',
        `情节大纲完成（${task.totalChapters} 章节，${task.completedBatches} 批）`,
      );
    } catch (error) {
      if (taskToken !== this.processingToken) {
        return;
      }

      task.status = 'error';
      task.errorMessage = toMsg(error);
      this.syncPlotSummaryProgress(task);
      this.broadcastPlotProgress();
      this.log('error', `情节总结失败：${task.errorMessage}`);
    } finally {
      if (taskToken === this.processingToken) {
        this.isBusy = false;
      }
    }
  }

  private syncPlotSummaryProgress(task: PlotSummaryTaskState, currentChapterId?: number): void {
    const resolvedCurrentChapterId =
      currentChapterId ?? task.chapters[task.nextChapterIndex]?.chapterId;
    this.plotSummaryProgress = {
      status: task.status,
      totalChapters: task.totalChapters,
      completedChapters: task.completedChapters,
      totalBatches: task.totalBatches,
      completedBatches: task.completedBatches,
      currentChapterId: resolvedCurrentChapterId,
      errorMessage: task.errorMessage,
    };
  }

  private syncProofreadProgress(task: ProofreadTaskState): void {
    this.proofreadProgress = {
      status: task.status,
      mode: task.mode,
      totalChapters: task.totalChapters,
      completedChapters: task.completedChapters,
      totalBatches: task.totalBatches,
      completedBatches: task.completedBatches,
      currentChapterId: task.currentChapterId,
      chapterIds: [...task.chapterIds],
      warningCount: task.warningCount,
      lastWarningMessage: task.lastWarningMessage,
      errorMessage: task.errorMessage,
    };
  }

  clearTaskProgressUi(task: 'scan' | 'plot' | 'proofread' | 'all' = 'all'): void {
    if (task === 'scan' || task === 'all') {
      this.scanDictionaryProgress = null;
      this.broadcastScanProgress();
    }
    if (task === 'plot' || task === 'all') {
      this.plotSummaryProgress = null;
      this.broadcastPlotProgress();
    }
    if (task === 'proofread' || task === 'all') {
      this.proofreadProgress = null;
      this.broadcastProofreadProgress();
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
      this.markRepeatedPatternsChanged();
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
      this.markRepeatedPatternsChanged();

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
      this.markRepeatedPatternsChanged();
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
      this.markRepeatedPatternsChanged();
      this.log('success', `已批量移除 ${chapterIds.length} 个章节`);
    });
  }

  async reorderChapters(chapterIds: number[]): Promise<void> {
    await this.runAction('保存章节排序', async () => {
      if (!this.project) throw new Error('当前没有已初始化的项目');
      await this.project.reorderChapters(chapterIds);
      this.markChaptersChanged();
      this.markTopologyChanged();
      this.markRepeatedPatternsChanged();
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
      this.markRepeatedPatternsChanged();
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
      this.markRepeatedPatternsChanged();
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
      this.markRepeatedPatternsChanged();
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
      this.markRepeatedPatternsChanged();
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
      this.markRepeatedPatternsChanged();
    });
  }

  // ─── Config ─────────────────────────────────────────

  async updateWorkspaceConfig(patch: WorkspaceConfigPatch): Promise<void> {
    if (this.isBusy) {
      throw new ProjectServiceUserInputError('正在执行其他操作，请稍候');
    }
    if (!this.project) {
      throw new ProjectServiceUserInputError('当前没有已初始化的项目');
    }

    this.isBusy = true;
    this.log('info', '保存工作区配置...');
    try {
      const currentProject = this.project;
      const currentConfig = currentProject.getWorkspaceConfig();
      const previousPipelineStrategy = resolveWorkspacePipelineStrategy(
        currentConfig.pipelineStrategy,
      );
      const nextPipelineStrategy = resolveWorkspacePipelineStrategy(
        patch.pipelineStrategy ?? currentConfig.pipelineStrategy,
      );

      if (
        previousPipelineStrategy !== nextPipelineStrategy &&
        ['running', 'stopping'].includes(currentProject.getLifecycleSnapshot().status)
      ) {
        throw new ProjectServiceUserInputError('请先暂停或中止翻译，再切换工作流');
      }

      await this.project.updateWorkspaceConfig(patch);

      if (previousPipelineStrategy !== nextPipelineStrategy) {
        await clearWorkspaceSupportData(this.project);
        this.project = await reopenProjectWithStrategy(
          this.project.getWorkspaceFileManifest().projectDir,
          nextPipelineStrategy,
        );
        this.topology = this.project.getStoryTopology() ?? null;
        this.plotSummaryReady = this.project.hasPlotSummaries();
        this.log('warning', '工作流已切换，已清除相关支持数据，请重新构建后再启动翻译');
      }

      this.refreshSnapshot();
      this.markWorkspaceConfigChanged();
      this.log('success', '工作区配置已保存');
    } catch (error) {
      this.log('error', `保存工作区配置失败：${toMsg(error)}`);
      throw error;
    } finally {
      this.isBusy = false;
    }
  }

  async buildContextNetwork(input: {
    vectorStoreType: ContextNetworkVectorStoreType;
    minEdgeStrength?: number;
  }): Promise<ContextNetworkBuildResult> {
    if (this.isBusy) {
      throw new ProjectServiceUserInputError('正在执行其他操作，请稍候');
    }
    if (!this.project) {
      throw new ProjectServiceUserInputError('当前没有已初始化的项目');
    }

    const project = this.project;
    const workspaceConfig = project.getWorkspaceConfig();
    if (resolveWorkspacePipelineStrategy(workspaceConfig.pipelineStrategy) !== 'context-network') {
      throw new ProjectServiceUserInputError('当前工作区未启用上下文网络工作流');
    }

    this.isBusy = true;
    this.log('info', '开始构建上下文网络...');

    const minEdgeStrength = input.minEdgeStrength ?? 0.5;
    if (!(minEdgeStrength > 0)) {
      this.isBusy = false;
      throw new ProjectServiceUserInputError('最小连接强度阈值必须是正数');
    }

    let provider: ReturnType<TranslationGlobalConfig['createProvider']> | undefined;
    try {
      const globalConfigManager = new GlobalConfigManager();
      const globalConfig = await globalConfigManager.getTranslationGlobalConfig();
      if (!globalConfig.getEmbeddingConfig()) {
        throw new ProjectServiceUserInputError('请先在设置中配置全局 Embedding 模型');
      }

      provider = globalConfig.createProvider();
      provider.setHistoryLogger(this.createRequestHistoryLogger('context_network_requests', project));

      const blocks = collectSourceTextBlocks(
        project.getDocumentManager(),
        workspaceConfig.chapters,
      );
      if (blocks.length === 0) {
        throw new ProjectServiceUserInputError('当前工作区没有可用于构建上下文网络的文本块');
      }

      const chunks = collectSourceTextTinyChunks(
        project.getDocumentManager(),
        workspaceConfig.chapters,
      );
      if (chunks.length === 0) {
        throw new ProjectServiceUserInputError('当前工作区没有可用于构建上下文网络的文本块');
      }

      this.log('info', `正在生成 Tiny Chunk 向量（${chunks.length} 个 chunk，来自 ${blocks.length} 个文本块）...`);
      const embeddings = await provider
        .getEmbeddingClient(GLOBAL_EMBEDDING_CLIENT_NAME)
        .getEmbeddings(chunks.map((chunk) => chunk.text));

      const vectorStoreConfig = await resolveContextNetworkVectorStoreConfig(
        globalConfigManager,
        project.getWorkspaceFileManifest().projectDir,
        input.vectorStoreType,
      );

      this.log('info', '正在计算上下文网络连接...');
      const graph = await computeChunkLinkGraph(
        {
          vectorStoreConfig,
          embeddings,
          blockSize: 1,
          tempCollectionName: `context-network-${Date.now()}`,
        },
        { logger: this.createLogger() },
      );

      const network = buildContextNetworkDataFromTinyChunkGraph({
        sourceRevision: workspaceConfig.dependencyTracking?.sourceRevision ?? 0,
        fragmentCount: blocks.length,
        chunkToFragmentIndices: chunks.map((chunk) => chunk.fragmentGlobalIndex),
        graph,
        minEdgeStrength,
      });

      await project.clearContextNetwork();
      await project.saveContextNetwork(network);

      const result: ContextNetworkBuildResult = {
        vectorStoreType: input.vectorStoreType,
        fragmentCount: network.manifest.fragmentCount,
        edgeCount: network.manifest.edgeCount,
        minEdgeStrength,
      };
      this.log(
        'success',
        `上下文网络构建完成：${result.fragmentCount} 个文本块，${result.edgeCount} 条边，最小连接强度阈值 ${result.minEdgeStrength}`,
      );
      return result;
    } catch (error) {
      this.log('error', `构建上下文网络失败：${toMsg(error)}`);
      throw error;
    } finally {
      this.isBusy = false;
      await provider?.closeAll();
    }
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
    this.proofreadProgress = null;
    this.scanTaskState = null;
    this.plotTaskState = null;
    this.proofreadTaskState = null;
    this.isBusy = false;
    this.resetResourceVersions(0);
  }

  private async restoreProofreadTaskState(project: TranslationProject): Promise<void> {
    const persistedTask = project.getProofreadTaskState();
    if (!persistedTask) {
      this.proofreadTaskState = null;
      this.proofreadProgress = null;
      return;
    }

    if (persistedTask.status === 'running') {
      persistedTask.status = 'paused';
      persistedTask.abortRequested = false;
      persistedTask.updatedAt = new Date().toISOString();
      await project.saveProofreadTaskState(persistedTask);
      this.log('warning', '检测到未完成的校对任务，已自动标记为暂停，可在 WebUI 中继续执行');
    }

    this.proofreadTaskState = persistedTask;
    this.syncProofreadProgress(persistedTask);
    this.broadcastProofreadProgress();
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
    const startedAt = Date.now();
    const progressSnapshot = this.project.getProgressSnapshot();
    const lifecycleSnapshot = this.project.getLifecycleSnapshot();
    const glossaryProgress = this.project.getGlossaryProgress();
    const pipeline = this.project.getPipeline();
    this.fullSnapshot = null;
    this.snapshot = {
      projectName: this.project.getWorkspaceConfig().projectName,
      currentCursor: this.project.getCurrentCursor(),
      lifecycle: lifecycleSnapshot,
      progress: progressSnapshot,
      glossary: glossaryProgress,
      pipeline: {
        stepCount: pipeline.steps.length,
        finalStepId: pipeline.finalStepId,
        steps: pipeline.steps.map((step) => ({
          id: step.id,
          description: step.description,
          isFinalStep: step.id === pipeline.finalStepId,
        })),
      },
      queueSnapshots: pipeline.steps.map((step) => ({
        stepId: step.id,
        description: step.description,
        isFinalStep: step.id === pipeline.finalStepId,
        progress: this.project!.getStepProgress(step.id),
        entries: [],
      })),
      activeWorkItems: [],
      readyWorkItems: [],
    };
    this.topology = this.project.getStoryTopology() ?? null;
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= 200) {
      this.log("warning", `刷新运行态快照耗时较高：${elapsedMs}ms`);
    }
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

  private broadcastProofreadProgress(): void {
    this.eventBus.emit({
      type: 'proofreadProgress',
      data: this.proofreadProgress,
    });
  }

  private resetResourceVersions(value: number): void {
    this.resourceVersions = {
      dictionaryRevision: value,
      chaptersRevision: value,
      topologyRevision: value,
      workspaceConfigRevision: value,
      repetitionPatternsRevision: value,
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

  private markRepeatedPatternsChanged(): void {
    this.resourceVersions.repetitionPatternsRevision += 1;
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
      provider.setHistoryLogger(
        this.createRequestHistoryLogger('consistency_fix_requests', params.project),
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
      let translationRuntime: TranslationExecutionRuntime | undefined;
      const pendingItems: TranslationWorkItem[] = [];
      const queueWaiters = new Set<() => void>();
      let activeProcessingCount = 0;
      let mutationChain = Promise.resolve();
      let dispatchScheduled = false;
      let snapshotRefreshTimer: ReturnType<typeof setTimeout> | null = null;
      let progressPersistTimer: ReturnType<typeof setTimeout> | null = null;
      let progressPersistRequested = false;
      let fatalError: unknown;

      const notifyQueueWaiters = () => {
        const waiters = [...queueWaiters];
        queueWaiters.clear();
        for (const resolve of waiters) {
          resolve();
        }
      };

      const QUEUE_WAIT_TIMEOUT_MS = 5_000;

      const waitForQueueChange = () =>
        new Promise<void>((resolve) => {
          queueWaiters.add(resolve);
          setTimeout(() => {
            if (queueWaiters.delete(resolve)) {
              resolve();
            }
          }, QUEUE_WAIT_TIMEOUT_MS);
        });

      const runSnapshotRefresh = () => {
        if (this.project !== currentProject) {
          return;
        }
        this.refreshSnapshot();
      };

      const scheduleSnapshotRefresh = (delayMs = 150) => {
        if (snapshotRefreshTimer) {
          return;
        }

        snapshotRefreshTimer = setTimeout(() => {
          snapshotRefreshTimer = null;
          try {
            runSnapshotRefresh();
          } catch (error) {
            fatalError ??= error;
            notifyQueueWaiters();
          }
        }, delayMs);
      };

      const flushSnapshotRefresh = () => {
        if (snapshotRefreshTimer) {
          clearTimeout(snapshotRefreshTimer);
          snapshotRefreshTimer = null;
        }
        runSnapshotRefresh();
      };

      const yieldToEventLoop = () => new Promise<void>(resolve => setTimeout(resolve, 0));

      const queueMutation = async (operation: () => Promise<void>): Promise<void> => {
        const next = mutationChain.then(async () => {
          await operation();
          // 每次 mutation 完成后让出事件循环，防止微任务链连续执行同步 SQLite
          // 写入而永久阻塞 HTTP 请求处理。
          await yieldToEventLoop();
        });
        mutationChain = next.then(
          () => {
            notifyQueueWaiters();
          },
          (error) => {
            fatalError ??= error;
            notifyQueueWaiters();
          },
        );
        await next;
      };

      const flushQueuedProgressPersist = async (): Promise<void> => {
        if (progressPersistTimer) {
          clearTimeout(progressPersistTimer);
          progressPersistTimer = null;
        }
        if (!progressPersistRequested || this.project !== currentProject) {
          return;
        }

        await queueMutation(async () => {
          if (!progressPersistRequested || this.project !== currentProject) {
            return;
          }
          progressPersistRequested = false;
          await currentProject.saveTranslationRuntimeProgress();
        });
      };

      const scheduleProgressPersist = (result: { outputText?: string }) => {
        if (!result.outputText) {
          return;
        }

        progressPersistRequested = true;
        if (progressPersistTimer) {
          return;
        }

        progressPersistTimer = setTimeout(() => {
          progressPersistTimer = null;
          void flushQueuedProgressPersist().catch((error) => {
            fatalError ??= error;
            notifyQueueWaiters();
          });
        }, 1000);
      };

      const dispatchMoreReadyItems = async (): Promise<void> => {
        if (this.processingToken !== token) {
          return;
        }

        const lifecycle = currentProject.getLifecycleSnapshot();
        if (
          lifecycle.status !== 'running' &&
          lifecycle.status !== 'stopping'
        ) {
          return;
        }

        try {
          pendingItems.push(...(await currentProject.dispatchReadyWorkItems()));
        } catch (error) {
          const msg = toMsg(error);
          if (msg.includes('停止中') || msg.includes('尚未启动')) {
            return;
          }
          throw error;
        }
      };

      const scheduleDispatch = async (): Promise<void> => {
        if (dispatchScheduled) {
          await mutationChain;
          return;
        }

        dispatchScheduled = true;
        await queueMutation(async () => {
          dispatchScheduled = false;
          await dispatchMoreReadyItems();
          scheduleSnapshotRefresh();
        });
      };

      const queueSuccessResult = async (
        processor: TranslationProcessor,
        item: TranslationWorkItem,
        result: Awaited<ReturnType<TranslationProcessor['processWorkItem']>>,
      ): Promise<void> => {
        await queueMutation(async () => {
          if (this.processingToken !== token) {
            return;
          }

          await currentProject.submitWorkResult({
            runId: item.runId,
            stepId: item.stepId,
            chapterId: item.chapterId,
            fragmentIndex: item.fragmentIndex,
            outputText: result.outputText,
          });
          scheduleProgressPersist(result);
          void this.usageStatsService
            .recordTranslationBlock({
              sourceText: item.inputText,
              translatedText: result.outputText,
              chapterId: item.chapterId,
              fragmentIndex: item.fragmentIndex,
              stepId: item.stepId,
              processorName: processor.constructor.name,
              workspaceContext: {
                projectName:
                  typeof (
                    currentProject as {
                      getWorkspaceConfig?: () => { projectName: string };
                    }
                  ).getWorkspaceConfig === "function"
                    ? (
                        currentProject as {
                          getWorkspaceConfig: () => { projectName: string };
                        }
                      ).getWorkspaceConfig().projectName
                    : currentProject.getProjectSnapshot().projectName,
                workspaceDir: currentProject.getWorkspaceFileManifest().projectDir,
              },
            })
            .catch((error) => {
              this.log('warning', `记录使用统计失败：${toMsg(error)}`);
            });
          await dispatchMoreReadyItems();
          scheduleSnapshotRefresh();
          this.log(
            'success',
            `完成 ${item.stepId} · Ch${item.chapterId}/F${item.fragmentIndex + 1}`,
          );
        });
      };

      const FAILURE_BACKOFF_MS = 2_000;

      const queueFailureResult = async (
        item: TranslationWorkItem,
        error: unknown,
      ): Promise<void> => {
        await queueMutation(async () => {
          if (this.processingToken !== token) {
            return;
          }

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

          // 退避：防止失败 item 立即被重调度形成快速重试循环，
          // 避免微任务链连续执行导致事件循环饥饿。
          await delay(FAILURE_BACKOFF_MS);

          await dispatchMoreReadyItems();
          scheduleSnapshotRefresh();
          this.log(
            'error',
            `处理失败 ${item.stepId} · Ch${item.chapterId}/F${item.fragmentIndex + 1}：${toMsg(error)}`,
          );
        });
      };

      const takeNextPendingItem = async (): Promise<TranslationWorkItem | undefined> => {
        while (this.processingToken === token) {
          if (fatalError) {
            throw fatalError;
          }

          const lifecycle = currentProject.getLifecycleSnapshot();
          if (
            lifecycle.status !== 'running' &&
            lifecycle.status !== 'stopping'
          ) {
            return undefined;
          }

          const pendingItem = pendingItems.shift();
          if (pendingItem) {
            return pendingItem;
          }

          await scheduleDispatch();
          if (fatalError) {
            throw fatalError;
          }

          const dispatchedItem = pendingItems.shift();
          if (dispatchedItem) {
            return dispatchedItem;
          }

          if (activeProcessingCount === 0) {
            await delay(400);
            scheduleSnapshotRefresh(0);
            continue;
          }

          await waitForQueueChange();
        }

        return undefined;
      };

      try {
        translationRuntime = await (
          this.options.createTranslationRuntime ?? createProcessorForProject
        )(
          currentProject,
          (level, msg) => this.log(level, msg),
          this.requestHistoryService,
        );
        const processor = translationRuntime.processor;
        const concurrency = Math.max(
          1,
          Math.floor(translationRuntime.maxConcurrentWorkItems),
        );
        this.log('info', '翻译处理器已就绪，开始调度队列');
        await scheduleDispatch();

        const worker = async () => {
          while (this.processingToken === token) {
            const item = await takeNextPendingItem();
            if (!item) {
              return;
            }

            activeProcessingCount += 1;
            this.log(
              'info',
              `处理 ${item.stepId} · Ch${item.chapterId}/F${item.fragmentIndex + 1}`,
            );

            // processWorkItem 的结果与 queueSuccessResult/queueFailureResult 的
            // 异常处理分离，确保 activeProcessingCount 仅在 finally 中递减一次。
            let processResult: Awaited<ReturnType<TranslationProcessor['processWorkItem']>> | undefined;
            let processError: unknown;
            try {
              processResult = await processor.processWorkItem(item, {
                glossary: currentProject.getGlossary(),
                documentManager: currentProject.getDocumentManager(),
              });
            } catch (error) {
              processError = error;
            } finally {
              activeProcessingCount -= 1;
              notifyQueueWaiters();
            }

            if (this.processingToken !== token) {
              return;
            }

            if (processError !== undefined) {
              await queueFailureResult(item, processError);
            } else {
              await queueSuccessResult(processor, item, processResult!);
            }
          }
        };

        await Promise.all(Array.from({ length: concurrency }, () => worker()));
        await mutationChain;
        await flushQueuedProgressPersist();
        flushSnapshotRefresh();
      } catch (error) {
        this.log('error', `翻译执行循环异常：${toMsg(error)}`);
        flushSnapshotRefresh();
      } finally {
        if (progressPersistTimer) {
          clearTimeout(progressPersistTimer);
          progressPersistTimer = null;
        }
        if (snapshotRefreshTimer) {
          clearTimeout(snapshotRefreshTimer);
          snapshotRefreshTimer = null;
        }
        notifyQueueWaiters();
        await translationRuntime?.close();
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

  private createRequestHistoryLogger(source: string, project: TranslationProject) {
    const manifest = project.getWorkspaceFileManifest();
    return this.requestHistoryService.createLogger(source, {
      projectName: project.getProjectSnapshot().projectName,
      workspaceDir: manifest.projectDir,
    });
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

function sortProofreadChapterIds(
  project: TranslationProject,
  chapterIds: number[],
  mode: ProofreadTaskMode,
): number[] {
  if (mode !== 'linear') {
    return [...chapterIds];
  }

  const orderByChapterId = new Map<number, number>();
  for (const [index, fragment] of project.getOrderedFragments().entries()) {
    if (!orderByChapterId.has(fragment.chapterId)) {
      orderByChapterId.set(fragment.chapterId, index);
    }
  }

  return [...chapterIds].sort(
    (left, right) =>
      (orderByChapterId.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (orderByChapterId.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
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
  prefs: {
    importFormat?: string;
    translatorName?: string;
    pipelineStrategy?: WorkspacePipelineStrategy;
  },
): Promise<void> {
  const patch: WorkspaceConfigPatch = {};
  if (prefs.importFormat) {
    patch.defaultImportFormat = prefs.importFormat;
    patch.defaultExportFormat = prefs.importFormat;
  }
  if (prefs.translatorName) {
    patch.translator = { translatorName: prefs.translatorName };
  }
  if (prefs.pipelineStrategy) {
    patch.pipelineStrategy = prefs.pipelineStrategy;
  }
  if (Object.keys(patch).length > 0) {
    await project.updateWorkspaceConfig(patch);
  }
}

function resolveWorkspacePipelineStrategy(
  strategy?: WorkspacePipelineStrategy,
): WorkspacePipelineStrategy {
  return strategy ?? DEFAULT_WORKSPACE_PIPELINE_STRATEGY;
}

function createWorkspaceOrderingStrategy(strategy?: WorkspacePipelineStrategy) {
  return resolveWorkspacePipelineStrategy(strategy) === 'context-network'
    ? new ContextNetworkOrderingStrategy()
    : new GlossaryDependencyOrderingStrategy();
}

async function reopenProjectWithStrategy(
  projectDir: string,
  strategy?: WorkspacePipelineStrategy,
): Promise<TranslationProject> {
  return TranslationProject.openWorkspace(projectDir, {
    orderingStrategy: createWorkspaceOrderingStrategy(strategy),
  });
}

async function clearWorkspaceSupportData(project: TranslationProject): Promise<void> {
  await Promise.all([
    project.clearContextNetwork(),
    project.getDocumentManager().clearTranslationDependencyGraph(),
  ]);
}

async function resolveContextNetworkVectorStoreConfig(
  manager: GlobalConfigManager,
  projectDir: string,
  vectorStoreType: ContextNetworkVectorStoreType,
) {
  if (vectorStoreType === 'registered') {
    return manager.getResolvedVectorStoreConfig();
  }

  const databasePath = join(projectDir, 'Data', 'context-network', 'sqlite-memory-build.sqlite');
  await mkdir(dirname(databasePath), { recursive: true });
  return createVectorStoreConfig({
    provider: 'sqlite-memory',
    endpoint: databasePath,
    distance: 'cosine',
  });
}

async function createProcessorForProject(
  project: TranslationProject,
  log: (
    level: 'error' | 'info' | 'warning' | 'success',
    msg: string,
  ) => void,
  requestHistoryService: RequestHistoryService,
): Promise<TranslationExecutionRuntime> {
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
  const workflow = TranslationProcessorFactory.getWorkflowMetadata(entry.type ?? 'default');

  const processorConfig: TranslationProcessorConfig = {
    workflow: entry.type,
    modelNames: entry.modelNames,
    slidingWindow: entry.slidingWindow,
    requestOptions: entry.requestOptions,
    steps: entry.steps,
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
  const manifest = project.getWorkspaceFileManifest();
  provider.setHistoryLogger(
    requestHistoryService.createLogger('translation_requests', {
      projectName: project.getProjectSnapshot().projectName,
      workspaceDir: manifest.projectDir,
    }),
  );

  const logger: Logger = {
    info: (msg: string) => log('info', msg),
    warn: (msg: string) => log('warning', msg),
    error: (msg: string) => log('error', msg),
    debug: () => {},
  };

  return {
    processor: runtimeConfig.createTranslationProcessor({
      provider,
      logger,
      promptManager: new PromptManager({
        translationPromptSet: workflow?.promptSet ?? entry.promptSet,
      }),
    }),
    maxConcurrentWorkItems: await resolveTranslatorMaxConcurrentWorkItems(
      manager,
      entry,
    ),
    close: async () => {
      await provider.closeAll();
    },
  };
}

async function createProofreadProcessorForProject(
  project: TranslationProject,
  log: (
    level: 'error' | 'info' | 'warning' | 'success',
    msg: string,
  ) => void,
  requestHistoryService: RequestHistoryService,
): Promise<ProofreadExecutionRuntime> {
  const manager = new GlobalConfigManager();
  const globalConfig = await manager.getTranslationGlobalConfig();
  const workspaceConfig = project.getWorkspaceConfig();
  const translatorName = workspaceConfig.translator?.translatorName;

  let processorConfig: TranslationProcessorConfig | undefined;
  let promptSet = 'ja-zhCN';

  try {
    processorConfig = globalConfig.getProofreadProcessorConfig();
  } catch {
    processorConfig = undefined;
  }

  if (!processorConfig) {
    if (!translatorName) {
      throw new Error('当前工作区未配置翻译器，也未配置独立校对器。');
    }

    const entry = await manager.getTranslator(translatorName);
    if (!entry) {
      throw new Error(`未找到名为 "${translatorName}" 的翻译器`);
    }

    promptSet = entry.promptSet;
    processorConfig = {
      workflow: 'proofread-multi-stage',
      modelNames: entry.modelNames,
      slidingWindow: entry.slidingWindow,
      requestOptions: entry.requestOptions,
      reviewIterations: entry.reviewIterations,
      steps: {
        editor: entry.steps?.editor ?? { modelNames: [...entry.modelNames] },
        proofreader: entry.steps?.proofreader ?? { modelNames: [...entry.modelNames] },
        reviser: entry.steps?.reviser ?? { modelNames: [...entry.modelNames] },
      },
    };
    log('warning', '未配置独立校对器，已临时复用当前翻译器的模型链执行校对流程');
  }

  const runtimeConfig = new TranslationGlobalConfig({
    llm: globalConfig.llm,
    translation: {
      proofreadProcessor: processorConfig,
      alignmentRepair: globalConfig.getAlignmentRepairConfig(),
    },
  });

  const provider = runtimeConfig.createProvider();
  const manifest = project.getWorkspaceFileManifest();
  provider.setHistoryLogger(
    requestHistoryService.createLogger('proofread_requests', {
      projectName: project.getProjectSnapshot().projectName,
      workspaceDir: manifest.projectDir,
    }),
  );

  const logger: Logger = {
    info: (msg: string) => log('info', msg),
    warn: (msg: string) => log('warning', msg),
    error: (msg: string) => log('error', msg),
    debug: () => {},
  };

  return {
    processor: runtimeConfig.createProofreadProcessor({
      provider,
      logger,
      promptManager: new PromptManager({
        translationPromptSet: promptSet,
      }),
    }),
    maxConcurrentWorkItems: await resolveTranslatorMaxConcurrentWorkItems(manager, processorConfig),
    close: async () => {
      await provider.closeAll();
    },
  };
}

async function resolveTranslatorMaxConcurrentWorkItems(
  manager: GlobalConfigManager,
  entry: {
    modelNames: string[];
    maxConcurrentWorkItems?: number;
    steps?: Record<string, { modelNames: string[] } | undefined>;
  },
): Promise<number> {
  if (typeof entry.maxConcurrentWorkItems === 'number') {
    return Math.max(1, Math.floor(entry.maxConcurrentWorkItems));
  }

  const profileNames = new Set<string>(entry.modelNames);
  for (const step of Object.values(entry.steps ?? {})) {
    for (const modelName of step?.modelNames ?? []) {
      profileNames.add(modelName);
    }
  }

  const parallelLimits = (
    await Promise.all(
      [...profileNames].map(async (profileName) => {
        const profile = await manager.getRequiredLlmProfile(profileName);
        return profile.maxParallelRequests;
      }),
    )
  ).filter((value): value is number => typeof value === 'number' && value > 0);

  if (parallelLimits.length > 0) {
    return Math.max(...parallelLimits);
  }

  return DEFAULT_TRANSLATION_MAX_CONCURRENT_WORK_ITEMS;
}

