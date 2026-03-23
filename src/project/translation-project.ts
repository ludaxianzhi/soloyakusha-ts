/**
 * 负责翻译项目初始化、Pipeline 调度、步骤工作队列接入与结果提交协调。
 *
 * @module project/translation-project
 */

import type { TranslationFileHandlerResolver } from "../file-handlers/base.ts";
import { Glossary, GlossaryPersisterFactory } from "../glossary/index.ts";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { TranslationContextView } from "./context-view.ts";
import type {
  GlobalAssociationPattern,
  GlobalAssociationPatternScanOptions,
  GlobalAssociationPatternScanResult,
} from "./global-pattern-scanner.ts";
import { GlobalAssociationPatternScanner } from "./global-pattern-scanner.ts";
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
import { TranslationDocumentManager } from "./translation-document-manager.ts";
import type {
  Chapter,
  FragmentEntry,
  GlossaryProgressSnapshot,
  ProjectProgressSnapshot,
  ProjectCursor,
  TranslationProjectLifecycleSnapshot,
  TranslationProjectState,
  TranslationStopMode,
  TextFragment,
  TranslationProjectSnapshot,
  TranslationStepProgressSnapshot,
  TranslationStepQueueSnapshot,
  TranslationDependencyMode,
  TranslationProjectConfig,
  TranslationUnitParser,
  TranslationUnitSplitter,
  TranslationStepQueueEntrySnapshot,
} from "./types.ts";
import { ProjectProgress, createTextFragment, fragmentToText } from "./types.ts";

