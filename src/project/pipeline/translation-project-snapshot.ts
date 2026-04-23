import type { Glossary } from "../../glossary/glossary.ts";
import type {
  OrderedFragmentSnapshot,
  PipelineDependencyResolution,
  TranslationPipeline,
  TranslationStepQueueEntry,
  TranslationWorkItem,
} from "./pipeline.ts";
import type { TranslationDocumentManager } from "../document/translation-document-manager.ts";
import type {
  Chapter,
  GlossaryProgressSnapshot,
  ProjectCursor,
  ProjectProgressSnapshot,
  TranslationProjectLifecycleSnapshot,
  TranslationProjectSnapshot,
  TranslationStepProgressSnapshot,
  TranslationStepQueueEntrySnapshot,
  TranslationStepQueueSnapshot,
} from "../types.ts";
import { ProjectProgress, fragmentToText } from "../types.ts";

type TranslationProjectSnapshotBuilderOptions = {
  projectName: string;
  pipeline: TranslationPipeline;
  documentManager: TranslationDocumentManager;
  getGlossary: () => Glossary | undefined;
  getTraversalChapters: () => Chapter[];
  getOrderedFragments: () => OrderedFragmentSnapshot[];
  listStepQueueEntries: (stepId: string) => TranslationStepQueueEntry[];
  listAllQueueEntries: () => TranslationStepQueueEntry[];
  getCurrentCursor: () => ProjectCursor;
  isStepCompleted: (chapterId: number, fragmentIndex: number, stepId: string) => boolean;
  getLifecycleSnapshot: () => TranslationProjectLifecycleSnapshot;
  resolveStepDependencies: (
    stepId: string,
    entry: TranslationStepQueueEntry,
  ) => PipelineDependencyResolution;
  buildWorkItem: (
    stepId: string,
    entry: TranslationStepQueueEntry,
    resolution: PipelineDependencyResolution,
  ) => TranslationWorkItem;
  buildInputPreview: (stepId: string, chapterId: number, fragmentIndex: number) => string;
};

export class TranslationProjectSnapshotBuilder {
  constructor(private readonly options: TranslationProjectSnapshotBuilderOptions) {}

