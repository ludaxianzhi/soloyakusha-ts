import type {
  PipelineDependencyResolution,
  TranslationStepQueueEntry,
} from "./pipeline.ts";
import type {
  TranslationDependencyGraph,
  TranslationProjectConfig,
  WorkItemMetadata,
} from "./types.ts";
import type { ContextNetworkData } from "./context-network-types.ts";
import type { StoryTopology } from "./story-topology.ts";

export type ReadyOrderingItem = {
  stepId: string;
  chapterId: number;
  fragmentIndex: number;
  metadata: WorkItemMetadata;
};

export type TranslationOrderingContext = {
  readonly config: TranslationProjectConfig;
  getOrderedFragments: () => Array<{ chapterId: number; fragmentIndex: number }>;
  getStoryTopology: () => StoryTopology | undefined;
  getSourceText: (chapterId: number, fragmentIndex: number) => string;
  getStepState: (chapterId: number, fragmentIndex: number, stepId: string) => {
    status: "queued" | "running" | "completed";
    queueSequence: number;
    attemptCount?: number;
    errorMessage?: string;
  } | undefined;
  isStepCompleted: (chapterId: number, fragmentIndex: number, stepId: string) => boolean;
  getGlossaryTermStatus: (term: string) => "translated" | "untranslated" | undefined;
  filterGlossaryTerms: (text: string) => string[];
  getDependencyTrackingRevisions: () => { sourceRevision: number; glossaryRevision: number };
  loadDependencyGraph: () => Promise<TranslationDependencyGraph | null>;
  saveDependencyGraph: (graph: TranslationDependencyGraph) => Promise<void>;
  clearDependencyGraph: () => Promise<void>;
  loadContextNetwork: () => Promise<ContextNetworkData | null>;
  saveContextNetwork: (network: ContextNetworkData) => Promise<void>;
  clearContextNetwork: () => Promise<void>;
};

export interface TranslationOrderingStrategy {
  handlesStep(stepId: string): boolean;
  setContext(context: TranslationOrderingContext): void;
  initializeForRun(stepId: string): Promise<void>;
  listReadyItems(
    stepId: string,
    queuedEntries: TranslationStepQueueEntry[],
  ): Promise<ReadyOrderingItem[] | undefined>;
  selectDispatchableItems(
    stepId: string,
    readyItems: ReadyOrderingItem[],
  ): ReadyOrderingItem[];
  resolveDependencies?(
    stepId: string,
    entry: TranslationStepQueueEntry,
  ): PipelineDependencyResolution | undefined;
  onItemStarted(stepId: string, chapterId: number, fragmentIndex: number): void;
  onItemCompleted(stepId: string, chapterId: number, fragmentIndex: number): void;
  onItemRequeued(stepId: string, chapterId: number, fragmentIndex: number): void;
  invalidate(): Promise<void>;
}