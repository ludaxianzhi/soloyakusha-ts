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
  | "aborted"
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
  textSplitMaxChars?: number;
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

export type TranslationDependencyMode =
  | "previousTranslations"
  | "glossaryTerms"
  | "contextNetwork";

export type TranslationContextType =
  | "glossary"
  | "dependencyTranslation"
  | "plotSummary";

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

export type PlotSummaryContextEntry = {
  type: "plotSummary";
  description: string;
  priority: number;
  summaries: string[];
};

export type TranslationContextEntry =
  | GlossaryContextEntry
  | DependencyPairContextEntry
  | PlotSummaryContextEntry;

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
  abortedAt?: string;
  abortReason?: string;
  completedAt?: string;
  interruptedAt?: string;
  lastSavedAt?: string;
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
  canAbort: boolean;
  canResume: boolean;
  canSave: boolean;
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

// ===== Workspace Config Types =====

/**
 * 工作区翻译器配置，指定当前项目使用的命名翻译器。
 *
 * 职责边界：
 * - 全局配置（GlobalConfigManager）：LLM profiles、API keys、endpoints、命名翻译器目录
 * - 工作区配置（WorkspaceTranslatorConfig）：当前项目引用的翻译器名称
 */
export type WorkspaceTranslatorConfig = {
  /** 引用全局翻译器目录中的翻译器名称。 */
  translatorName?: string;
  /** @deprecated 旧格式兼容字段，新项目请使用 translatorName。 */
  modelName?: string;
  /** @deprecated 旧格式兼容字段，新项目请使用 translatorName。 */
  workflow?: string;
};

/**
 * 工作区滑动窗口配置。
 */
export type WorkspaceSlidingWindowConfig = {
  overlapChars?: number;
};

export type WorkspaceDependencyTrackingConfig = {
  sourceRevision: number;
  glossaryRevision: number;
};

/**
 * 工作区配置文件的完整结构。
 *
 * 存储翻译项目的所有非数据设置。翻译单元和术语条目
 * 分别存储在章节数据文件和术语表文件中。
 *
 * 与全局配置的职责边界：
 * - 全局配置：LLM 服务连接信息（profiles/keys/endpoints）、系统级默认参数
 * - 工作区配置：项目级设置（章节列表、排序、翻译器选择、窗口参数、上下文大小）
 *
 * 配置文件路径：{projectDir}/Data/workspace-config.json
 */
export type WorkspaceConfig = {
  schemaVersion: 1;
  projectName: string;
  chapters: Chapter[];
  glossary: GlossarySettings;
  dependencyTracking?: WorkspaceDependencyTrackingConfig;
  translator: WorkspaceTranslatorConfig;
  slidingWindow: WorkspaceSlidingWindowConfig;
  textSplitMaxChars?: number;
  contextSize?: number;
  customRequirements: string[];
  defaultImportFormat?: string;
  defaultExportFormat?: string;
};

/**
 * 工作区配置的部分更新补丁。
 *
 * null 值表示清除对应字段。
 */
export type WorkspaceConfigPatch = {
  projectName?: string;
  glossary?: Partial<GlossarySettings>;
  translator?: { translatorName?: string | null };
  slidingWindow?: Partial<WorkspaceSlidingWindowConfig>;
  textSplitMaxChars?: number | null;
  contextSize?: number | null;
  customRequirements?: string[];
  defaultImportFormat?: string | null;
  defaultExportFormat?: string | null;
};

/**
 * 章节描述符，提供章节的元信息摘要。
 */
export type WorkspaceChapterDescriptor = {
  id: number;
  filePath: string;
  fragmentCount: number;
  sourceLineCount: number;
  translatedLineCount: number;
  hasTranslationData: boolean;
  routeId?: string;
  routeName?: string;
  routeChapterIndex?: number;
  isForkPoint?: boolean;
  childBranchCount?: number;
};

export type StoryTopologyRouteDescriptor = {
  id: string;
  name: string;
  parentRouteId: string | null;
  forkAfterChapterId: number | null;
  chapters: number[];
  childRouteIds: string[];
  depth: number;
  isMain: boolean;
};

export type StoryTopologyDescriptor = {
  schemaVersion: number;
  hasPersistedTopology: boolean;
  hasBranches: boolean;
  routes: StoryTopologyRouteDescriptor[];
};

/**
 * 工作区文件清单，列出工作区中所有关键文件路径。
 */
export type WorkspaceFileManifest = {
  projectDir: string;
  bootstrapPath: string;
  databasePath: string;
  contextNetworkDir?: string;
  glossaryPath?: string;
  chapters: Array<{
    id: number;
    sourceFilePath: string;
  }>;
};

/**
 * 翻译文件导入结果。
 */
export type TranslationImportResult = {
  chapterId: number;
  filePath: string;
  unitCount: number;
  fragmentCount: number;
};

/**
 * 翻译文件导出结果。
 */
export type TranslationExportResult = {
  chapterId: number;
  outputPath: string;
  unitCount: number;
};

export type TranslationDependencySupportGroup = {
  term: string;
  supporterNodeIds: string[];
};

export type TranslationDependencyNode = {
  nodeId: string;
  stepId: string;
  chapterId: number;
  fragmentIndex: number;
  orderedIndex: number;
  requiredPrecedingCount: number;
  glossarySupportGroups: TranslationDependencySupportGroup[];
};

export type TranslationDependencyGraph = {
  schemaVersion: 1;
  stepId: string;
  sourceRevision: number;
  glossaryRevision: number;
  builtAt: string;
  nodes: TranslationDependencyNode[];
};

/**
 * 单条路线的导出结果。
 */
export type RouteExportResult = {
  routeId: string;
  routeName: string;
  exportDir: string;
  chapters: TranslationExportResult[];
};

/**
 * 按拓扑结构导出整个项目的结果。
 */
export type ProjectExportResult = {
  /** 导出根目录（固定为 {projectDir}/export） */
  exportDir: string;
  /** 各路线的导出结果 */
  routes: RouteExportResult[];
  /** 总导出章节数 */
  totalChapters: number;
  /** 总导出翻译单元数 */
  totalUnits: number;
};

/**
 * 术语表导入结果。
 */
export type GlossaryImportResult = {
  filePath: string;
  termCount: number;
  newTermCount: number;
  updatedTermCount: number;
};
