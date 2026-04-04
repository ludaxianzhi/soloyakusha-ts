export interface LogEntry {
  id: number;
  level: 'error' | 'warning' | 'info' | 'success';
  message: string;
  timestamp: string;
}

export interface ManagedWorkspace {
  name: string;
  dir: string;
  lastOpenedAt: string;
  managed: boolean;
}

export interface PlotSummaryProgress {
  status: 'running' | 'done' | 'error';
  totalChapters: number;
  completedChapters: number;
  totalBatches: number;
  completedBatches: number;
  currentChapterId?: number;
  errorMessage?: string;
}

export interface ScanDictionaryProgress {
  status: 'running' | 'done' | 'error';
  totalBatches: number;
  completedBatches: number;
  totalLines: number;
  errorMessage?: string;
}

export interface ProjectStatus {
  hasProject: boolean;
  isBusy: boolean;
  plotSummaryReady: boolean;
  plotSummaryProgress: PlotSummaryProgress | null;
  scanDictionaryProgress: ScanDictionaryProgress | null;
  snapshot: TranslationProjectSnapshot | null;
}

export interface TranslationProjectSnapshot {
  projectName: string;
  lifecycle: {
    status:
      | 'idle'
      | 'running'
      | 'stopping'
      | 'stopped'
      | 'aborted'
      | 'completed'
      | 'interrupted';
    queuedWorkItems: number;
    activeWorkItems: number;
    canStart: boolean;
    canStop: boolean;
    canAbort: boolean;
    canResume: boolean;
    canSave: boolean;
  };
  progress: {
    totalChapters: number;
    translatedChapters: number;
    totalFragments: number;
    translatedFragments: number;
    fragmentProgressRatio: number;
    chapterProgressRatio: number;
  };
  glossary?: {
    totalTerms: number;
    translatedTerms: number;
    untranslatedTerms: number;
  };
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
}

export interface TranslationStepQueueSnapshot {
  stepId: string;
  description: string;
  isFinalStep: boolean;
  progress: {
    stepId: string;
    description: string;
    totalFragments: number;
    queuedFragments: number;
    runningFragments: number;
    completedFragments: number;
    readyFragments: number;
    waitingFragments: number;
    completionRatio: number;
  };
}

export interface TranslationStepQueueEntrySnapshot {
  stepId: string;
  chapterId: number;
  fragmentIndex: number;
  status: 'queued' | 'running' | 'completed';
  sourceText: string;
  translatedText: string;
  errorMessage?: string;
}

export interface GlossaryTerm {
  term: string;
  translation: string;
  description?: string;
  category?: string;
  status?: string;
  totalOccurrenceCount?: number;
  textBlockOccurrenceCount?: number;
}

export interface WorkspaceChapterDescriptor {
  id: number;
  filePath: string;
  fragmentCount: number;
  sourceLineCount: number;
  translatedLineCount: number;
  hasTranslationData: boolean;
}

export interface WorkspaceConfig {
  projectName: string;
  glossary: {
    path?: string;
    autoFilter?: boolean;
  };
  translator: {
    translatorName?: string;
  };
  customRequirements: string[];
  defaultImportFormat?: string;
  defaultExportFormat?: string;
}

export interface LlmProfileConfig {
  provider: 'openai' | 'anthropic';
  modelName: string;
  apiKey?: string;
  apiKeyEnv?: string;
  endpoint: string;
  qps?: number;
  maxParallelRequests?: number;
  modelType: 'chat' | 'embedding';
  retries: number;
  defaultRequestConfig?: Record<string, unknown>;
}

export interface TranslatorEntry {
  type?: string;
  modelName: string;
  slidingWindow?: {
    overlapChars?: number;
  };
  requestOptions?: Record<string, unknown>;
  models?: Record<string, string>;
  reviewIterations?: number;
}

export interface GlossaryExtractorConfig {
  modelName: string;
  maxCharsPerBatch?: number;
  occurrenceTopK?: number;
  occurrenceTopP?: number;
  requestOptions?: Record<string, unknown>;
}

export interface GlossaryUpdaterConfig {
  workflow?: string;
  modelName: string;
  requestOptions?: Record<string, unknown>;
}

export interface PlotSummaryConfig {
  modelName: string;
  fragmentsPerBatch?: number;
  maxContextSummaries?: number;
  requestOptions?: Record<string, unknown>;
}

export interface AlignmentRepairConfig {
  modelName: string;
  requestOptions?: Record<string, unknown>;
}