export class TranslationProject
  implements TranslationPipelineRuntime, TranslationWorkQueueRuntime
{
  private readonly projectDir: string;
  private readonly chapters: Chapter[];
  private readonly documentManager: TranslationDocumentManager;
  private readonly pipeline: TranslationPipeline;
  private readonly queueCache = new Map<string, TranslationStepWorkQueue>();
  private readonly nextQueueSequenceByStep = new Map<string, number>();
  private glossary?: Glossary;
  private projectState: TranslationProjectState;
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
        : new TranslationPipeline(options.pipeline ?? this.createDefaultPipelineDefinition());
    this.projectState = createDefaultProjectState(this.pipeline);
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

    if (!this.glossary && this.config.glossary?.path) {
      const glossaryPath = resolveChapterPath(this.projectDir, this.config.glossary.path);
      this.glossary = await GlossaryPersisterFactory.getPersister(
        glossaryPath,
      ).loadGlossary(glossaryPath);
    }

    this.projectState =
      (await this.documentManager.loadProjectState()) ?? createDefaultProjectState(this.pipeline);
    this.projectState = normalizeProjectStateForPipeline(this.projectState, this.pipeline);
    this.initialized = true;
    await this.initializePipelineQueues();
    await this.recoverInterruptedRunIfNeeded();
    await this.refreshLifecycleState();
  }

  getPipeline(): TranslationPipeline {
    return this.pipeline;
  }

  getLifecycleSnapshot(): TranslationProjectLifecycleSnapshot {
    const queuedWorkItems = this.listAllQueueEntries().filter((entry) => entry.status === "queued")
      .length;
    const activeWorkItems = this.listAllQueueEntries().filter((entry) => entry.status === "running")
      .length;
    const status = this.projectState.lifecycle.status;

    return {
      ...this.projectState.lifecycle,
      hasPendingWork: queuedWorkItems > 0 || activeWorkItems > 0,
      queuedWorkItems,
      activeWorkItems,
      canStart:
        status !== "running" &&
        status !== "stopping" &&
        (queuedWorkItems > 0 || status === "interrupted"),
      canStop: status === "running" || status === "stopping",
    };
  }

  async startTranslation(): Promise<TranslationProjectLifecycleSnapshot> {
    this.ensureInitialized();

    const lifecycle = this.projectState.lifecycle;
    if (lifecycle.status === "running" || lifecycle.status === "stopping") {
      throw new Error(`翻译流程已处于${lifecycle.status}状态，不能重复启动`);
    }

    await this.recoverInterruptedRunIfNeeded();
    await this.refreshLifecycleState();
    if (!this.listAllQueueEntries().some((entry) => entry.status === "queued")) {
      return this.getLifecycleSnapshot();
    }

    const now = new Date().toISOString();
    this.projectState = {
      ...this.projectState,
      lifecycle: {
        status: "running",
        currentRunId: randomUUID(),
        startedAt: now,
        stopRequestedAt: undefined,
        stoppedAt: undefined,
        completedAt: undefined,
        interruptedAt: this.projectState.lifecycle.interruptedAt,
        updatedAt: now,
      },
    };
    await this.persistProjectState();
    return this.getLifecycleSnapshot();
  }

  async stopTranslation(
    options: { mode?: TranslationStopMode } = {},
  ): Promise<TranslationProjectLifecycleSnapshot> {
    this.ensureInitialized();

    const mode = options.mode ?? "graceful";
    const lifecycle = this.projectState.lifecycle;
    if (lifecycle.status !== "running" && lifecycle.status !== "stopping") {
      return this.getLifecycleSnapshot();
    }

    if (mode === "immediate") {
      await this.requeueRunningWorkItems("translation_interrupted");
      await this.updateLifecycleState({
        status: "stopped",
        currentRunId: undefined,
        stopRequestedAt: undefined,
        stoppedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return this.getLifecycleSnapshot();
    }

    const now = new Date().toISOString();
    await this.updateLifecycleState({
      status: "stopping",
      stopRequestedAt: now,
      updatedAt: now,
    });
    await this.refreshLifecycleState();
    return this.getLifecycleSnapshot();
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
        const stepState = fragment.fragment.pipelineStates[stepId];
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
      await this.documentManager.updatePipelineStepState(
        result.chapterId,
        result.fragmentIndex,
        result.stepId,
        {
          ...stepState,
          status: "queued",
          queuedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          errorMessage: result.errorMessage,
        },
      );
      await this.refreshLifecycleState();
      return;
    }

    const output = createTextFragment(result.outputText ?? "");
    await this.documentManager.updatePipelineStepState(
      result.chapterId,
      result.fragmentIndex,
      result.stepId,
      {
        ...stepState,
        status: "completed",
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        output,
        errorMessage: undefined,
      },
    );

    if (result.stepId === this.pipeline.finalStepId) {
      await this.documentManager.updateTranslation(
        result.chapterId,
        result.fragmentIndex,
        output,
      );
    }

    const nextStepId = this.pipeline.getNextStepId(result.stepId);
    if (nextStepId) {
      await this.enqueueStepIfNeeded(result.chapterId, result.fragmentIndex, nextStepId);
    }

    await this.refreshLifecycleState();
  }

  getProgress(): ProjectProgress {
    if (!this.initialized) {
      return new ProjectProgress();
    }

    const orderedFragments = this.getOrderedFragments();
    const translatedFragments = orderedFragments.filter((fragment) =>
      this.isStepCompleted(fragment.chapterId, fragment.fragmentIndex, this.pipeline.finalStepId),
    ).length;
    const totalFragments = orderedFragments.length;

    let translatedChapters = 0;
    for (const chapter of this.getTraversalChapters()) {
      const chapterEntry = this.documentManager.getChapterById(chapter.id);
      if (!chapterEntry) {
        continue;
      }

      if (
        chapterEntry.fragments.every((_, fragmentIndex) =>
          this.isStepCompleted(chapter.id, fragmentIndex, this.pipeline.finalStepId),
        )
      ) {
        translatedChapters += 1;
      }
    }

    const cursor = this.getCurrentCursor();
    return new ProjectProgress(
      this.getTraversalChapters().length,
      translatedChapters,
      totalFragments,
      translatedFragments,
      cursor.chapterId,
      cursor.fragmentIndex,
    );
  }

  getProgressSnapshot(): ProjectProgressSnapshot {
    const progress = this.getProgress();
    return {
      totalChapters: progress.totalChapters,
      translatedChapters: progress.translatedChapters,
      totalFragments: progress.totalFragments,
      translatedFragments: progress.translatedFragments,
      currentChapterId: progress.currentChapterId,
      currentFragmentIndex: progress.currentFragmentIndex,
      fragmentProgressRatio: progress.fragmentProgressRatio,
      chapterProgressRatio: progress.chapterProgressRatio,
    };
  }

  getGlossaryProgress(): GlossaryProgressSnapshot | undefined {
    if (!this.glossary) {
      return undefined;
    }

    const terms = this.glossary.getAllTerms();
    const translatedTerms = terms.filter((term) => term.status === "translated").length;
    return {
      totalTerms: terms.length,
      translatedTerms,
      untranslatedTerms: terms.length - translatedTerms,
    };
  }

  getStepProgress(stepId: string): TranslationStepProgressSnapshot {
    const step = this.pipeline.getStep(stepId);
    const entries = this.listStepQueueEntries(stepId);
    const readyEntries = entries.filter((entry) => entry.status === "queued").filter((entry) =>
      this.resolveStepDependencies(stepId, entry).ready,
    );
    const queuedFragments = entries.filter((entry) => entry.status === "queued").length;
    const runningFragments = entries.filter((entry) => entry.status === "running").length;
    const completedFragments = entries.filter((entry) => entry.status === "completed").length;
    const totalFragments = this.getOrderedFragments().length;

    return {
      stepId,
      description: step.description,
      isFinalStep: stepId === this.pipeline.finalStepId,
      totalFragments,
      queuedFragments,
      runningFragments,
      completedFragments,
      readyFragments: readyEntries.length,
      waitingFragments: queuedFragments - readyEntries.length,
      completionRatio: totalFragments === 0 ? 0 : completedFragments / totalFragments,
    };
  }

  getQueueSnapshot(stepId: string): TranslationStepQueueSnapshot {
    const step = this.pipeline.getStep(stepId);
    return {
      stepId,
      description: step.description,
      isFinalStep: stepId === this.pipeline.finalStepId,
      progress: this.getStepProgress(stepId),
      entries: this.listStepQueueEntries(stepId).map((entry) =>
        this.buildQueueEntrySnapshot(stepId, entry),
      ),
    };
  }

  getQueueSnapshots(): TranslationStepQueueSnapshot[] {
    return this.pipeline.steps.map((step) => this.getQueueSnapshot(step.id));
  }

  getActiveWorkItems(stepId?: string): TranslationStepQueueEntrySnapshot[] {
    const stepIds = stepId ? [stepId] : this.pipeline.steps.map((step) => step.id);
    return stepIds.flatMap((currentStepId) =>
      this.listStepQueueEntries(currentStepId)
        .filter((entry) => entry.status === "running")
        .map((entry) => this.buildQueueEntrySnapshot(currentStepId, entry)),
    );
  }

  getReadyWorkItemSnapshots(stepId?: string): TranslationStepQueueEntrySnapshot[] {
    const stepIds = stepId ? [stepId] : this.pipeline.steps.map((step) => step.id);
    return stepIds.flatMap((currentStepId) =>
      this.listStepQueueEntries(currentStepId)
        .filter((entry) => entry.status === "queued")
        .map((entry) => this.buildQueueEntrySnapshot(currentStepId, entry))
        .filter((entry) => entry.readyToDispatch),
    );
  }

  getProjectSnapshot(): TranslationProjectSnapshot {
    return {
      projectName: this.config.projectName,
      currentCursor: this.getCurrentCursor(),
      lifecycle: this.getLifecycleSnapshot(),
      progress: this.getProgressSnapshot(),
      glossary: this.getGlossaryProgress(),
      pipeline: {
        stepCount: this.pipeline.steps.length,
        finalStepId: this.pipeline.finalStepId,
        steps: this.pipeline.steps.map((step) => ({
          id: step.id,
          description: step.description,
          isFinalStep: step.id === this.pipeline.finalStepId,
        })),
      },
      queueSnapshots: this.getQueueSnapshots(),
      activeWorkItems: this.getActiveWorkItems(),
      readyWorkItems: this.getReadyWorkItemSnapshots(),
    };
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

  async saveProgress(): Promise<void> {
    this.ensureInitialized();
    await this.documentManager.saveChapters();
    await this.persistProjectState();
  }

  getDocumentManager(): TranslationDocumentManager {
    return this.documentManager;
  }

  getGlossary(): Glossary | undefined {
    return this.glossary;
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
      (this.documentManager.getChapterById(chapter.id)?.fragments ?? []).map(
        (fragment, fragmentIndex) => ({
          chapterId: chapter.id,
          fragmentIndex,
          fragment,
        }),
      ),
    );
  }

  getRequirements(): string[] {
    return [...(this.config.customRequirements ?? [])];
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
      const firstStepId = this.pipeline.steps[0]!.id;
      if (!fragment.fragment.pipelineStates[firstStepId]) {
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
          !fragment.fragment.pipelineStates[step.id]
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
    const readyItems = this.listReadyWorkItems(stepId);
    if (readyItems.length === 0) {
      return [];
    }

    const now = new Date().toISOString();
    await this.documentManager.updatePipelineStepStates(
      readyItems.map((item) => ({
        chapterId: item.chapterId,
        fragmentIndex: item.fragmentIndex,
        stepId: item.stepId,
        state: {
          ...this.documentManager.getPipelineStepState(
            item.chapterId,
            item.fragmentIndex,
            item.stepId,
          )!,
          status: "running",
          attemptCount:
            (this.documentManager.getPipelineStepState(
              item.chapterId,
              item.fragmentIndex,
              item.stepId,
            )?.attemptCount ?? 0) + 1,
          startedAt: now,
          updatedAt: now,
          lastRunId: item.runId,
          errorMessage: undefined,
        },
      })),
    );

    return readyItems;
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
      requirements: [
        ...this.getRequirements(),
        ...(step.requirements ?? []),
      ],
      metadata,
    };
  }

  private buildQueueEntrySnapshot(
    stepId: string,
    entry: TranslationStepQueueEntry,
  ): TranslationStepQueueEntrySnapshot {
    const stepState = this.documentManager.getPipelineStepState(
      entry.chapterId,
      entry.fragmentIndex,
      stepId,
    );
    const resolution =
      entry.status === "queued" ? this.resolveStepDependencies(stepId, entry) : undefined;
    const canBuildWorkItem =
      entry.status === "queued" &&
      Boolean(resolution?.ready) &&
      this.projectState.lifecycle.status === "running";
    const workItem =
      canBuildWorkItem
        ? this.buildWorkItem(stepId, entry, resolution!)
        : undefined;

    return {
      stepId,
      chapterId: entry.chapterId,
      fragmentIndex: entry.fragmentIndex,
      queueSequence: entry.queueSequence,
      status: entry.status,
      attemptCount: stepState?.attemptCount ?? 0,
      queuedAt: stepState?.queuedAt,
      startedAt: stepState?.startedAt,
      completedAt: stepState?.completedAt,
      updatedAt: stepState?.updatedAt,
      runId: stepState?.lastRunId,
      sourceText: this.documentManager.getSourceText(entry.chapterId, entry.fragmentIndex),
      translatedText: this.documentManager.getTranslatedText(entry.chapterId, entry.fragmentIndex),
      inputText:
        workItem?.inputText ??
        this.buildInputPreview(stepId, entry.chapterId, entry.fragmentIndex),
      outputText: stepState?.output ? fragmentToText(stepState.output) : undefined,
      dependencyMode:
        workItem?.metadata.dependencyMode === "previousTranslations" ||
        workItem?.metadata.dependencyMode === "glossaryTerms"
          ? workItem.metadata.dependencyMode
          : undefined,
      readyToDispatch: entry.status === "queued" ? Boolean(resolution?.ready) : false,
      blockedReason:
        entry.status === "queued" && !resolution?.ready ? resolution?.reason : undefined,
      errorMessage: entry.errorMessage,
      metadata: workItem?.metadata ?? (resolution?.metadata ?? {}),
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

    await this.documentManager.updatePipelineStepState(
      chapterId,
      fragmentIndex,
      stepId,
      {
        status: "queued",
        queueSequence: this.allocateQueueSequence(stepId),
        attemptCount: 0,
        queuedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    );
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

  private async recoverInterruptedRunIfNeeded(): Promise<void> {
    const lifecycleStatus = this.projectState.lifecycle.status;
    const hasRunningEntries = this.listAllQueueEntries().some((entry) => entry.status === "running");
    if (
      !hasRunningEntries &&
      lifecycleStatus !== "running" &&
      lifecycleStatus !== "stopping"
    ) {
      return;
    }

    if (hasRunningEntries) {
      await this.requeueRunningWorkItems("translation_interrupted");
    }

    const now = new Date().toISOString();
    await this.updateLifecycleState({
      status: this.listAllQueueEntries().some((entry) => entry.status === "queued")
        ? "interrupted"
        : "completed",
      currentRunId: undefined,
      interruptedAt: hasRunningEntries ? now : this.projectState.lifecycle.interruptedAt,
      stopRequestedAt: undefined,
      stoppedAt: hasRunningEntries ? now : this.projectState.lifecycle.stoppedAt,
      updatedAt: now,
    });
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
  }

  private async refreshLifecycleState(): Promise<void> {
    const lifecycle = this.projectState.lifecycle;
    const now = new Date().toISOString();
    const hasQueuedWork = this.listAllQueueEntries().some((entry) => entry.status === "queued");
    const hasRunningWork = this.listAllQueueEntries().some((entry) => entry.status === "running");
    const isCompleted = this.getOrderedFragments().every((fragment) =>
      this.isStepCompleted(fragment.chapterId, fragment.fragmentIndex, this.pipeline.finalStepId),
    );

    if (isCompleted) {
      await this.updateLifecycleState({
        status: "completed",
        currentRunId: undefined,
        stopRequestedAt: undefined,
        stoppedAt: lifecycle.stoppedAt,
        completedAt: lifecycle.completedAt ?? now,
        updatedAt: now,
      });
      return;
    }

    if (lifecycle.status === "stopping" && !hasRunningWork) {
      await this.updateLifecycleState({
        status: "stopped",
        currentRunId: undefined,
        stopRequestedAt: undefined,
        stoppedAt: now,
        updatedAt: now,
      });
      return;
    }

    if (
      lifecycle.status === "completed" &&
      (hasQueuedWork || hasRunningWork)
    ) {
      await this.updateLifecycleState({
        status: "stopped",
        completedAt: undefined,
        updatedAt: now,
      });
    }
  }

  private async updateLifecycleState(
    patch: Partial<TranslationProjectState["lifecycle"]>,
  ): Promise<void> {
    const nextStatus = patch.status ?? this.projectState.lifecycle.status;
    this.projectState = {
      ...this.projectState,
      pipeline: {
        stepIds: this.pipeline.steps.map((step) => step.id),
        finalStepId: this.pipeline.finalStepId,
      },
      lifecycle: {
        ...this.projectState.lifecycle,
        ...patch,
        status: nextStatus,
      },
    };
    await this.persistProjectState();
  }

  private async persistProjectState(): Promise<void> {
    await this.documentManager.saveProjectState(this.projectState);
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

  private createDefaultPipelineDefinition(): TranslationPipelineDefinition {
    return {
      steps: [
        {
          id: "translation",
          description: "最终翻译",
          buildInput: ({ chapterId, fragmentIndex, runtime }) =>
            runtime.getSourceText(chapterId, fragmentIndex),
          resolveDependencies: ({ chapterId, fragmentIndex, stepId, runtime }) => {
            const dependencyMode = this.resolveTranslationDependencyMode(
              chapterId,
              fragmentIndex,
              stepId,
              runtime.getOrderedFragments(),
            );

            return dependencyMode
              ? {
                  ready: true,
                  metadata: { dependencyMode },
                }
              : {
                  ready: false,
                  reason: this.getTranslationDependencyBlockedReason(
                    chapterId,
                    fragmentIndex,
                    stepId,
                    runtime.getOrderedFragments(),
                  ),
                };
          },
          buildContextView: ({ chapterId, fragmentIndex, metadata }) => {
            const dependencyMode = metadata.dependencyMode;
            if (
              dependencyMode !== "previousTranslations" &&
              dependencyMode !== "glossaryTerms"
            ) {
              return undefined;
            }

            return new TranslationContextView(chapterId, fragmentIndex, {
              documentManager: this.documentManager,
              stepId: "translation",
              dependencyMode,
              traversalChapters: this.getTraversalChapters(),
              glossary: this.glossary,
              glossaryConfig: this.config.glossary,
            });
          },
        },
      ],
    };
  }

  private resolveTranslationDependencyMode(
    chapterId: number,
    fragmentIndex: number,
    stepId: string,
    orderedFragments: OrderedFragmentSnapshot[],
  ): TranslationDependencyMode | undefined {
    const currentIndex = orderedFragments.findIndex(
      (fragment) =>
        fragment.chapterId === chapterId &&
        fragment.fragmentIndex === fragmentIndex,
    );
    if (currentIndex === -1) {
      throw new Error(`文本块不存在: chapter=${chapterId}, fragment=${fragmentIndex}`);
    }

    if (
      orderedFragments
        .slice(0, currentIndex)
        .every((fragment) =>
          this.isStepCompleted(fragment.chapterId, fragment.fragmentIndex, stepId),
        )
    ) {
      return "previousTranslations";
    }

    const matchedGlossaryTerms = this.glossary?.filterTerms(
      this.documentManager.getSourceText(chapterId, fragmentIndex),
    ) ?? [];
    const hasCompletedPeer = orderedFragments.some(
      (fragment) =>
        !(fragment.chapterId === chapterId && fragment.fragmentIndex === fragmentIndex) &&
        this.isStepCompleted(fragment.chapterId, fragment.fragmentIndex, stepId),
    );
    if (
      hasCompletedPeer &&
      matchedGlossaryTerms.length > 0 &&
      matchedGlossaryTerms.every((term) => term.status === "translated")
    ) {
      return "glossaryTerms";
    }

    return undefined;
  }

  private getTranslationDependencyBlockedReason(
    chapterId: number,
    fragmentIndex: number,
    stepId: string,
    orderedFragments: OrderedFragmentSnapshot[],
  ): string {
    const currentIndex = orderedFragments.findIndex(
      (fragment) =>
        fragment.chapterId === chapterId &&
        fragment.fragmentIndex === fragmentIndex,
    );
    if (currentIndex === -1) {
      return "fragment_not_found";
    }

    const hasUnfinishedPreviousFragments = orderedFragments
      .slice(0, currentIndex)
      .some((fragment) => !this.isStepCompleted(fragment.chapterId, fragment.fragmentIndex, stepId));
    if (!this.glossary) {
      return hasUnfinishedPreviousFragments
        ? "waiting_for_previous_fragments"
        : "waiting_for_glossary";
    }

    const matchedGlossaryTerms = this.glossary.filterTerms(
      this.documentManager.getSourceText(chapterId, fragmentIndex),
    );
    if (matchedGlossaryTerms.length === 0) {
      return hasUnfinishedPreviousFragments
        ? "waiting_for_previous_fragments"
        : "waiting_for_glossary_terms";
    }

    const untranslatedTerms = matchedGlossaryTerms.filter((term) => term.status !== "translated");
    if (untranslatedTerms.length > 0) {
      return "waiting_for_translated_glossary_terms";
    }

    const hasCompletedPeer = orderedFragments.some(
      (fragment) =>
        !(fragment.chapterId === chapterId && fragment.fragmentIndex === fragmentIndex) &&
        this.isStepCompleted(fragment.chapterId, fragment.fragmentIndex, stepId),
    );
    if (!hasCompletedPeer) {
      return "waiting_for_completed_peer";
    }

    return "waiting_for_step_dependencies";
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("项目尚未初始化，请先调用 initialize()");
    }
  }
}

function resolveChapterPath(projectDir: string, path: string): string {
  return resolve(projectDir, path);
}

function createDefaultProjectState(pipeline: TranslationPipeline): TranslationProjectState {
  return {
    schemaVersion: 1,
    pipeline: {
      stepIds: pipeline.steps.map((step) => step.id),
      finalStepId: pipeline.finalStepId,
    },
    lifecycle: {
      status: "idle",
    },
  };
}

function normalizeProjectStateForPipeline(
  state: TranslationProjectState,
  pipeline: TranslationPipeline,
): TranslationProjectState {
  return {
    ...state,
    schemaVersion: 1,
    pipeline: {
      stepIds: pipeline.steps.map((step) => step.id),
      finalStepId: pipeline.finalStepId,
    },
  };
}

function upsertGlobalPatternTerm(
  glossary: Glossary,
  pattern: GlobalAssociationPattern,
): void {
  const existing = glossary.getTerm(pattern.text);
  if (!existing) {
    glossary.addTerm({
      term: pattern.text,
      translation: "",
      status: "untranslated",
      totalOccurrenceCount: pattern.occurrenceCount,
      description: "全局关联模式",
    });
    return;
  }

  glossary.updateTerm(pattern.text, {
    ...existing,
    description: existing.description ?? "全局关联模式",
    totalOccurrenceCount: pattern.occurrenceCount,
  });
}

function collectSourceTextBlocks(
  documentManager: TranslationDocumentManager,
  chapters: Chapter[],
): Array<{ blockId: string; text: string }> {
  return chapters.flatMap((chapter) =>
    (documentManager.getChapterById(chapter.id)?.fragments ?? []).map((fragment, fragmentIndex) => ({
      blockId: `chapter:${chapter.id}:fragment:${fragmentIndex}`,
      text: fragment.source.lines.join("\n"),
    })),
  );
}
