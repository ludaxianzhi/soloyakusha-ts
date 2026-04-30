/**
 * 定义翻译项目门面，协调工作区、生命周期、Pipeline 调度与结果提交。
 *
 * @module project/translation-project
 */

import type { TranslationFileHandler, TranslationFileHandlerResolver } from "../../file-handlers/base.ts";
import { restoreBlankText } from "../../file-handlers/base.ts";
import { TranslationFileHandlerFactory } from "../../file-handlers/factory.ts";
import { Glossary, GlossaryPersisterFactory } from "../../glossary/index.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import {
  getPlotSummariesForPosition,
  loadPlotSummaryEntriesFromFile,
  type PlotSummaryEntry,
} from "../context/plot-summarizer.ts";
import { MAIN_ROUTE_ID, StoryTopology } from "../context/story-topology.ts";
import {
  buildChapterTranslationEditorUnits,
  createChapterTranslationEditorDocument,
  validateChapterTranslationEditorContent,
  type ChapterTranslationEditorDocument,
  type ChapterTranslationEditorRepetitionMatch,
  type ChapterTranslationEditorValidationResult,
  type EditableTranslationFormat,
} from "../context/chapter-translation-editor.ts";
import type {
  GlobalAssociationPatternScanOptions,
  GlobalAssociationPatternScanResult,
} from "../analysis/global-pattern-scanner.ts";
import { GlobalAssociationPatternScanner } from "../analysis/global-pattern-scanner.ts";
import {
  analyzeProjectRepeatedPatterns,
  type ScopedRepetitionPatternAnalysisOptions,
  type RepetitionPatternAnalysisResult,
} from "../analysis/project-repetition-analysis.ts";
import {
  createSavedRepetitionPatternAnalysisResult,
  hydrateSavedRepetitionPatternAnalysisResult,
  type SavedRepetitionPatternAnalysis,
  type SavedRepetitionPatternAnalysisResult,
  type SavedRepetitionPatternLocation,
  type RepetitionPatternAnalysisOptions,
} from "../analysis/repetition-pattern-analysis.ts";
import {
  TranslationPipeline,
  TranslationStepWorkQueue,
  type OrderedFragmentSnapshot,
  type PipelineDependencyResolution,
  type TranslationPipelineDefinition,
  type TranslationPipelineRuntime,
  type TranslationStepQueueEntry,
  type TranslationWorkItem,
  type TranslationWorkQueueRuntime,
  type TranslationWorkResult,
} from "./pipeline.ts";
import type { TranslationContextView } from "../context/context-view.ts";
import { TranslationDocumentManager } from "../document/translation-document-manager.ts";
import type {
  Chapter,
  FragmentEntry,
  GlossaryImportResult,
  GlossaryProgressSnapshot,
  ProofreadTaskState,
  StoryTopologyDescriptor,
  StoryTopologyRouteDescriptor,
  ProjectCursor,
  ProjectExportResult,
  ProjectProgressSnapshot,
  RouteExportResult,
  TranslationExportResult,
  TranslationImportResult,
  TranslationProjectConfig,
  TranslationProjectLifecycleSnapshot,
  TranslationProjectSnapshot,
  TranslationProjectState,
  TranslationStopMode,
  TranslationStepProgressSnapshot,
  TranslationStepQueueSnapshot,
  TranslationUnit,
  TranslationUnitParser,
  TranslationUnitSplitter,
  WorkspaceChapterDescriptor,
  WorkspaceConfig,
  WorkspaceConfigPatch,
  WorkspaceFileManifest,
} from "../types.ts";
import { createTextFragment, type TextFragment } from "../types.ts";
import {
  collectSourceTextBlocks,
  createDefaultTranslationPipelineDefinition,
  upsertGlobalPatternTerm,
} from "./default-translation-pipeline.ts";
import {
  createDefaultProjectState,
  normalizeProjectStateForPipeline,
  TranslationProjectLifecycleManager,
} from "./translation-project-lifecycle.ts";
import { TranslationProjectSnapshotBuilder } from "./translation-project-snapshot.ts";
import { DefaultTextSplitter } from "../document/translation-document-manager.ts";
import {
  buildInitialWorkspaceConfig,
  mergePersistedWorkspaceConfig,
  openWorkspaceConfig,
  resolveChapterPath,
  resolveFileHandlerFromOptions,
  TranslationProjectWorkspace,
} from "./translation-project-workspace.ts";
import { GlossaryDependencyOrderingStrategy } from "./glossary-dependency-ordering.ts";
import type { ContextNetworkData } from "../context/context-network-types.ts";
import type {
  ReadyOrderingItem,
  TranslationOrderingStrategy,
} from "./translation-ordering-strategy.ts";

