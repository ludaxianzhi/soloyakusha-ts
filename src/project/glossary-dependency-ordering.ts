import type { PipelineDependencyResolution, TranslationStepQueueEntry } from "./pipeline.ts";
import type {
  TranslationDependencyGraph,
  TranslationDependencyNode,
  WorkItemMetadata,
} from "./types.ts";
import type {
  ReadyOrderingItem,
  TranslationOrderingContext,
  TranslationOrderingStrategy,
} from "./translation-ordering-strategy.ts";

type ResolvedDependencyState = {
  dependencyMode?: "previousTranslations" | "glossaryTerms";
  reason?: string;
};

type TranslationDependencyRuntimeState = {
  readonly stepId: "translation";
  readonly nodeById: Map<string, TranslationDependencyNode>;
  readonly orderedNodeIds: string[];
  readonly readyNodeIds: Set<string>;
  readonly readyMetadataByNodeId: Map<string, WorkItemMetadata>;
  readonly runningNodeIds: Set<string>;
  readonly completedNodeIds: Set<string>;
  readonly glossaryTermsByNodeId: Map<string, string[]>;
  readonly nodeIdsByGlossaryTerm: Map<string, string[]>;
  readonly reservedGlossaryTermsByNodeId: Map<string, string[]>;
  readonly glossaryTermOwnerNodeIds: Map<string, Set<string>>;
  readonly glossarySatisfiedSupportersByNodeId: Map<string, Map<string, number>>;
  readonly glossaryDependentsBySupporterNodeId: Map<
    string,
    Array<{ nodeId: string; term: string }>
  >;
  readonly nodeIdsByRequiredPrecedingCount: Map<number, string[]>;
  contiguousCompletedPrefix: number;
};

function createDependencyNodeId(stepId: string, chapterId: number, fragmentIndex: number): string {
  return `${stepId}:${chapterId}:${fragmentIndex}`;
}

export class GlossaryDependencyOrderingStrategy implements TranslationOrderingStrategy {
  private context?: TranslationOrderingContext;
  private dependencyGraph: TranslationDependencyGraph | null = null;
  private dependencyRuntimeState: TranslationDependencyRuntimeState | null = null;

  handlesStep(stepId: string): boolean {
    return stepId === "translation";
  }

  setContext(context: TranslationOrderingContext): void {
    this.context = context;
  }

  async initializeForRun(stepId: string): Promise<void> {
    if (!this.handlesStep(stepId)) {
      return;
    }

    await this.ensureDependencyGraphUpToDate();
    this.initializeDependencyRuntimeState();
  }

