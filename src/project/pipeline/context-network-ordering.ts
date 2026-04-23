import type { PipelineDependencyResolution, TranslationStepQueueEntry } from "./pipeline.ts";
import type { ContextNetworkData } from "../context/context-network-types.ts";
import type { StoryTopology } from "../context/story-topology.ts";
import type { WorkItemMetadata } from "../types.ts";
import type {
  ReadyOrderingItem,
  TranslationOrderingContext,
  TranslationOrderingStrategy,
} from "./translation-ordering-strategy.ts";

type OrderedFragmentRef = {
  chapterId: number;
  fragmentIndex: number;
};

type ContextNetworkRuntimeState = {
  readonly stepId: "translation";
  readonly network: ContextNetworkData;
  readonly orderedFragments: OrderedFragmentRef[];
  readonly globalIndexByNodeId: Map<string, number>;
  readonly chapterTotalFragments: Map<number, number>;
  readonly chapterCompletedCount: Map<number, number>;
  readonly predecessorChapterIdsByChapter: Map<number, number[]>;
  readonly readyNodeIds: Set<string>;
  readonly readyMetadataByNodeId: Map<string, WorkItemMetadata>;
  readonly runningNodeIds: Set<string>;
  readonly completedNodeIds: Set<string>;
};

const TRANSLATION_STEP_ID = "translation";

export class ContextNetworkOrderingStrategy implements TranslationOrderingStrategy {
  private context?: TranslationOrderingContext;
  private runtimeState: ContextNetworkRuntimeState | null = null;

  constructor(private readonly maxContextNetworkRefs = 3) {}

  handlesStep(stepId: string): boolean {
    return stepId === TRANSLATION_STEP_ID;
  }

  setContext(context: TranslationOrderingContext): void {
    this.context = context;
  }

  async initializeForRun(stepId: string): Promise<void> {
    if (!this.handlesStep(stepId)) {
      return;
    }

    this.runtimeState = await this.createRuntimeState();
  }

  async listReadyItems(
    stepId: string,
    queuedEntries: TranslationStepQueueEntry[],
  ): Promise<ReadyOrderingItem[] | undefined> {
    if (!this.handlesStep(stepId)) {
      return undefined;
    }

    const runtimeState = this.getRuntimeState();
    if (!runtimeState) {
      return undefined;
    }

    return [...runtimeState.readyNodeIds]
      .map((nodeId) => {
        const fragment = getFragmentByNodeId(runtimeState, nodeId);
        if (!fragment) {
          return undefined;
        }

        const queuedEntry = queuedEntries.find(
          (entry) =>
            entry.chapterId === fragment.chapterId &&
            entry.fragmentIndex === fragment.fragmentIndex &&
            entry.stepId === stepId,
        );
        if (!queuedEntry) {
          return undefined;
        }

        const metadata = runtimeState.readyMetadataByNodeId.get(nodeId);
        if (!metadata) {
          return undefined;
        }

        return {
          stepId,
          chapterId: fragment.chapterId,
          fragmentIndex: fragment.fragmentIndex,
          metadata,
        } satisfies ReadyOrderingItem;
      })
      .filter((item): item is ReadyOrderingItem => item !== undefined)
      .sort((left, right) => {
        const leftState = this.getContext().getStepState(left.chapterId, left.fragmentIndex, left.stepId);
        const rightState = this.getContext().getStepState(
          right.chapterId,
          right.fragmentIndex,
          right.stepId,
        );
        return (leftState?.queueSequence ?? 0) - (rightState?.queueSequence ?? 0);
      });
  }

  selectDispatchableItems(_stepId: string, readyItems: ReadyOrderingItem[]): ReadyOrderingItem[] {
    return readyItems;
  }

  resolveDependencies(
    stepId: string,
    entry: TranslationStepQueueEntry,
  ): PipelineDependencyResolution | undefined {
    if (!this.handlesStep(stepId)) {
      return undefined;
    }

    const runtimeState = this.getRuntimeState();
    if (!runtimeState) {
      return undefined;
    }

    const nodeId = createNodeId(stepId, entry.chapterId, entry.fragmentIndex);
    const globalIndex = runtimeState.globalIndexByNodeId.get(nodeId);
    if (globalIndex === undefined) {
      return {
        ready: false,
        reason: "fragment_not_found",
      };
    }

    const stepState = this.getContext().getStepState(entry.chapterId, entry.fragmentIndex, stepId);
    if (!stepState || stepState.status !== "queued") {
      return {
        ready: false,
        reason: "step_not_queued",
      };
    }

    return this.isNodeReady(runtimeState, globalIndex)
      ? {
          ready: true,
          metadata: this.buildMetadata(runtimeState, globalIndex),
        }
      : {
          ready: false,
          reason: this.getBlockedReason(runtimeState, globalIndex),
        };
  }