export class TranslationProject
  implements TranslationPipelineRuntime, TranslationWorkQueueRuntime
{
  private readonly projectDir: string;
  private readonly chapters: Chapter[];
  private readonly documentManager: TranslationDocumentManager;
  private readonly pipeline: TranslationPipeline;
  private readonly queueCache = new Map<string, TranslationStepWorkQueue>();
  private readonly nextQueueSequenceByStep = new Map<string, number>();
  private readonly workspaceManager: TranslationProjectWorkspace;
  private readonly lifecycleManager: TranslationProjectLifecycleManager;
  private readonly snapshotBuilder: TranslationProjectSnapshotBuilder;
  private readonly orderingStrategy: TranslationOrderingStrategy;
  private glossary?: Glossary;
  private storyTopology?: StoryTopology;
  private plotSummaryEntries: PlotSummaryEntry[] = [];
  private savedRepetitionPatternAnalysis: SavedRepetitionPatternAnalysisResult | null = null;
  private projectState: TranslationProjectState;
  private workspaceConfig!: WorkspaceConfig;
  private initialized = false;

  constructor(
    private readonly config: TranslationProjectConfig,
    options: {
      textSplitter?: TranslationUnitSplitter;
      parseUnits?: TranslationUnitParser;
      fileHandlerResolver?: TranslationFileHandlerResolver;
      documentManager?: TranslationDocumentManager;
      glossary?: Glossary;
      pipeline?: TranslationPipelineDefinition | TranslationPipeline;
      orderingStrategy?: TranslationOrderingStrategy;
    } = {},
  ) {
    this.projectDir = resolve(config.projectDir);
    this.chapters = [...config.chapters];
    this.documentManager =
      options.documentManager ??
      new TranslationDocumentManager(this.projectDir, {
        textSplitter: options.textSplitter,
        parseUnits: options.parseUnits,
        fileHandlerResolver: options.fileHandlerResolver,
      });
    this.glossary = options.glossary;
    this.pipeline =
      options.pipeline instanceof TranslationPipeline
        ? options.pipeline
        : new TranslationPipeline(
            options.pipeline ??
              createDefaultTranslationPipelineDefinition({
                documentManager: this.documentManager,
                getGlossary: () => this.glossary,
                glossaryConfig: this.config.glossary,
                getTraversalChapters: () => this.getTraversalChapters(),
                getPlotSummaryEntries: () => this.plotSummaryEntries,
                getStoryTopology: () => this.getEffectiveStoryTopology().topology,
                maxPlotSummaryEntries: 20,
                isStepCompleted: (chapterId, fragmentIndex, stepId) =>
                  this.isStepCompleted(chapterId, fragmentIndex, stepId),
              }),
          );
    this.projectState = createDefaultProjectState(this.pipeline);
    this.orderingStrategy = options.orderingStrategy ?? new GlossaryDependencyOrderingStrategy();
    this.orderingStrategy.setContext({
      config: this.config,
      getOrderedFragments: () => this.getOrderedFragments(),
      getStoryTopology: () => this.getEffectiveStoryTopology().topology,
      getSourceText: (chapterId, fragmentIndex) =>
        this.documentManager.getSourceText(chapterId, fragmentIndex),
      getStepState: (chapterId, fragmentIndex, stepId) =>
        this.documentManager.getPipelineStepState(chapterId, fragmentIndex, stepId),
      isStepCompleted: (chapterId, fragmentIndex, stepId) =>
        this.isStepCompleted(chapterId, fragmentIndex, stepId),
      getGlossaryTermStatus: (term) => this.glossary?.getTerm(term)?.status,
      filterGlossaryTerms: (text) =>
        [...new Set((this.glossary?.filterTerms(text) ?? []).map((term) => term.term))],
      getDependencyTrackingRevisions: () => ({
        sourceRevision: this.workspaceConfig?.dependencyTracking?.sourceRevision ?? 0,
        glossaryRevision: this.workspaceConfig?.dependencyTracking?.glossaryRevision ?? 0,
      }),
      loadDependencyGraph: async () =>
        (await this.documentManager.loadTranslationDependencyGraph()) ?? null,
      saveDependencyGraph: async (graph) => this.documentManager.saveTranslationDependencyGraph(graph),
      clearDependencyGraph: async () => this.documentManager.clearTranslationDependencyGraph(),
      loadContextNetwork: async () => (await this.documentManager.loadContextNetwork()) ?? null,
      saveContextNetwork: async (network) => this.documentManager.saveContextNetwork(network),
      clearContextNetwork: async () => this.documentManager.clearContextNetwork(),
    });

    this.workspaceManager = new TranslationProjectWorkspace(
      this.projectDir,
      this.config,
      this.documentManager,
      this.chapters,
      () => this.workspaceConfig,
      (nextConfig) => {
        this.workspaceConfig = nextConfig;
      },
      () => this.glossary,
      (glossary) => {
        this.glossary = glossary;
      },
      (filePath, handlerOptions, defaultFormat) =>
        resolveFileHandlerFromOptions(filePath, handlerOptions, defaultFormat),
      async () => {
        this.queueCache.clear();
        await this.initializePipelineQueues();
        await this.lifecycleManager.refreshLifecycleState();
      },
      async () => {
        this.queueCache.clear();
        await this.lifecycleManager.refreshLifecycleState();
      },
    );

    this.lifecycleManager = new TranslationProjectLifecycleManager({
      pipeline: this.pipeline,
      getProjectState: () => this.projectState,
      setProjectState: (state) => {
        this.projectState = state;
      },
      persistProjectState: async () => {
        await this.persistProjectState();
      },
      listAllQueueEntries: () => this.listAllQueueEntries(),
      getOrderedFragments: () => this.getOrderedFragments(),
      isStepCompleted: (chapterId, fragmentIndex, stepId) =>
        this.isStepCompleted(chapterId, fragmentIndex, stepId),
      requeueRunningWorkItems: async (errorMessage) => {
        await this.requeueRunningWorkItems(errorMessage);
      },
    });

    this.snapshotBuilder = new TranslationProjectSnapshotBuilder({
      projectName: this.config.projectName,
      pipeline: this.pipeline,
      documentManager: this.documentManager,
      getGlossary: () => this.glossary,
      getTraversalChapters: () => this.getTraversalChapters(),
      getOrderedFragments: () => this.getOrderedFragments(),
      listStepQueueEntries: (stepId) => this.listStepQueueEntries(stepId),
      listAllQueueEntries: () => this.listAllQueueEntries(),
      getCurrentCursor: () => this.getCurrentCursor(),
      isStepCompleted: (chapterId, fragmentIndex, stepId) =>
        this.isStepCompleted(chapterId, fragmentIndex, stepId),
      getLifecycleSnapshot: () => this.lifecycleManager.getLifecycleSnapshot(),
      resolveStepDependencies: (stepId, entry) => this.resolveStepDependencies(stepId, entry),
      buildWorkItem: (stepId, entry, resolution) => this.buildWorkItem(stepId, entry, resolution),
      buildInputPreview: (stepId, chapterId, fragmentIndex) =>
        this.buildInputPreview(stepId, chapterId, fragmentIndex),
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.chapters.length === 0) {
      throw new Error("必须通过 chapters 提供线性章节列表");
    }

    await this.documentManager.loadChapters(
      this.chapters.map((chapter) => ({
        chapterId: chapter.id,
        filePath: resolveChapterPath(this.projectDir, chapter.filePath),
      })),
    );

    this.workspaceConfig = buildInitialWorkspaceConfig(this.config, this.chapters);
    const existingWorkspaceConfig = await this.documentManager.loadWorkspaceConfig();
    if (existingWorkspaceConfig) {
      this.workspaceConfig = mergePersistedWorkspaceConfig(
        this.workspaceConfig,
        existingWorkspaceConfig,
      );
    }
    await this.documentManager.saveWorkspaceConfig(this.workspaceConfig);

    this.projectState =
      (await this.documentManager.loadProjectState()) ?? createDefaultProjectState(this.pipeline);
    this.projectState = normalizeProjectStateForPipeline(this.projectState, this.pipeline);

    const glossaryPath = this.workspaceConfig.glossary.path?.trim();
    if (!this.glossary && glossaryPath) {
      const resolvedGlossaryPath = resolveChapterPath(this.projectDir, glossaryPath);
      try {
        this.glossary = await GlossaryPersisterFactory.getPersister(resolvedGlossaryPath).loadGlossary(
          resolvedGlossaryPath,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // 术语表文件尚不存在（首次使用默认路径），初始化为空术语表
          this.glossary = new Glossary([]);
        } else {
          throw error;
        }
      }
    }

    await this.reloadNarrativeArtifacts();
    await this.loadSavedRepetitionPatternAnalysis();
    this.initialized = true;
    await this.initializePipelineQueues();
    await this.lifecycleManager.recoverInterruptedRunIfNeeded();
    await this.lifecycleManager.refreshLifecycleState();
  }

  getPipeline(): TranslationPipeline {
    return this.pipeline;
  }

  static async openWorkspace(
    projectDir: string,
    options: {
      textSplitter?: TranslationUnitSplitter;
      parseUnits?: TranslationUnitParser;
      fileHandlerResolver?: TranslationFileHandlerResolver;
      glossary?: Glossary;
      pipeline?: TranslationPipelineDefinition | TranslationPipeline;
      orderingStrategy?: TranslationOrderingStrategy;
    } = {},
  ): Promise<TranslationProject> {
    const workspaceConfig = await openWorkspaceConfig(projectDir);
    const textSplitter =
      options.textSplitter ??
      (typeof workspaceConfig.textSplitMaxChars === "number"
        ? new DefaultTextSplitter(workspaceConfig.textSplitMaxChars)
        : undefined);
    const project = new TranslationProject(
      {
        projectName: workspaceConfig.projectName,
        projectDir,
        chapters: workspaceConfig.chapters,
        glossary: workspaceConfig.glossary,
        textSplitMaxChars: workspaceConfig.textSplitMaxChars,
        customRequirements: workspaceConfig.customRequirements,
        editorRequirementsText: workspaceConfig.editorRequirementsText,
        styleGuidanceMode: workspaceConfig.styleGuidanceMode,
        styleRequirementsText: workspaceConfig.styleRequirementsText,
        styleLibraryName: workspaceConfig.styleLibraryName,
      },
      {
        ...options,
        textSplitter,
      },
    );

    await project.initialize();
    return project;
  }

  getWorkspaceConfig(): WorkspaceConfig {
    this.ensureInitialized();
    return this.workspaceManager.getWorkspaceConfig();
  }

  async updateWorkspaceConfig(
    patch: WorkspaceConfigPatch,
  ): Promise<WorkspaceConfig> {
    this.ensureInitialized();
    return this.workspaceManager.updateWorkspaceConfig(patch);
  }

  async bumpGlossaryDependencyRevision(): Promise<void> {
    this.ensureInitialized();
    const nextConfig = await this.workspaceManager.updateDependencyTracking((current) => ({
      ...current,
      glossaryRevision: current.glossaryRevision + 1,
    }));
    this.workspaceConfig = nextConfig;
    await this.invalidateDependencyGraph();
  }

  getChapterDescriptors(): WorkspaceChapterDescriptor[] {
    this.ensureInitialized();
    const descriptors = this.workspaceManager.getChapterDescriptors();
    const { topology } = this.getEffectiveStoryTopology();
    const chapterMetadata = this.buildChapterTopologyMetadata(topology);
    return descriptors.map((descriptor) => ({
      ...descriptor,
      ...(chapterMetadata.get(descriptor.id) ?? {}),
    }));
  }

  getChapterDescriptor(chapterId: number): WorkspaceChapterDescriptor | undefined {
    this.ensureInitialized();
    return this.getChapterDescriptors().find((chapter) => chapter.id === chapterId);
  }

  getProofreadTaskState(): ProofreadTaskState | undefined {
    this.ensureInitialized();
    return cloneProofreadTaskState(this.projectState.proofreadTask);
  }

  async saveProofreadTaskState(task: ProofreadTaskState | undefined): Promise<void> {
    this.ensureInitialized();
    this.projectState = {
      ...this.projectState,
      proofreadTask: cloneProofreadTaskState(task),
    };
    await this.persistProjectState();
  }

  buildProofreadFragmentInput(chapterId: number, fragmentIndex: number): {
    sourceText: string;
    currentTranslationText: string;
    contextView?: TranslationContextView;
    requirements: string[];
    editorRequirementsText?: string;
    blockedReason?: string;
    fragmentAuxData?: import("../types.ts").FragmentAuxData;
  } {
    this.ensureInitialized();
    const stepId = this.pipeline.finalStepId;
    const step = this.pipeline.getStep(stepId);
    const previousStepId = this.pipeline.getPreviousStepId(stepId);
    const previousStepOutput = previousStepId
      ? this.documentManager.getPipelineStepState(chapterId, fragmentIndex, previousStepId)?.output
      : undefined;
    const resolution =
      step.resolveDependencies?.({
        chapterId,
        fragmentIndex,
        stepId,
        runtime: this,
        previousStepId,
      }) ?? { ready: true };
    const metadata = resolution.ready ? (resolution.metadata ?? {}) : {};

    return {
      sourceText: step.buildInput({
        chapterId,
        fragmentIndex,
        runtime: this,
        previousStepOutput,
      }),
      currentTranslationText: this.documentManager.getTranslatedText(chapterId, fragmentIndex),
      contextView: step.buildContextView?.({
        chapterId,
        fragmentIndex,
        runtime: this,
        metadata,
      }),
      requirements: [...this.getRequirements(), ...(step.requirements ?? [])],
      editorRequirementsText: this.getEditorRequirementsText(),
      blockedReason: resolution.ready ? undefined : resolution.reason,
      fragmentAuxData: this.documentManager.getFragmentAuxData(chapterId, fragmentIndex),
    };
  }

  getChapterTranslationPreview(chapterId: number): {
    chapter: WorkspaceChapterDescriptor;
    units: Array<{
      index: number;
      sourceText: string;
      translatedText: string;
      hasTranslation: boolean;
    }>;
  } {
    this.ensureInitialized();
    const chapter = this.getChapterDescriptor(chapterId);
    if (!chapter) {
      throw new Error(`章节 ${chapterId} 不存在`);
    }

    return {
      chapter,
      units: this.documentManager
        .getChapterTranslationUnits(chapterId)
        .map((unit, index) => buildPreviewUnit(index, unit)),
    };
  }

  getChapterTranslationEditorDocument(
    chapterId: number,
    format: EditableTranslationFormat,
  ): ChapterTranslationEditorDocument {
    this.ensureInitialized();
    const chapter = this.documentManager.getChapterById(chapterId);
    if (!chapter) {
      throw new Error(`章节 ${chapterId} 不存在`);
    }

    return createChapterTranslationEditorDocument({
      chapterId,
      format,
      units: buildChapterTranslationEditorUnits(chapter),
      glossaryTerms: this.glossary?.getAllTerms().map((term) => ({
        term: term.term,
        translation: term.translation,
      })),
      repetitionMatches: this.buildChapterEditorRepetitionMatches(chapterId),
    });
  }

  validateChapterTranslationEditorContent(
    chapterId: number,
    format: EditableTranslationFormat,
    content: string,
  ): ChapterTranslationEditorValidationResult {
    this.ensureInitialized();
    const chapter = this.documentManager.getChapterById(chapterId);
    if (!chapter) {
      throw new Error(`章节 ${chapterId} 不存在`);
    }

    const draft = createChapterTranslationEditorDocument({
      chapterId,
      format,
      units: buildChapterTranslationEditorUnits(chapter),
    });
    return validateChapterTranslationEditorContent({
      baseline: draft.baseline,
      units: draft.units,
      content,
    });
  }

  async applyChapterTranslationEditorContent(
    chapterId: number,
    format: EditableTranslationFormat,
    content: string,
  ): Promise<ChapterTranslationEditorValidationResult> {
    const validation = this.validateChapterTranslationEditorContent(chapterId, format, content);
    if (!validation.canApply) {
      return validation;
    }

    for (const update of validation.updates) {
      if (!update.changed) {
        continue;
      }
      await this.documentManager.updateTranslatedLine(
        chapterId,
        update.fragmentIndex,
        update.lineIndex,
        update.nextText,
      );
    }

    return validation;
  }

  async addChapter(
    chapterId: number,
    filePath: string,
    options?: {
      format?: string;
      fileHandler?: TranslationFileHandler;
      importTranslation?: boolean;
    },
  ): Promise<TranslationImportResult> {
    this.ensureInitialized();
    const result = await this.workspaceManager.addChapter(chapterId, filePath, options);
    await this.reconcileImportedTranslations([chapterId], {
      importTranslation: options?.importTranslation ?? false,
    });
    if (this.storyTopology) {
      this.storyTopology.appendChapter(MAIN_ROUTE_ID, chapterId);
      await this.saveStoryTopology(this.storyTopology);
    }
    await this.bumpSourceDependencyRevision();
    await this.invalidateSavedRepetitionPatternAnalysis();
    return result;
  }

  async removeChapter(chapterId: number): Promise<void> {
    this.ensureInitialized();
    if (this.storyTopology) {
      const blockingBranch = this.storyTopology
        .getBranches()
        .find((route) => route.forkAfterChapterId === chapterId);
      if (blockingBranch) {
        throw new Error(
          `章节 ${chapterId} 是分支“${blockingBranch.name}”的分叉点，暂时不能删除`,
        );
      }
    }

    const routeId = this.storyTopology?.findRouteForChapter(chapterId)?.id;
    await this.workspaceManager.removeChapter(chapterId);
    if (this.storyTopology && routeId) {
      this.storyTopology.removeChapter(routeId, chapterId);
      await this.saveStoryTopology(this.storyTopology);
    }
    await this.bumpSourceDependencyRevision();
    await this.invalidateSavedRepetitionPatternAnalysis();
  }

  async removeChapters(
    chapterIds: number[],
    options: { cascadeBranches?: boolean } = {},
  ): Promise<void> {
    this.ensureInitialized();
    const normalizedChapterIds = [...new Set(chapterIds)];
    if (normalizedChapterIds.length === 0) {
      return;
    }

    const existingChapterIds = new Set(this.chapters.map((chapter) => chapter.id));
    for (const chapterId of normalizedChapterIds) {
      if (!existingChapterIds.has(chapterId)) {
        throw new Error(`章节 ${chapterId} 不存在`);
      }
    }

    const topology = this.storyTopology;
    if (!topology) {
      for (const chapterId of normalizedChapterIds) {
        await this.workspaceManager.removeChapter(chapterId);
      }
      await this.bumpSourceDependencyRevision();
      await this.invalidateSavedRepetitionPatternAnalysis();
      return;
    }

    const selectedChapterIdSet = new Set(normalizedChapterIds);
    const cascadeBranches = options.cascadeBranches ?? false;
    const branchesForkedFromSelected = topology
      .getBranches()
      .filter(
        (route) =>
          route.forkAfterChapterId !== null && selectedChapterIdSet.has(route.forkAfterChapterId),
      );

    if (!cascadeBranches && branchesForkedFromSelected.length > 0) {
      const blockingBranch = branchesForkedFromSelected[0]!;
      throw new Error(
        `章节 ${blockingBranch.forkAfterChapterId} 是分支“${blockingBranch.name}”的分叉点，暂时不能删除`,
      );
    }

    const chapterIdsToRemove = new Set<number>(normalizedChapterIds);
    const routeIdsToRemove = new Set<string>();
    if (cascadeBranches) {
      for (const route of branchesForkedFromSelected) {
        routeIdsToRemove.add(route.id);
        for (const descendantRouteId of this.collectDescendantRouteIds(topology, route.id)) {
          routeIdsToRemove.add(descendantRouteId);
        }
      }
      for (const routeId of routeIdsToRemove) {
        const route = topology.getRoute(routeId);
        if (!route) {
          continue;
        }
        for (const chapterId of route.chapters) {
          chapterIdsToRemove.add(chapterId);
        }
      }
    }

    const chapterRouteIdMap = new Map<number, string>();
    for (const route of topology.getAllRoutes()) {
      for (const chapterId of route.chapters) {
        chapterRouteIdMap.set(chapterId, route.id);
      }
    }

    for (const routeId of routeIdsToRemove) {
      topology.removeBranch(routeId);
    }

    const orderedChapterIdsToRemove = [...chapterIdsToRemove].sort((left, right) => left - right);
    for (const chapterId of orderedChapterIdsToRemove) {
      const routeId = chapterRouteIdMap.get(chapterId);
      if (routeId && topology.getRoute(routeId)) {
        topology.removeChapter(routeId, chapterId);
      }
      await this.workspaceManager.removeChapter(chapterId);
    }

    await this.saveStoryTopology(topology);
    await this.bumpSourceDependencyRevision();
    await this.invalidateSavedRepetitionPatternAnalysis();
  }

  async reorderChapters(chapterIds: number[]): Promise<void> {
    this.ensureInitialized();
    await this.workspaceManager.reorderChapters(chapterIds);
    await this.bumpSourceDependencyRevision();
    await this.invalidateSavedRepetitionPatternAnalysis();
  }

  getStoryTopologyDescriptor(): StoryTopologyDescriptor {
    this.ensureInitialized();
    const { topology, hasPersistedTopology } = this.getEffectiveStoryTopology();
    const document = topology.toDocument();

    return {
      schemaVersion: document.schemaVersion,
      hasPersistedTopology,
      hasBranches: topology.getBranches().length > 0,
      routes: topology.getAllRoutes().map((route) => this.buildRouteDescriptor(topology, route.id)),
    };
  }

  async createStoryBranch(definition: {
    id: string;
    name: string;
    parentRouteId?: string;
    forkAfterChapterId: number;
    chapterIds?: number[];
  }): Promise<void> {
    this.ensureInitialized();
    const topology = this.getMutableStoryTopology();
    const parentRouteId = definition.parentRouteId ?? MAIN_ROUTE_ID;
    const parentRoute = topology.getRoute(parentRouteId);
    if (!parentRoute) {
      throw new Error(`父路线不存在: ${parentRouteId}`);
    }

    const forkIndex = parentRoute.chapters.indexOf(definition.forkAfterChapterId);
    if (forkIndex === -1) {
      throw new Error(
        `分叉章节 ${definition.forkAfterChapterId} 不在父路线 "${parentRouteId}" 中`,
      );
    }

    const requestedIds = [...new Set(definition.chapterIds ?? [])];
    const movableChapterIds = new Set(parentRoute.chapters.slice(forkIndex + 1));
    for (const chapterId of requestedIds) {
      if (!movableChapterIds.has(chapterId)) {
        throw new Error(
          `章节 ${chapterId} 不是父路线 "${parentRouteId}" 在分叉点之后的可分配章节`,
        );
      }
    }

    const requestedSet = new Set(requestedIds);
    const orderedChapterIds = parentRoute.chapters.filter(
      (chapterId, index) => index > forkIndex && requestedSet.has(chapterId),
    );

    if (orderedChapterIds.length > 0) {
      this.replaceRouteChapters(
        topology,
        parentRouteId,
        parentRoute.chapters.filter((chapterId) => !requestedSet.has(chapterId)),
      );
    }

    topology.addBranch({
      id: definition.id,
      name: definition.name,
      parentRouteId,
      forkAfterChapterId: definition.forkAfterChapterId,
      chapters: orderedChapterIds,
    });
    await this.saveStoryTopology(topology);
  }

  async updateStoryRoute(
    routeId: string,
    patch: { name?: string; forkAfterChapterId?: number },
  ): Promise<void> {
    this.ensureInitialized();
    const topology = this.getMutableStoryTopology();
    topology.updateRoute(routeId, patch);
    await this.saveStoryTopology(topology);
  }

  async removeStoryRoute(routeId: string): Promise<void> {
    this.ensureInitialized();
    const topology = this.getMutableStoryTopology();
    const route = topology.getRoute(routeId);
    if (!route) {
      throw new Error(`路线不存在: ${routeId}`);
    }
    if (routeId === MAIN_ROUTE_ID) {
      throw new Error("不能移除主线");
    }
    if (topology.getChildBranches(routeId).length > 0) {
      throw new Error(`路线 "${route.name}" 仍有子分支，请先删除子分支`);
    }

    // Merge chapters back into parent route after the fork point
    if (route.chapters.length > 0 && route.parentRouteId) {
      const parentRoute = topology.getRoute(route.parentRouteId);
      if (parentRoute && route.forkAfterChapterId !== null) {
        const forkIndex = parentRoute.chapters.indexOf(route.forkAfterChapterId);
        const insertAt = forkIndex === -1 ? parentRoute.chapters.length : forkIndex + 1;
        const merged = [...parentRoute.chapters];
        merged.splice(insertAt, 0, ...route.chapters);
        this.replaceRouteChapters(topology, route.parentRouteId, merged);
      }
    }

    topology.removeBranch(routeId);
    await this.saveStoryTopology(topology);
  }

  async moveChapterToRoute(
    chapterId: number,
    targetRouteId: string,
    targetIndex: number,
  ): Promise<void> {
    this.ensureInitialized();
    const topology = this.getMutableStoryTopology();

    const sourceRoute = topology.findRouteForChapter(chapterId);
    if (!sourceRoute) {
      throw new Error(`章节 ${chapterId} 不在任何路线中`);
    }

    // Fork point chapters cannot be moved
    const childBranches = topology
      .getBranches()
      .filter((b) => b.forkAfterChapterId === chapterId);
    if (childBranches.length > 0) {
      throw new Error(`章节 ${chapterId} 是分叉点，不能移动`);
    }

    const targetRoute = topology.getRoute(targetRouteId);
    if (!targetRoute) {
      throw new Error(`目标路线不存在: ${targetRouteId}`);
    }

    if (sourceRoute.id === targetRouteId) {
      // Same route — reorder
      const chapters = [...sourceRoute.chapters];
      const currentIndex = chapters.indexOf(chapterId);
      if (currentIndex === -1) return;
      chapters.splice(currentIndex, 1);
      const clampedIndex = Math.min(targetIndex, chapters.length);
      chapters.splice(clampedIndex, 0, chapterId);
      this.replaceRouteChapters(topology, targetRouteId, chapters);
    } else {
      // Cross-route move
      topology.removeChapter(sourceRoute.id, chapterId);
      const clampedIndex = Math.min(
        targetIndex,
        (topology.getRoute(targetRouteId)?.chapters.length ?? 0),
      );
      topology.insertChapter(targetRouteId, chapterId, clampedIndex);
    }

    await this.saveStoryTopology(topology);
  }

  async reorderStoryRouteChapters(routeId: string, chapterIds: number[]): Promise<void> {
    this.ensureInitialized();
    const topology = this.getMutableStoryTopology();
    const route = topology.getRoute(routeId);
    if (!route) {
      throw new Error(`路线不存在: ${routeId}`);
    }

    if (chapterIds.length !== route.chapters.length) {
      throw new Error(`路线 "${route.name}" 的章节重排结果长度不匹配`);
    }

    const routeChapterIds = new Set(route.chapters);
    if (new Set(chapterIds).size !== route.chapters.length) {
      throw new Error(`路线 "${route.name}" 的章节重排结果包含重复章节`);
    }
    for (const chapterId of chapterIds) {
      if (!routeChapterIds.has(chapterId)) {
        throw new Error(`章节 ${chapterId} 不属于路线 "${route.name}"`);
      }
    }

    this.replaceRouteChapters(topology, routeId, [...chapterIds]);
    await this.saveStoryTopology(topology);
  }

  async exportChapter(
    chapterId: number,
    outputPath: string,
    options?: {
      format?: string;
      fileHandler?: TranslationFileHandler;
    },
  ): Promise<TranslationExportResult> {
    this.ensureInitialized();
    return this.workspaceManager.exportChapter(chapterId, outputPath, options);
  }

  async exportAllChapters(
    outputDir: string,
    options?: {
      format?: string;
      fileHandler?: TranslationFileHandler;
      fileExtension?: string;
    },
  ): Promise<TranslationExportResult[]> {
    this.ensureInitialized();
    return this.workspaceManager.exportAllChapters(outputDir, options);
  }

  /**
   * 按分线拓扑结构将已翻译章节批量导出到 export/ 目录。
   *
   * 导出规则：
   * - 导出根目录固定为 `{projectDir}/export/`
   * - 若项目只有主线，所有章节文件直接导出到 `export/`
   * - 若存在分支，主线导出到 `export/main/`，各分支导出到 `export/{routeId}/`
   * - 只导出「含已翻译文本块」的章节（至少有一个 fragment 有非空译文）
   * - 未翻译的 fragment 对应译文留空
   *
   * @param formatName - 文件格式名，如 "naturedialog"、"plain_text"、"galtransl_json" 等
   */
  async exportProject(formatName: string): Promise<ProjectExportResult> {
    this.ensureInitialized();

    const handler = TranslationFileHandlerFactory.getHandler(formatName);
    const exportRootDir = join(this.projectDir, "export");
    const topology = this.storyTopology;
    const hasBranches = topology ? topology.getBranches().length > 0 : false;

    const routes: RouteExportResult[] = [];

    if (!topology) {
      // 无拓扑结构，按 chapters 线性导出到根目录
      const chapterResults = await this.exportChaptersToDir(
        this.chapters,
        exportRootDir,
        handler,
      );
      routes.push({
        routeId: "main",
        routeName: "主线",
        exportDir: exportRootDir,
        chapters: chapterResults,
      });
    } else {
      for (const route of topology.getAllRoutes()) {
        const routeExportDir = hasBranches
          ? join(exportRootDir, route.id)
          : exportRootDir;

        const routeChapters = this.chapters.filter((ch) =>
          route.chapters.includes(ch.id),
        );
        const chapterResults = await this.exportChaptersToDir(
          routeChapters,
          routeExportDir,
          handler,
        );
        routes.push({
          routeId: route.id,
          routeName: route.name,
          exportDir: routeExportDir,
          chapters: chapterResults,
        });
      }
    }

    const totalChapters = routes.reduce((sum, r) => sum + r.chapters.length, 0);
    const totalUnits = routes.reduce(
      (sum, r) => r.chapters.reduce((s, c) => s + c.unitCount, 0) + sum,
      0,
    );

    return { exportDir: exportRootDir, routes, totalChapters, totalUnits };
  }

  /**
   * 将指定章节列表导出到目标目录，跳过无译文的章节。
   */
  private async exportChaptersToDir(
    chapters: Chapter[],
    outputDir: string,
    handler: TranslationFileHandler,
  ): Promise<TranslationExportResult[]> {
    await mkdir(outputDir, { recursive: true });

    const results: TranslationExportResult[] = [];
    for (const chapter of chapters) {
      const chapterEntry = this.documentManager.getChapterById(chapter.id);
      if (!chapterEntry) {
        continue;
      }

      const hasTranslation = chapterEntry.fragments.some((fragment) =>
        fragment.translation.lines.some((line) => line.trim().length > 0),
      );
      if (!hasTranslation) {
        continue;
      }

      const base = basename(chapter.filePath, extname(chapter.filePath));
      const ext = extname(chapter.filePath) || ".txt";
      const outputPath = join(outputDir, `${base}${ext}`);
      await this.documentManager.exportChapter(chapter.id, outputPath, handler);

      const unitCount = this.documentManager.getChapterTranslationUnits(chapter.id).length;
      results.push({ chapterId: chapter.id, outputPath, unitCount });
    }

    return results;
  }

  async importGlossary(filePath: string): Promise<GlossaryImportResult> {
    this.ensureInitialized();
    const result = await this.workspaceManager.importGlossary(filePath);
    await this.bumpGlossaryDependencyRevision();
    return result;
  }

  async exportGlossary(outputPath: string): Promise<void> {
    this.ensureInitialized();
    await this.workspaceManager.exportGlossary(outputPath);
  }

  getWorkspaceFileManifest(): WorkspaceFileManifest {
    this.ensureInitialized();
    return this.workspaceManager.getWorkspaceFileManifest();
  }

  getLifecycleSnapshot(): TranslationProjectLifecycleSnapshot {
    this.ensureInitialized();
    return this.lifecycleManager.getLifecycleSnapshot();
  }

  async startTranslation(): Promise<TranslationProjectLifecycleSnapshot> {
    this.ensureInitialized();
    for (const step of this.pipeline.steps) {
      await this.orderingStrategy.initializeForRun(step.id);
    }
    return this.lifecycleManager.startTranslation();
  }

  async stopTranslation(
    options: { mode?: TranslationStopMode } = {},
  ): Promise<TranslationProjectLifecycleSnapshot> {
    this.ensureInitialized();
    return this.lifecycleManager.stopTranslation(options);
  }

  async abortTranslation(reason?: string): Promise<TranslationProjectLifecycleSnapshot> {
    this.ensureInitialized();
    return this.lifecycleManager.abortTranslation(reason);
  }

  getWorkQueue(stepId: string): TranslationStepWorkQueue {
    let queue = this.queueCache.get(stepId);
    if (!queue) {
      queue = new TranslationStepWorkQueue(stepId, this);
      this.queueCache.set(stepId, queue);
    }

    return queue;
  }

  listStepQueueEntries(stepId: string): TranslationStepQueueEntry[] {
    this.ensureInitialized();
    this.pipeline.getStep(stepId);

    return this.getOrderedFragments()
      .flatMap((fragment) => {
        const stepState = this.documentManager.getPipelineStepState(
          fragment.chapterId,
          fragment.fragmentIndex,
          stepId,
        );
        if (!stepState) {
          return [];
        }

        return [
          {
            stepId,
            chapterId: fragment.chapterId,
            fragmentIndex: fragment.fragmentIndex,
            queueSequence: stepState.queueSequence,
            status: stepState.status,
            errorMessage: stepState.errorMessage,
          },
        ];
      })
      .sort((left, right) => left.queueSequence - right.queueSequence);
  }

  listReadyWorkItems(stepId: string): TranslationWorkItem[] {
    this.ensureInitialized();
    return this.listStepQueueEntries(stepId)
      .filter((entry) => entry.status === "queued")
      .flatMap((entry) => {
        const resolution = this.resolveStepDependencies(stepId, entry);
        if (!resolution.ready) {
          return [];
        }

        return [this.buildWorkItem(stepId, entry, resolution)];
      });
  }

  async dispatchReadyWorkItems(stepId?: string): Promise<TranslationWorkItem[]> {
    this.ensureInitialized();
    this.ensureTranslationRunningForDispatch();

    if (stepId) {
      return this.dispatchReadyWorkItemsForStep(stepId);
    }

    const results: TranslationWorkItem[] = [];
    for (const step of this.pipeline.steps) {
      results.push(...(await this.dispatchReadyWorkItemsForStep(step.id)));
    }
    return results;
  }

  async submitWorkResult(result: TranslationWorkResult): Promise<void> {
    this.ensureInitialized();
    this.ensureAcceptingResults(result.runId);

    const stepState = this.documentManager.getPipelineStepState(
      result.chapterId,
      result.fragmentIndex,
      result.stepId,
    );
    if (!stepState) {
      throw new Error(
        `步骤状态不存在: step=${result.stepId}, chapter=${result.chapterId}, fragment=${result.fragmentIndex}`,
      );
    }

    if (stepState.status !== "running") {
      throw new Error(
        `步骤未处于运行中，无法提交结果: step=${result.stepId}, chapter=${result.chapterId}, fragment=${result.fragmentIndex}`,
      );
    }

    if (result.success === false) {
      const now = new Date().toISOString();
      await this.documentManager.updatePipelineStepState(
        result.chapterId,
        result.fragmentIndex,
        result.stepId,
        {
          ...stepState,
          status: "queued",
          queuedAt: now,
          updatedAt: now,
          errorMessage: result.errorMessage,
        },
      );
      this.orderingStrategy.onItemRequeued(
        result.stepId,
        result.chapterId,
        result.fragmentIndex,
      );
      await this.lifecycleManager.refreshLifecycleState();
      return;
    }

    const output = createTextFragment(result.outputText ?? "");
    const now = new Date().toISOString();
    const completedStepState = {
      ...stepState,
      status: "completed" as const,
      completedAt: now,
      updatedAt: now,
      output,
      errorMessage: undefined,
    };

    if (result.stepId === this.pipeline.finalStepId) {
      // 原子写入：步骤状态与译文在同一次落盘，避免崩溃导致步骤已完成但译文丢失
      const hasPatch =
        result.fragmentAuxDataPatch != null &&
        Object.keys(result.fragmentAuxDataPatch).length > 0;
      if (hasPatch) {
        await this.documentManager.updateStepStateTranslationAndAuxDataPatch(
          result.chapterId,
          result.fragmentIndex,
          result.stepId,
          completedStepState,
          output,
          result.fragmentAuxDataPatch!,
        );
      } else {
        await this.documentManager.updateStepStateAndTranslation(
          result.chapterId,
          result.fragmentIndex,
          result.stepId,
          completedStepState,
          output,
        );
      }
    } else {
      // 非最终步骤：不有译文落盘，单独处理步骤状态和可能的 aux data patch
      await this.documentManager.updatePipelineStepState(
        result.chapterId,
        result.fragmentIndex,
        result.stepId,
        completedStepState,
      );
      if (
        result.fragmentAuxDataPatch != null &&
        Object.keys(result.fragmentAuxDataPatch).length > 0
      ) {
        await this.documentManager.mergeFragmentAuxData(
          result.chapterId,
          result.fragmentIndex,
          result.fragmentAuxDataPatch,
        );
      }
    }

    const nextStepId = this.pipeline.getNextStepId(result.stepId);
    if (nextStepId) {
      await this.enqueueStepIfNeeded(result.chapterId, result.fragmentIndex, nextStepId);
    }

    this.orderingStrategy.onItemCompleted(
      result.stepId,
      result.chapterId,
      result.fragmentIndex,
    );
    await this.lifecycleManager.refreshLifecycleState();
  }

  getProgressSnapshot(): ProjectProgressSnapshot {
    this.ensureInitialized();
    return this.snapshotBuilder.getProgressSnapshot();
  }

  getGlossaryProgress(): GlossaryProgressSnapshot | undefined {
    this.ensureInitialized();
    return this.snapshotBuilder.getGlossaryProgress();
  }

  getStepProgress(stepId: string): TranslationStepProgressSnapshot {
    this.ensureInitialized();
    return this.snapshotBuilder.getStepProgress(stepId);
  }

  getQueueSnapshot(stepId: string): TranslationStepQueueSnapshot {
    this.ensureInitialized();
    return this.snapshotBuilder.getQueueSnapshot(stepId);
  }

  getQueueSnapshots(): TranslationStepQueueSnapshot[] {
    this.ensureInitialized();
    return this.snapshotBuilder.getQueueSnapshots();
  }

  getActiveWorkItems(stepId?: string) {
    this.ensureInitialized();
    return this.snapshotBuilder.getActiveWorkItems(stepId);
  }

  getReadyWorkItemSnapshots(stepId?: string) {
    this.ensureInitialized();
    return this.snapshotBuilder.getReadyWorkItemSnapshots(stepId);
  }

  getProjectSnapshot(): TranslationProjectSnapshot {
    this.ensureInitialized();
    return this.snapshotBuilder.getProjectSnapshot();
  }

  scanGlobalAssociationPatterns(
    options: GlobalAssociationPatternScanOptions = {},
  ): GlobalAssociationPatternScanResult {
    this.ensureInitialized();

    const scanner = new GlobalAssociationPatternScanner();
    const sourceText = this.getTraversalChapters()
      .map((chapter) => this.documentManager.getChapterSourceText(chapter.id))
      .join("\n");
    const result = scanner.scanText(sourceText, options);

    this.glossary ??= new Glossary();
    for (const pattern of result.patterns) {
      upsertGlobalPatternTerm(this.glossary, pattern);
    }
    this.glossary.updateOccurrenceStats(
      collectSourceTextBlocks(this.documentManager, this.getTraversalChapters()),
    );

    return result;
  }

  analyzeRepeatedPatterns(
    options: ScopedRepetitionPatternAnalysisOptions = {},
  ): RepetitionPatternAnalysisResult {
    this.ensureInitialized();
    const chapters = this.resolveRepetitionPatternAnalysisChapters(options.chapterIds);
    return analyzeProjectRepeatedPatterns(
      {
        documentManager: this.documentManager,
        chapters,
      },
      options,
    );
  }

  getSavedRepeatedPatterns(
    options: { chapterIds?: number[] } = {},
  ): SavedRepetitionPatternAnalysisResult | null {
    this.ensureInitialized();
    if (!this.savedRepetitionPatternAnalysis) {
      return null;
    }
    return this.filterSavedRepeatedPatterns(options.chapterIds);
  }

  async scanAndSaveRepeatedPatterns(
    options: RepetitionPatternAnalysisOptions = {},
  ): Promise<SavedRepetitionPatternAnalysisResult> {
    this.ensureInitialized();
    const result = analyzeProjectRepeatedPatterns(
      {
        documentManager: this.documentManager,
        chapters: this.getTraversalChapters(),
      },
      options,
    );
    const saved = createSavedRepetitionPatternAnalysisResult(result, options);
    await this.documentManager.saveSavedRepetitionPatternAnalysis(saved);
    this.savedRepetitionPatternAnalysis = saved;
    return saved;
  }

  hydrateSavedRepeatedPatterns(options: {
    chapterIds?: number[];
    patternTexts?: string[];
  } = {}): RepetitionPatternAnalysisResult | null {
    this.ensureInitialized();
    if (!this.savedRepetitionPatternAnalysis) {
      return null;
    }
    const filtered = this.filterSavedRepeatedPatterns(
      options.chapterIds,
      options.patternTexts,
    );
    return hydrateSavedRepetitionPatternAnalysisResult(
      filtered,
      (location) => this.resolveSavedPatternLocationTranslation(location),
    );
  }

  async updateTranslatedLine(
    chapterId: number,
    fragmentIndex: number,
    lineIndex: number,
    translation: string,
  ): Promise<void> {
    this.ensureInitialized();
    await this.documentManager.updateTranslatedLine(
      chapterId,
      fragmentIndex,
      lineIndex,
      translation,
    );
  }

  async saveProgress(): Promise<void> {
    this.ensureInitialized();
    await this.documentManager.saveChapters();
    await this.workspaceManager.saveGlossaryIfNeeded();
    await this.lifecycleManager.markProgressSaved();
  }

  async saveTranslationRuntimeProgress(): Promise<void> {
    this.ensureInitialized();
    await this.workspaceManager.saveGlossaryIfNeeded();
    await this.lifecycleManager.markProgressSaved();
  }

  /**
   * 清除所有章节的译文与流水线状态，将整个项目恢复为"待翻译"初始状态。
   */
  async clearAllTranslations(): Promise<void> {
    this.ensureInitialized();
    const chapters = this.documentManager.getAllChapters();
    await this.resetTranslationsAndRebuildQueues(() =>
      this.documentManager.clearChapterTranslations(chapters.map((c) => c.id)),
    );
  }

  /**
   * 清除指定章节的译文与流水线状态。
   */
  async clearChapterTranslations(chapterIds: number[]): Promise<void> {
    this.ensureInitialized();
    const normalizedChapterIds = [...new Set(chapterIds)];
    await this.resetTranslationsAndRebuildQueues(() =>
      this.documentManager.clearChapterTranslations(normalizedChapterIds),
    );
  }

  /**
   * 清空整个术语表（删除所有条目）并保存到磁盘。
   */
  async clearGlossary(): Promise<void> {
    this.ensureInitialized();
    this.replaceGlossary(new Glossary([]));
    await this.workspaceManager.saveGlossaryIfNeeded();
    await this.bumpGlossaryDependencyRevision();
  }

  /**
   * 清除所有术语的译文（保留术语条目，将译文置空并标记为 untranslated），并保存到磁盘。
   */
  async clearGlossaryTranslations(): Promise<void> {
    this.ensureInitialized();
    const glossary = this.glossary;
    if (!glossary) return;
    const resetTerms = glossary.getAllTerms().map((term) => ({
      ...term,
      translation: "",
    }));
    this.replaceGlossary(new Glossary(resetTerms));
    await this.workspaceManager.saveGlossaryIfNeeded();
  }

  /**
   * 清除所有情节大纲条目并将空文档写入磁盘。
   */
  async clearPlotSummaries(): Promise<void> {
    this.ensureInitialized();
    this.plotSummaryEntries = [];
    const filePath = this.getPlotSummaryFilePath();
    await writeFile(
      filePath,
      JSON.stringify({ schemaVersion: 1, entries: [] }, null, 2),
      "utf8",
    );
  }

  async saveContextNetwork(data: ContextNetworkData): Promise<void> {
    this.ensureInitialized();
    await this.documentManager.saveContextNetwork(data);
  }

  async clearContextNetwork(): Promise<void> {
    this.ensureInitialized();
    await this.documentManager.clearContextNetwork();
  }

  getDocumentManager(): TranslationDocumentManager {
    return this.documentManager;
  }

  getGlossary(): Glossary | undefined {
    return this.glossary;
  }

  replaceGlossary(glossary: Glossary): void {
    this.ensureInitialized();
    this.glossary = glossary;
  }

  getStoryTopology(): StoryTopology | undefined {
    this.ensureInitialized();
    return this.storyTopology;
  }

  async saveStoryTopology(topology: StoryTopology): Promise<void> {
    this.ensureInitialized();
    await topology.saveToFile(this.getStoryTopologyFilePath());
    this.storyTopology = topology;
    await this.invalidateSavedRepetitionPatternAnalysis();
  }

  getPlotSummaryEntries(): PlotSummaryEntry[] {
    this.ensureInitialized();
    return [...this.plotSummaryEntries];
  }

  hasPlotSummaries(): boolean {
    this.ensureInitialized();
    return this.plotSummaryEntries.length > 0;
  }

  getPlotSummariesForPosition(
    chapterId: number,
    fragmentIndex?: number,
  ): PlotSummaryEntry[] {
    this.ensureInitialized();
    return getPlotSummariesForPosition(
      this.plotSummaryEntries,
      chapterId,
      fragmentIndex,
      this.storyTopology,
    );
  }

  async reloadNarrativeArtifacts(): Promise<void> {
    const topologyPath = this.getStoryTopologyFilePath();
    this.storyTopology = (await fileExists(topologyPath))
      ? await StoryTopology.loadFromFile(topologyPath)
      : undefined;

    this.plotSummaryEntries = await loadPlotSummaryEntriesFromFile(
      this.getPlotSummaryFilePath(),
    );
  }

  private async loadSavedRepetitionPatternAnalysis(): Promise<void> {
    this.savedRepetitionPatternAnalysis =
      await this.documentManager.loadSavedRepetitionPatternAnalysis() ?? null;
  }

  private async invalidateSavedRepetitionPatternAnalysis(): Promise<void> {
    if (!this.savedRepetitionPatternAnalysis) {
      return;
    }
    this.savedRepetitionPatternAnalysis = null;
    await this.documentManager.clearSavedRepetitionPatternAnalysis();
  }

  private filterSavedRepeatedPatterns(
    chapterIds?: number[],
    patternTexts?: string[],
  ): SavedRepetitionPatternAnalysisResult {
    const saved = this.savedRepetitionPatternAnalysis;
    if (!saved) {
      throw new Error("当前没有已保存的重复 Pattern 扫描结果");
    }

    const chapterIdSet =
      chapterIds && chapterIds.length > 0 ? new Set(chapterIds) : null;
    const patternTextSet =
      patternTexts && patternTexts.length > 0 ? new Set(patternTexts) : null;
    const minOccurrences = saved.scanOptions.minOccurrences ?? 2;

    const patterns = saved.patterns
      .filter((pattern) => !patternTextSet || patternTextSet.has(pattern.text))
      .map((pattern) => {
        const locations = chapterIdSet
          ? pattern.locations.filter((location) => chapterIdSet.has(location.chapterId))
          : pattern.locations;
        return {
          text: pattern.text,
          length: pattern.length,
          occurrenceCount: locations.length,
          locations,
        } satisfies SavedRepetitionPatternAnalysis;
      })
      .filter((pattern) => pattern.locations.length >= minOccurrences);

    return {
      ...saved,
      totalSentenceCount: this.resolveSavedPatternSentenceCount(chapterIds),
      patterns,
    };
  }

  private resolveSavedPatternSentenceCount(chapterIds?: number[]): number {
    const chapters = this.resolveRepetitionPatternAnalysisChapters(chapterIds);
    let totalSentenceCount = 0;
    for (const chapter of chapters) {
      const chapterEntry = this.documentManager.getChapterById(chapter.id);
      if (!chapterEntry) {
        continue;
      }
      totalSentenceCount += chapterEntry.fragments.reduce(
        (sum, fragment) => sum + fragment.source.lines.length,
        0,
      );
    }
    return totalSentenceCount;
  }

  private resolveSavedPatternLocationTranslation(
    location: SavedRepetitionPatternLocation,
  ): string {
    return (
      this.documentManager
        .getFragmentById(location.chapterId, location.fragmentIndex)
        ?.translation.lines[location.lineIndex] ?? ""
    );
  }

  private buildChapterEditorRepetitionMatches(
    chapterId: number,
  ): ChapterTranslationEditorRepetitionMatch[] {
    const saved = this.savedRepetitionPatternAnalysis;
    if (!saved) {
      return [];
    }

    const matches: ChapterTranslationEditorRepetitionMatch[] = [];
    for (const pattern of saved.patterns) {
      const locations = pattern.locations;
      for (const location of locations) {
        if (location.chapterId !== chapterId) {
          continue;
        }
        matches.push({
          unitIndex: location.unitIndex,
          text: pattern.text,
          matchStartInSentence: location.matchStartInSentence,
          matchEndInSentence: location.matchEndInSentence,
          hoverText: this.buildChapterEditorRepetitionHoverText(pattern.text, location, locations),
        });
      }
    }
    return matches.sort(
      (left, right) =>
        left.unitIndex - right.unitIndex ||
        left.matchStartInSentence - right.matchStartInSentence ||
        left.text.localeCompare(right.text),
    );
  }

  private buildChapterEditorRepetitionHoverText(
    patternText: string,
    focusLocation: SavedRepetitionPatternLocation,
    locations: SavedRepetitionPatternLocation[],
  ): string {
    const otherLocations = locations.filter(
      (location) =>
        !(
          location.chapterId === focusLocation.chapterId &&
          location.fragmentIndex === focusLocation.fragmentIndex &&
          location.lineIndex === focusLocation.lineIndex &&
          location.matchStartInSentence === focusLocation.matchStartInSentence &&
          location.matchEndInSentence === focusLocation.matchEndInSentence
        ),
    );
    if (otherLocations.length === 0) {
      return `已记录 Pattern：${patternText}`;
    }

    const preview = otherLocations
      .slice(0, 6)
      .map((location) => {
        const translation = this.resolveSavedPatternLocationTranslation(location).trim();
        return [
          `Ch${location.chapterId} / 句 ${location.unitIndex + 1}`,
          `原文：${location.sourceSentence}`,
          `译文：${translation || "(空)"}`,
        ].join("\n");
      })
      .join("\n\n");
    const suffix =
      otherLocations.length > 6 ? `\n\n另有 ${otherLocations.length - 6} 处未展开` : "";
    return `已记录 Pattern：${patternText}\n\n其他位置：\n${preview}${suffix}`;
  }

  getSourceText(chapterId: number, fragmentIndex: number): string {
    return this.documentManager.getSourceText(chapterId, fragmentIndex);
  }

  getTranslatedText(chapterId: number, fragmentIndex: number): string {
    return this.documentManager.getTranslatedText(chapterId, fragmentIndex);
  }

  getFragment(chapterId: number, fragmentIndex: number): FragmentEntry | undefined {
    return this.documentManager.getFragmentById(chapterId, fragmentIndex);
  }

  getOrderedFragments(): OrderedFragmentSnapshot[] {
    return this.getTraversalChapters().flatMap((chapter) =>
      this.documentManager.getChapterFragmentRefs(chapter.id),
    );
  }

  getRequirements(): string[] {
    return [...(this.workspaceManager.getWorkspaceConfig().customRequirements ?? [])];
  }

  getEditorRequirementsText(): string | undefined {
    return this.workspaceManager.getWorkspaceConfig().editorRequirementsText;
  }

  getStyleGuidanceMode(): import("../types.ts").StyleGuidanceMode | undefined {
    return this.workspaceManager.getWorkspaceConfig().styleGuidanceMode;
  }

  getStyleRequirementsText(): string | undefined {
    return this.workspaceManager.getWorkspaceConfig().styleRequirementsText;
  }

  getStyleLibraryName(): string | undefined {
    return this.workspaceManager.getWorkspaceConfig().styleLibraryName;
  }

  async reconcileImportedTranslations(
    chapterIds: number[],
    options: { importTranslation: boolean },
  ): Promise<void> {
    this.ensureInitialized();
    const normalizedChapterIds = [...new Set(chapterIds)];
    await this.documentManager.reconcileImportedChapterTranslations(normalizedChapterIds, {
      importTranslation: options.importTranslation,
      pipelineStepIds: this.pipeline.steps.map((step) => step.id),
      finalStepId: this.pipeline.finalStepId,
    });
    await this.rebuildQueuesAfterTranslationReset();
  }

  private async resetTranslationsAndRebuildQueues(
    resetTranslations: () => Promise<void>,
  ): Promise<void> {
    const lifecycleStatus = this.projectState.lifecycle.status;
    if (lifecycleStatus === "running" || lifecycleStatus === "stopping") {
      await this.lifecycleManager.abortTranslation("translation_reset");
    }

    await resetTranslations();
    await this.rebuildQueuesAfterTranslationReset();
  }

  private async rebuildQueuesAfterTranslationReset(): Promise<void> {
    this.queueCache.clear();
    await this.orderingStrategy.invalidate();
    await this.initializePipelineQueues();
    await this.lifecycleManager.refreshLifecycleState();
  }

  getCurrentCursor(): ProjectCursor {
    const activeEntry =
      this.listAllQueueEntries().find((entry) => entry.status === "running") ??
      this.listAllQueueEntries().find((entry) => entry.status === "queued");

    return activeEntry
      ? {
          chapterId: activeEntry.chapterId,
          fragmentIndex: activeEntry.fragmentIndex,
        }
      : {};
  }

  private async initializePipelineQueues(): Promise<void> {
    this.rebuildNextQueueSequences();
    const now = new Date().toISOString();
    const finalStepId = this.pipeline.finalStepId;

    const updates: Array<{
      chapterId: number;
      fragmentIndex: number;
      stepId: string;
      state: {
        status: "queued";
        queueSequence: number;
        attemptCount: number;
        queuedAt?: string;
        updatedAt?: string;
        output?: TextFragment;
        errorMessage?: string;
      };
    }> = [];

    for (const fragment of this.getOrderedFragments()) {
      if (this.isStepCompleted(fragment.chapterId, fragment.fragmentIndex, finalStepId)) {
        continue;
      }

      const firstStepId = this.pipeline.steps[0]!.id;
      if (!this.documentManager.getPipelineStepState(fragment.chapterId, fragment.fragmentIndex, firstStepId)) {
        updates.push({
          chapterId: fragment.chapterId,
          fragmentIndex: fragment.fragmentIndex,
          stepId: firstStepId,
          state: {
            status: "queued",
            queueSequence: this.allocateQueueSequence(firstStepId),
            attemptCount: 0,
            queuedAt: now,
            updatedAt: now,
          },
        });
      }

      for (const step of this.pipeline.steps.slice(1)) {
        const previousStepId = this.pipeline.getPreviousStepId(step.id);
        if (
          previousStepId &&
          this.isStepCompleted(fragment.chapterId, fragment.fragmentIndex, previousStepId) &&
          !this.documentManager.getPipelineStepState(
            fragment.chapterId,
            fragment.fragmentIndex,
            step.id,
          )
        ) {
          updates.push({
            chapterId: fragment.chapterId,
            fragmentIndex: fragment.fragmentIndex,
            stepId: step.id,
            state: {
              status: "queued",
              queueSequence: this.allocateQueueSequence(step.id),
              attemptCount: 0,
              queuedAt: now,
              updatedAt: now,
            },
          });
        }
      }
    }

    if (updates.length > 0) {
      await this.documentManager.updatePipelineStepStates(updates);
    }
  }

  private async dispatchReadyWorkItemsForStep(stepId: string): Promise<TranslationWorkItem[]> {
    const queuedEntries = this.listStepQueueEntries(stepId).filter((entry) => entry.status === "queued");
    const strategyReadyItems = await this.orderingStrategy.listReadyItems(stepId, queuedEntries);
    const readyItems = strategyReadyItems
      ? this.buildWorkItemsFromOrderingItems(
          this.orderingStrategy.selectDispatchableItems(stepId, strategyReadyItems),
          queuedEntries,
        )
      : this.listReadyWorkItems(stepId);
    if (readyItems.length === 0) {
      return [];
    }

    const now = new Date().toISOString();
    await this.documentManager.updatePipelineStepStates(
      readyItems.map((item) => {
        const currentState = this.documentManager.getPipelineStepState(
          item.chapterId,
          item.fragmentIndex,
          item.stepId,
        )!;
        return {
          chapterId: item.chapterId,
          fragmentIndex: item.fragmentIndex,
          stepId: item.stepId,
          state: {
            ...currentState,
            status: "running",
            attemptCount: (currentState.attemptCount ?? 0) + 1,
            startedAt: now,
            updatedAt: now,
            lastRunId: item.runId,
            errorMessage: undefined,
          },
        };
      }),
    );

    for (const item of readyItems) {
      this.orderingStrategy.onItemStarted(item.stepId, item.chapterId, item.fragmentIndex);
    }

    return readyItems;
  }

  private buildWorkItemsFromOrderingItems(
    readyItems: ReadyOrderingItem[],
    queuedEntries: TranslationStepQueueEntry[],
  ): TranslationWorkItem[] {
    const queuedEntryByNodeId = new Map(
      queuedEntries.map((entry) => [
        `${entry.stepId}:${entry.chapterId}:${entry.fragmentIndex}`,
        entry,
      ]),
    );

    return readyItems
      .map((item) => {
        const entry = queuedEntryByNodeId.get(`${item.stepId}:${item.chapterId}:${item.fragmentIndex}`);
        if (!entry) {
          return undefined;
        }

        return this.buildWorkItem(item.stepId, entry, {
          ready: true,
          metadata: item.metadata,
        });
      })
      .filter((item): item is TranslationWorkItem => item !== undefined)
      .sort((left, right) => left.queueSequence - right.queueSequence);
  }

  private buildWorkItem(
    stepId: string,
    entry: TranslationStepQueueEntry,
    resolution: PipelineDependencyResolution,
  ): TranslationWorkItem {
    const step = this.pipeline.getStep(stepId);
    const previousStepId = this.pipeline.getPreviousStepId(stepId);
    const previousStepOutput = previousStepId
      ? this.documentManager.getPipelineStepState(
          entry.chapterId,
          entry.fragmentIndex,
          previousStepId,
        )?.output
      : undefined;
    const metadata = resolution.metadata ?? {};

    return {
      ...entry,
      runId: this.getCurrentRunIdOrThrow(),
      inputText: step.buildInput({
        chapterId: entry.chapterId,
        fragmentIndex: entry.fragmentIndex,
        runtime: this,
        previousStepOutput,
      }),
      contextView: step.buildContextView?.({
        chapterId: entry.chapterId,
        fragmentIndex: entry.fragmentIndex,
        runtime: this,
        metadata,
      }),
      requirements: [...this.getRequirements(), ...(step.requirements ?? [])],
      metadata,
    };
  }

  private buildInputPreview(
    stepId: string,
    chapterId: number,
    fragmentIndex: number,
  ): string {
    const step = this.pipeline.getStep(stepId);
    const previousStepId = this.pipeline.getPreviousStepId(stepId);
    const previousStepOutput = previousStepId
      ? this.documentManager.getPipelineStepState(chapterId, fragmentIndex, previousStepId)?.output
      : undefined;
    return step.buildInput({
      chapterId,
      fragmentIndex,
      runtime: this,
      previousStepOutput,
    });
  }

  private resolveStepDependencies(
    stepId: string,
    entry: TranslationStepQueueEntry,
  ): PipelineDependencyResolution {
    const strategyResolution = this.orderingStrategy.resolveDependencies?.(stepId, entry);
    if (strategyResolution) {
      return strategyResolution;
    }

    const step = this.pipeline.getStep(stepId);
    return (
      step.resolveDependencies?.({
        chapterId: entry.chapterId,
        fragmentIndex: entry.fragmentIndex,
        stepId,
        runtime: this,
        previousStepId: this.pipeline.getPreviousStepId(stepId),
      }) ?? {
        ready: true,
        metadata: {},
      }
    );
  }

  private async enqueueStepIfNeeded(
    chapterId: number,
    fragmentIndex: number,
    stepId: string,
  ): Promise<void> {
    if (this.documentManager.getPipelineStepState(chapterId, fragmentIndex, stepId)) {
      return;
    }

    const now = new Date().toISOString();
    await this.documentManager.updatePipelineStepState(chapterId, fragmentIndex, stepId, {
      status: "queued",
      queueSequence: this.allocateQueueSequence(stepId),
      attemptCount: 0,
      queuedAt: now,
      updatedAt: now,
    });
    this.orderingStrategy.onItemRequeued(stepId, chapterId, fragmentIndex);
  }

  private listAllQueueEntries(): TranslationStepQueueEntry[] {
    return this.pipeline.steps.flatMap((step) => this.listStepQueueEntries(step.id));
  }

  private isStepCompleted(
    chapterId: number,
    fragmentIndex: number,
    stepId: string,
  ): boolean {
    return (
      this.documentManager.getPipelineStepState(chapterId, fragmentIndex, stepId)?.status ===
      "completed"
    );
  }

  private rebuildNextQueueSequences(): void {
    this.nextQueueSequenceByStep.clear();
    for (const step of this.pipeline.steps) {
      const maxSequence = this.listStepQueueEntries(step.id).reduce(
        (currentMax, entry) => Math.max(currentMax, entry.queueSequence),
        0,
      );
      this.nextQueueSequenceByStep.set(step.id, maxSequence + 1);
    }
  }

  private allocateQueueSequence(stepId: string): number {
    const next = this.nextQueueSequenceByStep.get(stepId) ?? 1;
    this.nextQueueSequenceByStep.set(stepId, next + 1);
    return next;
  }

  private async requeueRunningWorkItems(errorMessage: string): Promise<void> {
    const now = new Date().toISOString();
    const runningEntries = this.listAllQueueEntries().filter((entry) => entry.status === "running");
    if (runningEntries.length === 0) {
      return;
    }

    await this.documentManager.updatePipelineStepStates(
      runningEntries.map((entry) => ({
        chapterId: entry.chapterId,
        fragmentIndex: entry.fragmentIndex,
        stepId: entry.stepId,
        state: {
          ...this.documentManager.getPipelineStepState(
            entry.chapterId,
            entry.fragmentIndex,
            entry.stepId,
          )!,
          status: "queued",
          queuedAt: now,
          updatedAt: now,
          errorMessage,
        },
      })),
    );

    for (const entry of runningEntries) {
      this.orderingStrategy.onItemRequeued(entry.stepId, entry.chapterId, entry.fragmentIndex);
    }
  }

  private async persistProjectState(): Promise<void> {
    await this.documentManager.saveProjectState(this.projectState);
  }

  private async bumpSourceDependencyRevision(): Promise<void> {
    const nextConfig = await this.workspaceManager.updateDependencyTracking((current) => ({
      ...current,
      sourceRevision: current.sourceRevision + 1,
    }));
    this.workspaceConfig = nextConfig;
    await this.orderingStrategy.invalidate();
  }

  private async invalidateDependencyGraph(): Promise<void> {
    await this.orderingStrategy.invalidate();
  }

  private getCurrentRunIdOrThrow(): string {
    const runId = this.projectState.lifecycle.currentRunId;
    if (!runId) {
      throw new Error("当前没有活动中的翻译运行，请先调用 startTranslation()");
    }

    return runId;
  }

  private ensureTranslationRunningForDispatch(): void {
    const status = this.projectState.lifecycle.status;
    if (status === "stopping") {
      throw new Error("翻译流程正在停止中，当前不再调度新的工作项");
    }

    if (status !== "running") {
      throw new Error("翻译流程尚未启动，请先调用 startTranslation()");
    }
  }

  private ensureAcceptingResults(runId: string): void {
    const status = this.projectState.lifecycle.status;
    if (status !== "running" && status !== "stopping") {
      throw new Error("当前项目不接受翻译结果，请先启动翻译流程");
    }

    if (runId !== this.getCurrentRunIdOrThrow()) {
      throw new Error("翻译结果所属的运行批次已失效，不能写回当前项目");
    }
  }

  private getTraversalChapters(): Chapter[] {
    return [...this.chapters];
  }

  private getEffectiveStoryTopology(): {
    topology: StoryTopology;
    hasPersistedTopology: boolean;
  } {
    return {
      topology: this.storyTopology ?? this.createSyntheticStoryTopology(),
      hasPersistedTopology: this.storyTopology !== undefined,
    };
  }

  private getMutableStoryTopology(): StoryTopology {
    if (!this.storyTopology) {
      this.storyTopology = this.createSyntheticStoryTopology();
    }
    return this.storyTopology;
  }

  private createSyntheticStoryTopology(): StoryTopology {
    const topology = StoryTopology.createEmpty();
    topology.setMainRouteChapters(this.chapters.map((chapter) => chapter.id));
    return topology;
  }

  private buildRouteDescriptor(
    topology: StoryTopology,
    routeId: string,
  ): StoryTopologyRouteDescriptor {
    const route = topology.getRoute(routeId);
    if (!route) {
      throw new Error(`路线不存在: ${routeId}`);
    }

    return {
      id: route.id,
      name: route.name,
      parentRouteId: route.parentRouteId,
      forkAfterChapterId: route.forkAfterChapterId,
      chapters: [...route.chapters],
      childRouteIds: topology.getChildBranches(route.id).map((branch) => branch.id),
      depth: this.getRouteDepth(topology, route.id),
      isMain: route.id === MAIN_ROUTE_ID,
    };
  }

  private buildChapterTopologyMetadata(
    topology: StoryTopology,
  ): Map<number, Partial<WorkspaceChapterDescriptor>> {
    const metadata = new Map<number, Partial<WorkspaceChapterDescriptor>>();
    const childBranchCountByFork = new Map<number, number>();

    for (const branch of topology.getBranches()) {
      if (branch.forkAfterChapterId === null) {
        continue;
      }
      childBranchCountByFork.set(
        branch.forkAfterChapterId,
        (childBranchCountByFork.get(branch.forkAfterChapterId) ?? 0) + 1,
      );
    }

    for (const route of topology.getAllRoutes()) {
      route.chapters.forEach((chapterId, routeChapterIndex) => {
        metadata.set(chapterId, {
          routeId: route.id,
          routeName: route.name,
          routeChapterIndex,
          isForkPoint: (childBranchCountByFork.get(chapterId) ?? 0) > 0,
          childBranchCount: childBranchCountByFork.get(chapterId) ?? 0,
        });
      });
    }

    return metadata;
  }

  private resolveRepetitionPatternAnalysisChapters(chapterIds?: readonly number[]): Chapter[] {
    const traversalChapters = this.getTraversalChapters();
    if (!chapterIds) {
      return traversalChapters;
    }
    if (chapterIds.length === 0) {
      return [];
    }

    const chapterById = new Map(traversalChapters.map((chapter) => [chapter.id, chapter] as const));
    const uniqueChapterIds = [...new Set(chapterIds)];
    const missingChapterIds = uniqueChapterIds.filter((chapterId) => !chapterById.has(chapterId));
    if (missingChapterIds.length > 0) {
      throw new Error(`章节不存在: ${missingChapterIds.join(", ")}`);
    }

    return uniqueChapterIds.map((chapterId) => chapterById.get(chapterId)!);
  }

  private replaceRouteChapters(
    topology: StoryTopology,
    routeId: string,
    chapterIds: number[],
  ): void {
    if (routeId === MAIN_ROUTE_ID) {
      topology.setMainRouteChapters(chapterIds);
      return;
    }
    topology.updateRoute(routeId, { chapters: chapterIds });
  }

  private getRouteDepth(topology: StoryTopology, routeId: string): number {
    let depth = 0;
    let current = topology.getRoute(routeId);
    while (current?.parentRouteId) {
      depth += 1;
      current = topology.getRoute(current.parentRouteId);
    }
    return depth;
  }

  private collectDescendantRouteIds(
    topology: StoryTopology,
    routeId: string,
  ): string[] {
    const descendants: string[] = [];
    const queue = [routeId];
    while (queue.length > 0) {
      const currentRouteId = queue.shift()!;
      const childBranches = topology.getChildBranches(currentRouteId);
      for (const branch of childBranches) {
        descendants.push(branch.id);
        queue.push(branch.id);
      }
    }
    return descendants;
  }

  private getStoryTopologyFilePath(): string {
    return join(this.projectDir, "Data", "story-topology.json");
  }

  private getPlotSummaryFilePath(): string {
    return join(this.projectDir, "Data", "plot-summaries.json");
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("项目尚未初始化，请先调用 initialize()");
    }
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function cloneProofreadTaskState(
  state: ProofreadTaskState | undefined,
): ProofreadTaskState | undefined {
  if (!state) {
    return undefined;
  }

  return {
    ...state,
    chapterIds: [...state.chapterIds],
    chapters: state.chapters.map((chapter) => ({
      ...chapter,
      completedFragmentIndices: [...(chapter.completedFragmentIndices ?? [])],
    })),
  };
}

function buildPreviewUnit(index: number, unit: TranslationUnit) {
  const translatedText = unit.target.at(-1) ?? "";
  return {
    index,
    sourceText: restoreBlankText(unit.source),
    translatedText: restoreBlankText(translatedText),
    hasTranslation: translatedText.trim().length > 0,
  };
}