  async listReadyItems(
    stepId: string,
    queuedEntries: TranslationStepQueueEntry[],
  ): Promise<ReadyOrderingItem[] | undefined> {
    if (!this.handlesStep(stepId)) {
      return undefined;
    }

    if (this.dependencyRuntimeState?.stepId === "translation") {
      return [...this.dependencyRuntimeState.readyNodeIds]
        .map((nodeId) => {
          const node = this.dependencyRuntimeState?.nodeById.get(nodeId);
          if (!node) {
            return undefined;
          }

          const stepState = this.getContext().getStepState(node.chapterId, node.fragmentIndex, stepId);
          if (!stepState || stepState.status !== "queued") {
            return undefined;
          }

          const metadata = this.dependencyRuntimeState?.readyMetadataByNodeId.get(nodeId);
          if (!metadata) {
            return undefined;
          }

          return {
            stepId,
            chapterId: node.chapterId,
            fragmentIndex: node.fragmentIndex,
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

    await this.ensureDependencyGraphUpToDate();
    return queuedEntries
      .map((entry) => {
        const resolution = this.resolveDependencies(stepId, entry);
        if (!resolution?.ready || !resolution.metadata) {
          return undefined;
        }

        return {
          stepId,
          chapterId: entry.chapterId,
          fragmentIndex: entry.fragmentIndex,
          metadata: resolution.metadata,
        } satisfies ReadyOrderingItem;
      })
      .filter((item): item is ReadyOrderingItem => item !== undefined);
  }

  selectDispatchableItems(stepId: string, readyItems: ReadyOrderingItem[]): ReadyOrderingItem[] {
    if (!this.handlesStep(stepId) || !this.dependencyRuntimeState) {
      return readyItems;
    }

    const selectedItems: ReadyOrderingItem[] = [];
    const selectedTerms = new Set<string>();
    for (const item of readyItems) {
      const nodeId = createDependencyNodeId(item.stepId, item.chapterId, item.fragmentIndex);
      const reservedTerms = this.getRuntimeExclusiveGlossaryTerms(nodeId);
      if (reservedTerms.some((term) => selectedTerms.has(term))) {
        continue;
      }

      selectedItems.push(item);
      for (const term of reservedTerms) {
        selectedTerms.add(term);
      }
    }

    return selectedItems;
  }

  resolveDependencies(
    stepId: string,
    entry: TranslationStepQueueEntry,
  ): PipelineDependencyResolution | undefined {
    const graphResolution = this.resolveDependenciesFromGraph(
      stepId,
      entry.chapterId,
      entry.fragmentIndex,
    );
    if (!graphResolution) {
      return undefined;
    }

    return graphResolution.dependencyMode
      ? {
          ready: true,
          metadata: {
            dependencyMode: graphResolution.dependencyMode,
          },
        }
      : {
          ready: false,
          reason: graphResolution.reason,
        };
  }

  onItemStarted(stepId: string, chapterId: number, fragmentIndex: number): void {
    const runtimeState = this.dependencyRuntimeState;
    if (!runtimeState || stepId !== "translation") {
      return;
    }

    const nodeId = createDependencyNodeId(stepId, chapterId, fragmentIndex);
    runtimeState.readyNodeIds.delete(nodeId);
    runtimeState.readyMetadataByNodeId.delete(nodeId);
    runtimeState.runningNodeIds.add(nodeId);
    const reservedTerms = this.reserveNodeGlossaryTermsInDependencyRuntime(nodeId);
    this.refreshRuntimeReadinessForGlossaryTerms(reservedTerms);
  }

  onItemCompleted(stepId: string, chapterId: number, fragmentIndex: number): void {
    const runtimeState = this.dependencyRuntimeState;
    if (!runtimeState || stepId !== "translation") {
      return;
    }

    const nodeId = createDependencyNodeId(stepId, chapterId, fragmentIndex);
    const node = runtimeState.nodeById.get(nodeId);
    if (!node || runtimeState.completedNodeIds.has(nodeId)) {
      return;
    }

    runtimeState.runningNodeIds.delete(nodeId);
    const releasedTerms = this.releaseNodeGlossaryTermsInDependencyRuntime(nodeId);
    runtimeState.readyNodeIds.delete(nodeId);
    runtimeState.readyMetadataByNodeId.delete(nodeId);
    runtimeState.completedNodeIds.add(nodeId);

    const previousPrefix = runtimeState.contiguousCompletedPrefix;
    if (node.orderedIndex === previousPrefix) {
      while (
        runtimeState.orderedNodeIds[runtimeState.contiguousCompletedPrefix] &&
        runtimeState.completedNodeIds.has(
          runtimeState.orderedNodeIds[runtimeState.contiguousCompletedPrefix]!,
        )
      ) {
        runtimeState.contiguousCompletedPrefix += 1;
      }

      for (
        let requiredPrecedingCount = previousPrefix + 1;
        requiredPrecedingCount <= runtimeState.contiguousCompletedPrefix;
        requiredPrecedingCount += 1
      ) {
        for (const dependentNodeId of runtimeState.nodeIdsByRequiredPrecedingCount.get(requiredPrecedingCount) ?? []) {
          this.refreshDependencyRuntimeNodeReadiness(dependentNodeId);
        }
      }

      for (
        let orderedIndex = previousPrefix;
        orderedIndex <= runtimeState.contiguousCompletedPrefix;
        orderedIndex += 1
      ) {
        const dependentNodeId = runtimeState.orderedNodeIds[orderedIndex];
        if (dependentNodeId) {
          this.refreshDependencyRuntimeNodeReadiness(dependentNodeId);
        }
      }
    }

    for (const dependent of runtimeState.glossaryDependentsBySupporterNodeId.get(nodeId) ?? []) {
      const supporterCounts = runtimeState.glossarySatisfiedSupportersByNodeId.get(dependent.nodeId);
      if (supporterCounts) {
        supporterCounts.set(dependent.term, (supporterCounts.get(dependent.term) ?? 0) + 1);
      }
      this.refreshDependencyRuntimeNodeReadiness(dependent.nodeId);
    }

    this.refreshRuntimeReadinessForGlossaryTerms(releasedTerms);
  }

  onItemRequeued(stepId: string, chapterId: number, fragmentIndex: number): void {
    const runtimeState = this.dependencyRuntimeState;
    if (!runtimeState || stepId !== "translation") {
      return;
    }

    const nodeId = createDependencyNodeId(stepId, chapterId, fragmentIndex);
    runtimeState.runningNodeIds.delete(nodeId);
    const releasedTerms = this.releaseNodeGlossaryTermsInDependencyRuntime(nodeId);
    this.refreshDependencyRuntimeNodeReadiness(nodeId);
    this.refreshRuntimeReadinessForGlossaryTerms(releasedTerms);
  }

  async invalidate(): Promise<void> {
    this.dependencyGraph = null;
    this.dependencyRuntimeState = null;
    await this.getContext().clearDependencyGraph();
  }

  private getContext(): TranslationOrderingContext {
    if (!this.context) {
      throw new Error("Translation ordering strategy context has not been initialized");
    }

    return this.context;
  }

  private async ensureDependencyGraphUpToDate(): Promise<void> {
    const revisions = this.getContext().getDependencyTrackingRevisions();
    if (
      this.dependencyGraph &&
      this.dependencyGraph.sourceRevision === revisions.sourceRevision &&
      this.dependencyGraph.glossaryRevision === revisions.glossaryRevision
    ) {
      return;
    }

    const persistedGraph = await this.getContext().loadDependencyGraph();
    if (
      persistedGraph &&
      persistedGraph.stepId === "translation" &&
      persistedGraph.sourceRevision === revisions.sourceRevision &&
      persistedGraph.glossaryRevision === revisions.glossaryRevision
    ) {
      this.dependencyGraph = persistedGraph;
      return;
    }

    const nextGraph = this.buildTranslationDependencyGraph();
    await this.getContext().saveDependencyGraph(nextGraph);
    this.dependencyGraph = nextGraph;
  }

  private initializeDependencyRuntimeState(): void {
    if (this.dependencyGraph?.stepId !== "translation") {
      this.dependencyRuntimeState = null;
      return;
    }

    const nodeById = new Map<string, TranslationDependencyNode>();
    const orderedNodeIds: string[] = [];
    const readyNodeIds = new Set<string>();
    const readyMetadataByNodeId = new Map<string, WorkItemMetadata>();
    const runningNodeIds = new Set<string>();
    const completedNodeIds = new Set<string>();
    const glossaryTermsByNodeId = new Map<string, string[]>();
    const nodeIdsByGlossaryTerm = new Map<string, string[]>();
    const reservedGlossaryTermsByNodeId = new Map<string, string[]>();
    const glossaryTermOwnerNodeIds = new Map<string, Set<string>>();
    const glossarySatisfiedSupportersByNodeId = new Map<string, Map<string, number>>();
    const glossaryDependentsBySupporterNodeId = new Map<string, Array<{ nodeId: string; term: string }>>();
    const nodeIdsByRequiredPrecedingCount = new Map<number, string[]>();

    for (const node of this.dependencyGraph.nodes) {
      nodeById.set(node.nodeId, node);
      orderedNodeIds[node.orderedIndex] = node.nodeId;
      const stepState = this.getContext().getStepState(node.chapterId, node.fragmentIndex, node.stepId);
      if (stepState?.status === "completed") {
        completedNodeIds.add(node.nodeId);
      } else if (stepState?.status === "running") {
        runningNodeIds.add(node.nodeId);
      }

      const requiredNodes = nodeIdsByRequiredPrecedingCount.get(node.requiredPrecedingCount) ?? [];
      requiredNodes.push(node.nodeId);
      nodeIdsByRequiredPrecedingCount.set(node.requiredPrecedingCount, requiredNodes);

      const glossaryTerms = [...new Set(node.glossarySupportGroups.map((group) => group.term))];
      glossaryTermsByNodeId.set(node.nodeId, glossaryTerms);
      for (const term of glossaryTerms) {
        const nodeIds = nodeIdsByGlossaryTerm.get(term) ?? [];
        nodeIds.push(node.nodeId);
        nodeIdsByGlossaryTerm.set(term, nodeIds);
      }
    }

    for (const node of this.dependencyGraph.nodes) {
      const supporterCounts = new Map<string, number>();
      for (const group of node.glossarySupportGroups) {
        let completedSupporters = 0;
        for (const supporterNodeId of group.supporterNodeIds) {
          if (completedNodeIds.has(supporterNodeId)) {
            completedSupporters += 1;
          }

          const dependents = glossaryDependentsBySupporterNodeId.get(supporterNodeId) ?? [];
          dependents.push({ nodeId: node.nodeId, term: group.term });
          glossaryDependentsBySupporterNodeId.set(supporterNodeId, dependents);
        }

        supporterCounts.set(group.term, completedSupporters);
      }
      glossarySatisfiedSupportersByNodeId.set(node.nodeId, supporterCounts);
    }

    let contiguousCompletedPrefix = 0;
    while (orderedNodeIds[contiguousCompletedPrefix] && completedNodeIds.has(orderedNodeIds[contiguousCompletedPrefix]!)) {
      contiguousCompletedPrefix += 1;
    }

    this.dependencyRuntimeState = {
      stepId: "translation",
      nodeById,
      orderedNodeIds,
      readyNodeIds,
      readyMetadataByNodeId,
      runningNodeIds,
      completedNodeIds,
      glossaryTermsByNodeId,
      nodeIdsByGlossaryTerm,
      reservedGlossaryTermsByNodeId,
      glossaryTermOwnerNodeIds,
      glossarySatisfiedSupportersByNodeId,
      glossaryDependentsBySupporterNodeId,
      nodeIdsByRequiredPrecedingCount,
      contiguousCompletedPrefix,
    };

    for (const nodeId of runningNodeIds) {
      this.reserveNodeGlossaryTermsInDependencyRuntime(nodeId);
    }

    for (const nodeId of orderedNodeIds) {
      if (nodeId) {
        this.refreshDependencyRuntimeNodeReadiness(nodeId);
      }
    }
  }

  private buildTranslationDependencyGraph(): TranslationDependencyGraph {
    const orderedFragments = this.getContext().getOrderedFragments();
    const sourceTexts = orderedFragments.map((fragment) =>
      this.getContext().getSourceText(fragment.chapterId, fragment.fragmentIndex),
    );
    const matchedTermsByIndex = orderedFragments.map((fragment, orderedIndex) =>
      [...new Set(this.getContext().filterGlossaryTerms(sourceTexts[orderedIndex] ?? ""))],
    );
    const uniqueTerms = [...new Set(matchedTermsByIndex.flatMap((terms) => terms))];
    const supporterNodeIdsByTerm = new Map<string, string[]>();

    for (const term of uniqueTerms) {
      supporterNodeIdsByTerm.set(
        term,
        orderedFragments
          .filter((_fragment, orderedIndex) => (sourceTexts[orderedIndex] ?? "").includes(term))
          .map((fragment) =>
            createDependencyNodeId("translation", fragment.chapterId, fragment.fragmentIndex),
          ),
      );
    }

    const revisions = this.getContext().getDependencyTrackingRevisions();
    return {
      schemaVersion: 1,
      stepId: "translation",
      sourceRevision: revisions.sourceRevision,
      glossaryRevision: revisions.glossaryRevision,
      builtAt: new Date().toISOString(),
      nodes: orderedFragments.map((fragment, orderedIndex) => {
        const nodeId = createDependencyNodeId("translation", fragment.chapterId, fragment.fragmentIndex);
        return {
          nodeId,
          stepId: "translation",
          chapterId: fragment.chapterId,
          fragmentIndex: fragment.fragmentIndex,
          orderedIndex,
          requiredPrecedingCount: Math.floor((orderedIndex + 1) / 2),
          glossarySupportGroups: matchedTermsByIndex[orderedIndex]!.map((term) => ({
            term,
            supporterNodeIds: (supporterNodeIdsByTerm.get(term) ?? []).filter(
              (supporterNodeId) => supporterNodeId !== nodeId,
            ),
          })),
        } satisfies TranslationDependencyNode;
      }),
    };
  }

  private resolveDependenciesFromGraph(
    stepId: string,
    chapterId: number,
    fragmentIndex: number,
  ): ResolvedDependencyState | undefined {
    if (stepId !== "translation" || !this.dependencyGraph) {
      return undefined;
    }

    const nodeId = createDependencyNodeId(stepId, chapterId, fragmentIndex);
    const runtimeResolution = this.resolveDependenciesFromRuntimeState(nodeId);
    if (runtimeResolution) {
      return runtimeResolution;
    }

    const node = this.dependencyGraph.nodes.find((currentNode) => currentNode.nodeId === nodeId);
    if (!node) {
      return undefined;
    }

    const hasCompletedAllPrevious = this.dependencyGraph.nodes
      .slice(0, node.orderedIndex)
      .every((previousNode) =>
        this.getContext().isStepCompleted(previousNode.chapterId, previousNode.fragmentIndex, stepId),
      );
    if (hasCompletedAllPrevious) {
      return { dependencyMode: "previousTranslations" };
    }

    if (node.glossarySupportGroups.length === 0) {
      return { reason: "waiting_for_previous_fragments" };
    }

    const hasCompletedRequiredPreceding = this.dependencyGraph.nodes
      .slice(0, node.requiredPrecedingCount)
      .every((previousNode) =>
        this.getContext().isStepCompleted(previousNode.chapterId, previousNode.fragmentIndex, stepId),
      );
    if (!hasCompletedRequiredPreceding) {
      return { reason: "waiting_for_preceding_fragments" };
    }

    const allSupportGroupsSatisfied = node.glossarySupportGroups.every((group) =>
      group.supporterNodeIds.some((supporterNodeId) => {
        const supporter = this.dependencyGraph?.nodes.find(
          (currentNode) => currentNode.nodeId === supporterNodeId,
        );
        return supporter
          ? this.getContext().isStepCompleted(supporter.chapterId, supporter.fragmentIndex, stepId)
          : false;
      }),
    );

    return allSupportGroupsSatisfied
      ? { dependencyMode: "glossaryTerms" }
      : { reason: "waiting_for_terms_in_translations" };
  }

  private resolveDependenciesFromRuntimeState(nodeId: string): ResolvedDependencyState | undefined {
    const runtimeState = this.dependencyRuntimeState;
    if (!runtimeState || runtimeState.stepId !== "translation") {
      return undefined;
    }

    const node = runtimeState.nodeById.get(nodeId);
    if (!node) {
      return undefined;
    }

    const stepState = this.getContext().getStepState(node.chapterId, node.fragmentIndex, node.stepId);
    if (!stepState || stepState.status !== "queued") {
      return undefined;
    }

    if (runtimeState.contiguousCompletedPrefix >= node.orderedIndex) {
      return this.hasRuntimeGlossaryTermConflict(nodeId)
        ? { reason: "waiting_for_glossary_term_release" }
        : { dependencyMode: "previousTranslations" };
    }

    if (node.glossarySupportGroups.length === 0) {
      return { reason: "waiting_for_previous_fragments" };
    }

    if (runtimeState.contiguousCompletedPrefix < node.requiredPrecedingCount) {
      return { reason: "waiting_for_preceding_fragments" };
    }

    const supporterCounts = runtimeState.glossarySatisfiedSupportersByNodeId.get(node.nodeId);
    const allSupportGroupsSatisfied = node.glossarySupportGroups.every(
      (group) => (supporterCounts?.get(group.term) ?? 0) > 0,
    );
    if (!allSupportGroupsSatisfied) {
      return { reason: "waiting_for_terms_in_translations" };
    }

    return this.hasRuntimeGlossaryTermConflict(nodeId)
      ? { reason: "waiting_for_glossary_term_release" }
      : { dependencyMode: "glossaryTerms" };
  }

  private refreshDependencyRuntimeNodeReadiness(nodeId: string): void {
    const runtimeState = this.dependencyRuntimeState;
    if (!runtimeState) {
      return;
    }

    const resolution = this.resolveDependenciesFromRuntimeState(nodeId);
    if (resolution?.dependencyMode) {
      runtimeState.readyNodeIds.add(nodeId);
      runtimeState.readyMetadataByNodeId.set(nodeId, {
        dependencyMode: resolution.dependencyMode,
      });
      return;
    }

    runtimeState.readyNodeIds.delete(nodeId);
    runtimeState.readyMetadataByNodeId.delete(nodeId);
  }

  private getRuntimeExclusiveGlossaryTerms(nodeId: string): string[] {
    const runtimeState = this.dependencyRuntimeState;
    if (!runtimeState) {
      return [];
    }

    return (runtimeState.glossaryTermsByNodeId.get(nodeId) ?? []).filter(
      (term) => this.getContext().getGlossaryTermStatus(term) === "untranslated",
    );
  }

  private hasRuntimeGlossaryTermConflict(nodeId: string): boolean {
    const runtimeState = this.dependencyRuntimeState;
    if (!runtimeState) {
      return false;
    }

    return this.getRuntimeExclusiveGlossaryTerms(nodeId).some((term) =>
      [...(runtimeState.glossaryTermOwnerNodeIds.get(term) ?? [])].some(
        (ownerNodeId) => ownerNodeId !== nodeId,
      ),
    );
  }

  private reserveNodeGlossaryTermsInDependencyRuntime(nodeId: string): string[] {
    const runtimeState = this.dependencyRuntimeState;
    if (!runtimeState) {
      return [];
    }

    const reservedTerms = this.getRuntimeExclusiveGlossaryTerms(nodeId);
    runtimeState.reservedGlossaryTermsByNodeId.set(nodeId, reservedTerms);
    for (const term of reservedTerms) {
      const ownerNodeIds = runtimeState.glossaryTermOwnerNodeIds.get(term) ?? new Set<string>();
      ownerNodeIds.add(nodeId);
      runtimeState.glossaryTermOwnerNodeIds.set(term, ownerNodeIds);
    }

    return reservedTerms;
  }

  private releaseNodeGlossaryTermsInDependencyRuntime(nodeId: string): string[] {
    const runtimeState = this.dependencyRuntimeState;
    if (!runtimeState) {
      return [];
    }

    const reservedTerms = runtimeState.reservedGlossaryTermsByNodeId.get(nodeId) ?? [];
    runtimeState.reservedGlossaryTermsByNodeId.delete(nodeId);
    for (const term of reservedTerms) {
      const ownerNodeIds = runtimeState.glossaryTermOwnerNodeIds.get(term);
      if (!ownerNodeIds) {
        continue;
      }

      ownerNodeIds.delete(nodeId);
      if (ownerNodeIds.size === 0) {
        runtimeState.glossaryTermOwnerNodeIds.delete(term);
      }
    }

    return reservedTerms;
  }

  private refreshRuntimeReadinessForGlossaryTerms(terms: ReadonlyArray<string>): void {
    const runtimeState = this.dependencyRuntimeState;
    if (!runtimeState || terms.length === 0) {
      return;
    }

    const nodeIds = new Set<string>();
    for (const term of terms) {
      for (const nodeId of runtimeState.nodeIdsByGlossaryTerm.get(term) ?? []) {
        nodeIds.add(nodeId);
      }
    }

    for (const nodeId of nodeIds) {
      this.refreshDependencyRuntimeNodeReadiness(nodeId);
    }
  }
}