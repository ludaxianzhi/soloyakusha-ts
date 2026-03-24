/**
 * 定义翻译项目域模型中的核心类型与数据结构。
 *
 * 本模块包含：
 * - 翻译单元与片段的层级结构定义
 * - Pipeline 步骤状态
 * - 章节与项目的配置接口
 * - 上下文与进度统计类
 */

export type TranslationUnitMetadata = Record<string, string> | string | null;

export type TranslationUnit = {
  source: string;
  target: string[];
  metadata?: TranslationUnitMetadata;
};

export type TextFragment = {
  lines: string[];
};

export type WorkItemMetadataValue = string | number | boolean;

export type WorkItemMetadata = Record<string, WorkItemMetadataValue>;

export type FragmentMeta = {
  metadataList: TranslationUnitMetadata[];
  targetGroups?: string[][];
};

export type PipelineStepStatus = "queued" | "running" | "completed";
export type TranslationRunStatus =
  | "idle"
  | "running"
  | "stopping"
  | "stopped"
  | "completed"
  | "interrupted";
export type TranslationStopMode = "graceful" | "immediate";

export type FragmentPipelineStepState = {
  status: PipelineStepStatus;
  queueSequence: number;
  attemptCount: number;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  lastRunId?: string;
  output?: TextFragment;
  errorMessage?: string;
};

export type FragmentEntry = {
  source: TextFragment;
  translation: TextFragment;
  pipelineStates: Record<string, FragmentPipelineStepState>;
  meta?: FragmentMeta;
  hash: string;
};

export type ChapterEntry = {
  id: number;
  filePath: string;
  fragments: FragmentEntry[];
};

export type Chapter = {
  id: number;
  filePath: string;
};

export type GlossarySettings = {
  path?: string;
  autoFilter?: boolean;
};

export type TranslationProjectConfig = {
  projectName: string;
  projectDir: string;
  chapters: Chapter[];
  glossary?: GlossarySettings;
  customRequirements?: string[];
};

export type TranslationUnitParser = (content: string) => TranslationUnit[];

export type TranslationUnitSplitter = {
  split(units: TranslationUnit[]): TranslationUnit[][];
};

export type SlidingWindowOptions = {
  overlapChars?: number;
};

export type SlidingWindowFragmentLine = {
  unitIndex: number;
  fragmentIndex: number;
  lineIndex: number;
  source: string;
  translation: string;
};

export type SlidingWindowFragment = {
  chapterId: number;
  fragmentIndex: number;
  source: TextFragment;
  translation: TextFragment;
  lines: SlidingWindowFragmentLine[];
  focusLineStart: number;
  focusLineEnd: number;
};

export type ContextPair = {
  chapterId: number;
  fragmentIndex: number;
  fragmentHash: string;
  sourceText: string;
  translatedText: string;
};

export type TranslationDependencyMode = "previousTranslations" | "glossaryTerms";

export type TranslationContextType = "glossary" | "dependencyTranslation";

export type GlossaryContextEntry = {
  type: "glossary";
  description: string;
  priority: number;
  content: string;
};

export type DependencyPairContextEntry = {
  type: "dependencyTranslation";
  description: string;
  priority: number;
  pairs: ContextPair[];
};

export type TranslationContextEntry = GlossaryContextEntry | DependencyPairContextEntry;

export type ProjectCursor = {
  chapterId?: number;
  fragmentIndex?: number;
};

export type TranslationProjectLifecycleState = {
  status: TranslationRunStatus;
  currentRunId?: string;
  startedAt?: string;
  stopRequestedAt?: string;
  stoppedAt?: string;
  completedAt?: string;
  interruptedAt?: string;
  updatedAt?: string;
};

export type TranslationProjectState = {
  schemaVersion: 1;
  pipeline: {
    stepIds: string[];
    finalStepId: string;
  };
  lifecycle: TranslationProjectLifecycleState;
};

export type TranslationProjectLifecycleSnapshot = TranslationProjectLifecycleState & {
  hasPendingWork: boolean;
  queuedWorkItems: number;
  activeWorkItems: number;
  canStart: boolean;
  canStop: boolean;
};

export type TranslationStepQueueEntrySnapshot = {
  stepId: string;
  chapterId: number;
  fragmentIndex: number;
  queueSequence: number;
  status: PipelineStepStatus;
  attemptCount: number;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  runId?: string;
  sourceText: string;
  translatedText: string;
  inputText: string;
  outputText?: string;
  dependencyMode?: TranslationDependencyMode;
  readyToDispatch: boolean;
  blockedReason?: string;
  errorMessage?: string;
  metadata: WorkItemMetadata;
};

export type TranslationStepProgressSnapshot = {
  stepId: string;
  description: string;
  isFinalStep: boolean;
  totalFragments: number;
  queuedFragments: number;
  runningFragments: number;
  completedFragments: number;
  readyFragments: number;
  waitingFragments: number;
  completionRatio: number;
};

export type TranslationStepQueueSnapshot = {
  stepId: string;
  description: string;
  isFinalStep: boolean;
  progress: TranslationStepProgressSnapshot;
  entries: TranslationStepQueueEntrySnapshot[];
};

export type GlossaryProgressSnapshot = {
  totalTerms: number;
  translatedTerms: number;
  untranslatedTerms: number;
};

export type ProjectProgressSnapshot = {
  totalChapters: number;
  translatedChapters: number;
  totalFragments: number;
  translatedFragments: number;
  currentChapterId?: number;
  currentFragmentIndex?: number;
  fragmentProgressRatio: number;
  chapterProgressRatio: number;
};

export type TranslationProjectSnapshot = {
  projectName: string;
  currentCursor: ProjectCursor;
  lifecycle: TranslationProjectLifecycleSnapshot;
  progress: ProjectProgressSnapshot;
  glossary?: GlossaryProgressSnapshot;
  pipeline: {
    stepCount: number;
    finalStepId: string;
    steps: Array<{
      id: string;
      description: string;
      isFinalStep: boolean;
    }>;
  };
  queueSnapshots: TranslationStepQueueSnapshot[];
  activeWorkItems: TranslationStepQueueEntrySnapshot[];
  readyWorkItems: TranslationStepQueueEntrySnapshot[];
};

/**
 * 项目进度对象，统计最终翻译步骤的完成度。
 */
export class ProjectProgress {
  constructor(
    readonly totalChapters = 0,
    readonly translatedChapters = 0,
    readonly totalFragments = 0,
    readonly translatedFragments = 0,
    readonly currentChapterId?: number,
    readonly currentFragmentIndex?: number,
  ) {}

  get fragmentProgressRatio(): number {
    if (this.totalFragments === 0) {
      return 0;
    }

    return this.translatedFragments / this.totalFragments;
  }

  get chapterProgressRatio(): number {
    if (this.totalChapters === 0) {
      return 0;
    }

    return this.translatedChapters / this.totalChapters;
  }
}

export function createTextFragment(input: string | string[]): TextFragment {
  return {
    lines: Array.isArray(input) ? input : input.split("\n"),
  };
}

export function fragmentToText(fragment: TextFragment): string {
  return fragment.lines.join("\n");
}