  onItemStarted(stepId: string, chapterId: number, fragmentIndex: number): void {
    const runtimeState = this.getRuntimeState();
    if (!runtimeState || stepId !== TRANSLATION_STEP_ID) {
      return;
    }

    const nodeId = createNodeId(stepId, chapterId, fragmentIndex);
    runtimeState.readyNodeIds.delete(nodeId);
    runtimeState.readyMetadataByNodeId.delete(nodeId);
    runtimeState.runningNodeIds.add(nodeId);
  }

  onItemCompleted(stepId: string, chapterId: number, fragmentIndex: number): void {
    const runtimeState = this.getRuntimeState();
    if (!runtimeState || stepId !== TRANSLATION_STEP_ID) {
      return;
    }

    const nodeId = createNodeId(stepId, chapterId, fragmentIndex);
    if (runtimeState.completedNodeIds.has(nodeId)) {
      return;
    }

    runtimeState.runningNodeIds.delete(nodeId);
    runtimeState.readyNodeIds.delete(nodeId);
    runtimeState.readyMetadataByNodeId.delete(nodeId);
    runtimeState.completedNodeIds.add(nodeId);
    runtimeState.chapterCompletedCount.set(
      chapterId,
      (runtimeState.chapterCompletedCount.get(chapterId) ?? 0) + 1,
    );

    this.refreshNodeReadiness(runtimeState, chapterId, fragmentIndex + 1);

    if (this.isChapterCompleted(runtimeState, chapterId)) {
      for (const [candidateChapterId, predecessorChapterIds] of runtimeState.predecessorChapterIdsByChapter) {
        if (predecessorChapterIds.includes(chapterId)) {
          this.refreshNodeReadiness(runtimeState, candidateChapterId, 0);
        }
      }
    }
  }

  onItemRequeued(stepId: string, chapterId: number, fragmentIndex: number): void {
    const runtimeState = this.getRuntimeState();
    if (!runtimeState || stepId !== TRANSLATION_STEP_ID) {
      return;
    }

    const nodeId = createNodeId(stepId, chapterId, fragmentIndex);
    runtimeState.runningNodeIds.delete(nodeId);
    this.refreshNodeReadiness(runtimeState, chapterId, fragmentIndex);
  }

  async invalidate(): Promise<void> {
    this.runtimeState = null;
  }

  private getContext(): TranslationOrderingContext {
    if (!this.context) {
      throw new Error("Translation ordering strategy context has not been initialized");
    }

    return this.context;
  }

  private getRuntimeState(): ContextNetworkRuntimeState | null {
    return this.runtimeState;
  }