  getProgress(): ProjectProgress {
    const orderedFragments = this.options.getOrderedFragments();
    const translatedFragments = orderedFragments.filter((fragment) =>
      this.options.isStepCompleted(
        fragment.chapterId,
        fragment.fragmentIndex,
        this.options.pipeline.finalStepId,
      ),
    ).length;
    const totalFragments = orderedFragments.length;

    let translatedChapters = 0;
    for (const chapter of this.options.getTraversalChapters()) {
      const fragmentCount = this.options.documentManager.getChapterFragmentCount(chapter.id);
      if (fragmentCount === 0) {
        continue;
      }

      if (
        Array.from({ length: fragmentCount }, (_value, fragmentIndex) => fragmentIndex).every(
          (fragmentIndex) =>
            this.options.isStepCompleted(chapter.id, fragmentIndex, this.options.pipeline.finalStepId),
        )
      ) {
        translatedChapters += 1;
      }
    }

    const cursor = this.options.getCurrentCursor();
    return new ProjectProgress(
      this.options.getTraversalChapters().length,
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
    const glossary = this.options.getGlossary();
    if (!glossary) {
      return undefined;
    }

    const terms = glossary.getAllTerms();
    const translatedTerms = terms.filter((term) => term.status === "translated").length;
    return {
      totalTerms: terms.length,
      translatedTerms,
      untranslatedTerms: terms.length - translatedTerms,
    };
  }

  getStepProgress(stepId: string): TranslationStepProgressSnapshot {
    const step = this.options.pipeline.getStep(stepId);
    const entries = this.options.listStepQueueEntries(stepId);
    const readyEntries = entries.filter((entry) => entry.status === "queued").filter((entry) =>
      this.options.resolveStepDependencies(stepId, entry).ready,
    );
    const queuedFragments = entries.filter((entry) => entry.status === "queued").length;
    const runningFragments = entries.filter((entry) => entry.status === "running").length;
    const completedFragments = entries.filter((entry) => entry.status === "completed").length;
    const totalFragments = this.options.getOrderedFragments().length;

    return {
      stepId,
      description: step.description,
      isFinalStep: stepId === this.options.pipeline.finalStepId,
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
    const step = this.options.pipeline.getStep(stepId);
    return {
      stepId,
      description: step.description,
      isFinalStep: stepId === this.options.pipeline.finalStepId,
      progress: this.getStepProgress(stepId),
      entries: this.options.listStepQueueEntries(stepId).map((entry) =>
        this.buildQueueEntrySnapshot(stepId, entry),
      ),
    };
  }

  getQueueSnapshots(): TranslationStepQueueSnapshot[] {
    return this.options.pipeline.steps.map((step) => this.getQueueSnapshot(step.id));
  }

  getActiveWorkItems(stepId?: string): TranslationStepQueueEntrySnapshot[] {
    const stepIds = stepId
      ? [stepId]
      : this.options.pipeline.steps.map((step) => step.id);
    return stepIds.flatMap((currentStepId) =>
      this.options.listStepQueueEntries(currentStepId)
        .filter((entry) => entry.status === "running")
        .map((entry) => this.buildQueueEntrySnapshot(currentStepId, entry)),
    );
  }

  getReadyWorkItemSnapshots(stepId?: string): TranslationStepQueueEntrySnapshot[] {
    const stepIds = stepId
      ? [stepId]
      : this.options.pipeline.steps.map((step) => step.id);
    return stepIds.flatMap((currentStepId) =>
      this.options.listStepQueueEntries(currentStepId)
        .filter((entry) => entry.status === "queued")
        .map((entry) => this.buildQueueEntrySnapshot(currentStepId, entry))
        .filter((entry) => entry.readyToDispatch),
    );
  }

  getProjectSnapshot(): TranslationProjectSnapshot {
    return {
      projectName: this.options.projectName,
      currentCursor: this.options.getCurrentCursor(),
      lifecycle: this.options.getLifecycleSnapshot(),
      progress: this.getProgressSnapshot(),
      glossary: this.getGlossaryProgress(),
      pipeline: {
        stepCount: this.options.pipeline.steps.length,
        finalStepId: this.options.pipeline.finalStepId,
        steps: this.options.pipeline.steps.map((step) => ({
          id: step.id,
          description: step.description,
          isFinalStep: step.id === this.options.pipeline.finalStepId,
        })),
      },
      queueSnapshots: this.getQueueSnapshots(),
      activeWorkItems: this.getActiveWorkItems(),
      readyWorkItems: this.getReadyWorkItemSnapshots(),
    };
  }

  private buildQueueEntrySnapshot(
    stepId: string,
    entry: TranslationStepQueueEntry,
  ): TranslationStepQueueEntrySnapshot {
    const stepState = this.options.documentManager.getPipelineStepState(
      entry.chapterId,
      entry.fragmentIndex,
      stepId,
    );
    const resolution =
      entry.status === "queued"
        ? this.options.resolveStepDependencies(stepId, entry)
        : undefined;
    const lifecycle = this.options.getLifecycleSnapshot();
    const canBuildWorkItem =
      entry.status === "queued" &&
      Boolean(resolution?.ready) &&
      lifecycle.status === "running";
    const workItem =
      canBuildWorkItem
        ? this.options.buildWorkItem(stepId, entry, resolution!)
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
      sourceText: this.options.documentManager.getSourceText(entry.chapterId, entry.fragmentIndex),
      translatedText: this.options.documentManager.getTranslatedText(
        entry.chapterId,
        entry.fragmentIndex,
      ),
      inputText:
        workItem?.inputText ??
        this.options.buildInputPreview(stepId, entry.chapterId, entry.fragmentIndex),
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
}
