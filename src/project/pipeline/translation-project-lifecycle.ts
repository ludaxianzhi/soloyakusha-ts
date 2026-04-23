import { randomUUID } from "node:crypto";
import type { OrderedFragmentSnapshot, TranslationPipeline, TranslationStepQueueEntry } from "./pipeline.ts";
import type {
  TranslationProjectLifecycleSnapshot,
  TranslationProjectState,
  TranslationStopMode,
} from "../types.ts";

type LifecycleStatePatch = Partial<TranslationProjectState["lifecycle"]>;

type TranslationProjectLifecycleManagerOptions = {
  pipeline: TranslationPipeline;
  getProjectState: () => TranslationProjectState;
  setProjectState: (state: TranslationProjectState) => void;
  persistProjectState: () => Promise<void>;
  listAllQueueEntries: () => TranslationStepQueueEntry[];
  getOrderedFragments: () => OrderedFragmentSnapshot[];
  isStepCompleted: (chapterId: number, fragmentIndex: number, stepId: string) => boolean;
  requeueRunningWorkItems: (errorMessage: string) => Promise<void>;
};

export class TranslationProjectLifecycleManager {
  constructor(private readonly options: TranslationProjectLifecycleManagerOptions) {}

  getLifecycleSnapshot(): TranslationProjectLifecycleSnapshot {
    const allEntries = this.options.listAllQueueEntries();
    const queuedWorkItems = allEntries.filter((entry) => entry.status === "queued").length;
    const activeWorkItems = allEntries.filter((entry) => entry.status === "running").length;
    const status = this.options.getProjectState().lifecycle.status;

    return {
      ...this.options.getProjectState().lifecycle,
      hasPendingWork: queuedWorkItems > 0 || activeWorkItems > 0,
      queuedWorkItems,
      activeWorkItems,
      canStart:
        status !== "running" &&
        status !== "stopping" &&
        (queuedWorkItems > 0 || status === "interrupted" || status === "aborted"),
      canStop: status === "running" || status === "stopping",
      canAbort: status === "running" || status === "stopping",
      canResume: status === "interrupted" || status === "aborted" || status === "stopped",
      canSave: queuedWorkItems > 0 || activeWorkItems > 0 || status === "completed",
    };
  }

  async startTranslation(): Promise<TranslationProjectLifecycleSnapshot> {
    const lifecycle = this.options.getProjectState().lifecycle;
    if (lifecycle.status === "running" || lifecycle.status === "stopping") {
      throw new Error(`翻译流程已处于${lifecycle.status}状态，不能重复启动`);
    }

    await this.recoverInterruptedRunIfNeeded();
    await this.refreshLifecycleState();
    if (!this.options.listAllQueueEntries().some((entry) => entry.status === "queued")) {
      return this.getLifecycleSnapshot();
    }

    const now = new Date().toISOString();
    await this.updateLifecycleState({
      status: "running",
      currentRunId: randomUUID(),
      startedAt: now,
      stopRequestedAt: undefined,
      stoppedAt: undefined,
      completedAt: undefined,
      abortedAt: undefined,
      abortReason: undefined,
      updatedAt: now,
    });
    return this.getLifecycleSnapshot();
  }

  async stopTranslation(
    options: { mode?: TranslationStopMode } = {},
  ): Promise<TranslationProjectLifecycleSnapshot> {
    const mode = options.mode ?? "graceful";
    const lifecycle = this.options.getProjectState().lifecycle;
    if (lifecycle.status !== "running" && lifecycle.status !== "stopping") {
      return this.getLifecycleSnapshot();
    }

    if (mode === "immediate") {
      await this.options.requeueRunningWorkItems("translation_interrupted");
      const now = new Date().toISOString();
      await this.updateLifecycleState({
        status: "stopped",
        currentRunId: undefined,
        stopRequestedAt: undefined,
        stoppedAt: now,
        updatedAt: now,
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

  async abortTranslation(reason = "translation_aborted"): Promise<TranslationProjectLifecycleSnapshot> {
    const lifecycle = this.options.getProjectState().lifecycle;
    if (lifecycle.status !== "running" && lifecycle.status !== "stopping") {
      return this.getLifecycleSnapshot();
    }

    await this.options.requeueRunningWorkItems(reason);
    const now = new Date().toISOString();
    await this.updateLifecycleState({
      status: "aborted",
      currentRunId: undefined,
      stopRequestedAt: undefined,
      stoppedAt: now,
      abortedAt: now,
      abortReason: reason,
      updatedAt: now,
    });
    return this.getLifecycleSnapshot();
  }

  async markProgressSaved(): Promise<void> {
    const now = new Date().toISOString();
    await this.updateLifecycleState({
      lastSavedAt: now,
      updatedAt: now,
    });
  }

  async recoverInterruptedRunIfNeeded(): Promise<void> {
    const lifecycleStatus = this.options.getProjectState().lifecycle.status;
    const hasRunningEntries = this.options.listAllQueueEntries().some((entry) => entry.status === "running");
    if (
      !hasRunningEntries &&
      lifecycleStatus !== "running" &&
      lifecycleStatus !== "stopping"
    ) {
      return;
    }

    if (hasRunningEntries) {
      await this.options.requeueRunningWorkItems("translation_interrupted");
    }

    const now = new Date().toISOString();
    await this.updateLifecycleState({
      status: this.options.listAllQueueEntries().some((entry) => entry.status === "queued")
        ? "interrupted"
        : "completed",
      currentRunId: undefined,
      interruptedAt: hasRunningEntries ? now : this.options.getProjectState().lifecycle.interruptedAt,
      stopRequestedAt: undefined,
      stoppedAt: hasRunningEntries ? now : this.options.getProjectState().lifecycle.stoppedAt,
      updatedAt: now,
    });
  }

  async refreshLifecycleState(): Promise<void> {
    const lifecycle = this.options.getProjectState().lifecycle;
    const now = new Date().toISOString();
    const allEntries = this.options.listAllQueueEntries();
    const hasQueuedWork = allEntries.some((entry) => entry.status === "queued");
    const hasRunningWork = allEntries.some((entry) => entry.status === "running");
    const isCompleted = this.options.getOrderedFragments().every((fragment) =>
      this.options.isStepCompleted(
        fragment.chapterId,
        fragment.fragmentIndex,
        this.options.pipeline.finalStepId,
      ),
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

    if (lifecycle.status === "completed" && (hasQueuedWork || hasRunningWork)) {
      await this.updateLifecycleState({
        status: "stopped",
        completedAt: undefined,
        updatedAt: now,
      });
    }
  }

  private async updateLifecycleState(patch: LifecycleStatePatch): Promise<void> {
    const nextStatus = patch.status ?? this.options.getProjectState().lifecycle.status;
    this.options.setProjectState({
      ...this.options.getProjectState(),
      pipeline: {
        stepIds: this.options.pipeline.steps.map((step) => step.id),
        finalStepId: this.options.pipeline.finalStepId,
      },
      lifecycle: {
        ...this.options.getProjectState().lifecycle,
        ...patch,
        status: nextStatus,
      },
    });
    await this.options.persistProjectState();
  }
}

export function createDefaultProjectState(pipeline: TranslationPipeline): TranslationProjectState {
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

export function normalizeProjectStateForPipeline(
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