  private async createRuntimeState(): Promise<ContextNetworkRuntimeState> {
    const context = this.getContext();
    const network = await context.loadContextNetwork();
    if (!network) {
      throw new Error("上下文网络不存在，请先构建并保存 context network 后再启动该翻译模式");
    }

    const { sourceRevision } = context.getDependencyTrackingRevisions();
    if (network.manifest.sourceRevision !== sourceRevision) {
      throw new Error(
        `上下文网络已过期: network.sourceRevision=${network.manifest.sourceRevision}, current.sourceRevision=${sourceRevision}`,
      );
    }
    if (network.manifest.blockSize !== 1) {
      throw new Error(
        `上下文网络 blockSize=${network.manifest.blockSize} 不兼容；当前翻译模式仅支持 blockSize=1`,
      );
    }

    const orderedFragments = context.getOrderedFragments();
    if (network.manifest.fragmentCount !== orderedFragments.length) {
      throw new Error(
        `上下文网络 fragmentCount 不匹配: network=${network.manifest.fragmentCount}, current=${orderedFragments.length}`,
      );
    }

    const topology = context.getStoryTopology();
    const chapterTotalFragments = new Map<number, number>();
    const chapterCompletedCount = new Map<number, number>();
    const predecessorChapterIdsByChapter = buildPredecessorChapterIdsByChapter(
      orderedFragments,
      topology,
    );
    const globalIndexByNodeId = new Map<string, number>();
    const readyNodeIds = new Set<string>();
    const readyMetadataByNodeId = new Map<string, WorkItemMetadata>();
    const runningNodeIds = new Set<string>();
    const completedNodeIds = new Set<string>();

    for (const fragment of orderedFragments) {
      chapterTotalFragments.set(
        fragment.chapterId,
        (chapterTotalFragments.get(fragment.chapterId) ?? 0) + 1,
      );
      chapterCompletedCount.set(fragment.chapterId, chapterCompletedCount.get(fragment.chapterId) ?? 0);
    }

    orderedFragments.forEach((fragment, globalIndex) => {
      const nodeId = createNodeId(TRANSLATION_STEP_ID, fragment.chapterId, fragment.fragmentIndex);
      globalIndexByNodeId.set(nodeId, globalIndex);

      const stepState = context.getStepState(fragment.chapterId, fragment.fragmentIndex, TRANSLATION_STEP_ID);
      if (stepState?.status === "completed") {
        completedNodeIds.add(nodeId);
        chapterCompletedCount.set(
          fragment.chapterId,
          (chapterCompletedCount.get(fragment.chapterId) ?? 0) + 1,
        );
      } else if (stepState?.status === "running") {
        runningNodeIds.add(nodeId);
      }
    });

    const runtimeState: ContextNetworkRuntimeState = {
      stepId: TRANSLATION_STEP_ID,
      network,
      orderedFragments,
      globalIndexByNodeId,
      chapterTotalFragments,
      chapterCompletedCount,
      predecessorChapterIdsByChapter,
      readyNodeIds,
      readyMetadataByNodeId,
      runningNodeIds,
      completedNodeIds,
    };

    orderedFragments.forEach((fragment) => {
      this.refreshNodeReadiness(runtimeState, fragment.chapterId, fragment.fragmentIndex);
    });

    return runtimeState;
  }

  private refreshNodeReadiness(
    runtimeState: ContextNetworkRuntimeState,
    chapterId: number,
    fragmentIndex: number,
  ): void {
    const nodeId = createNodeId(TRANSLATION_STEP_ID, chapterId, fragmentIndex);
    const globalIndex = runtimeState.globalIndexByNodeId.get(nodeId);
    if (globalIndex === undefined) {
      return;
    }

    const stepState = this.getContext().getStepState(chapterId, fragmentIndex, TRANSLATION_STEP_ID);
    if (!stepState || stepState.status !== "queued") {
      runtimeState.readyNodeIds.delete(nodeId);
      runtimeState.readyMetadataByNodeId.delete(nodeId);
      return;
    }

    if (this.isNodeReady(runtimeState, globalIndex)) {
      runtimeState.readyNodeIds.add(nodeId);
      runtimeState.readyMetadataByNodeId.set(nodeId, this.buildMetadata(runtimeState, globalIndex));
      return;
    }

    runtimeState.readyNodeIds.delete(nodeId);
    runtimeState.readyMetadataByNodeId.delete(nodeId);
  }

  private isNodeReady(runtimeState: ContextNetworkRuntimeState, globalIndex: number): boolean {
    const fragment = runtimeState.orderedFragments[globalIndex];
    if (!fragment) {
      return false;
    }

    return (
      this.isChapterUnlocked(runtimeState, fragment.chapterId) &&
      (fragment.fragmentIndex === 0 ||
        this.getContext().isStepCompleted(
          fragment.chapterId,
          fragment.fragmentIndex - 1,
          TRANSLATION_STEP_ID,
        ))
    );
  }

  private isChapterUnlocked(runtimeState: ContextNetworkRuntimeState, chapterId: number): boolean {
    const predecessorChapterIds = runtimeState.predecessorChapterIdsByChapter.get(chapterId) ?? [];
    return predecessorChapterIds.every((predecessorChapterId) =>
      this.isChapterCompleted(runtimeState, predecessorChapterId),
    );
  }

  private isChapterCompleted(runtimeState: ContextNetworkRuntimeState, chapterId: number): boolean {
    return (
      (runtimeState.chapterCompletedCount.get(chapterId) ?? 0) >=
      (runtimeState.chapterTotalFragments.get(chapterId) ?? 0)
    );
  }

  private buildMetadata(
    runtimeState: ContextNetworkRuntimeState,
    globalIndex: number,
  ): WorkItemMetadata {
    return {
      dependencyMode: "contextNetwork",
      networkContextGlobalIndices: this.getTopNetworkRefIndices(runtimeState, globalIndex).join(","),
    };
  }

  private getTopNetworkRefIndices(
    runtimeState: ContextNetworkRuntimeState,
    globalIndex: number,
  ): number[] {
    const fragment = runtimeState.orderedFragments[globalIndex];
    if (!fragment) {
      return [];
    }

    const predecessorChapterIds = new Set(
      runtimeState.predecessorChapterIdsByChapter.get(fragment.chapterId) ?? [],
    );
    const startOffset = runtimeState.network.offsets[globalIndex] ?? 0;
    const endOffset = runtimeState.network.offsets[globalIndex + 1] ?? startOffset;
    const candidates: Array<{ globalIndex: number; strength: number }> = [];

    for (let offset = startOffset; offset < endOffset; offset += 1) {
      const candidateGlobalIndex = runtimeState.network.targets[offset];
      const strength = runtimeState.network.strengths[offset];
      if (candidateGlobalIndex === undefined || strength === undefined) {
        continue;
      }

      const candidate = runtimeState.orderedFragments[candidateGlobalIndex];
      if (!candidate) {
        continue;
      }

      const sameChapterPredecessor =
        candidate.chapterId === fragment.chapterId &&
        candidate.fragmentIndex < fragment.fragmentIndex;
      const predecessorChapter = predecessorChapterIds.has(candidate.chapterId);
      if (!sameChapterPredecessor && !predecessorChapter) {
        continue;
      }

      candidates.push({ globalIndex: candidateGlobalIndex, strength });
    }

    candidates.sort(
      (left, right) => right.strength - left.strength || left.globalIndex - right.globalIndex,
    );

    return candidates.slice(0, this.maxContextNetworkRefs).map((candidate) => candidate.globalIndex);
  }

  private getBlockedReason(runtimeState: ContextNetworkRuntimeState, globalIndex: number): string {
    const fragment = runtimeState.orderedFragments[globalIndex];
    if (!fragment) {
      return "fragment_not_found";
    }

    if (!this.isChapterUnlocked(runtimeState, fragment.chapterId)) {
      return "waiting_for_predecessor_chapters";
    }
    if (
      fragment.fragmentIndex > 0 &&
      !this.getContext().isStepCompleted(
        fragment.chapterId,
        fragment.fragmentIndex - 1,
        TRANSLATION_STEP_ID,
      )
    ) {
      return "waiting_for_previous_fragment";
    }

    return "waiting_for_context_network";
  }
}

function buildPredecessorChapterIdsByChapter(
  orderedFragments: OrderedFragmentRef[],
  topology: StoryTopology | undefined,
): Map<number, number[]> {
  const chapterIds = [...new Set(orderedFragments.map((fragment) => fragment.chapterId))];
  const predecessorChapterIdsByChapter = new Map<number, number[]>();

  for (const chapterId of chapterIds) {
    predecessorChapterIdsByChapter.set(
      chapterId,
      topology?.getPredecessorChapterIds(chapterId) ?? fallbackPredecessorChapterIds(chapterIds, chapterId),
    );
  }

  return predecessorChapterIdsByChapter;
}

function fallbackPredecessorChapterIds(chapterIds: number[], chapterId: number): number[] {
  const index = chapterIds.indexOf(chapterId);
  return index <= 0 ? [] : chapterIds.slice(0, index);
}

function createNodeId(stepId: string, chapterId: number, fragmentIndex: number): string {
  return `${stepId}:${chapterId}:${fragmentIndex}`;
}

function getFragmentByNodeId(
  runtimeState: ContextNetworkRuntimeState,
  nodeId: string,
): OrderedFragmentRef | undefined {
  const globalIndex = runtimeState.globalIndexByNodeId.get(nodeId);
  return globalIndex === undefined ? undefined : runtimeState.orderedFragments[globalIndex];
}