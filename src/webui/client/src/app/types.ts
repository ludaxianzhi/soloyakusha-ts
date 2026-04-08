export interface LogEntry {
  id: number;
  level: 'error' | 'warning' | 'info' | 'success';
  message: string;
  timestamp: string;
}

export interface LlmRequestHistoryEntry {
  version: 1;
  requestId: string;
  timestamp: string;
  type: 'completion' | 'error';
  source?: string;
  prompt: string;
  response?: string;
  errorMessage?: string;
  responseBody?: string;
  meta?: {
    label: string;
    feature: string;
    operation: string;
    component?: string;
    workflow?: string;
    stage?: string;
    context?: Record<string, unknown>;
  };
  requestConfig?: {
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    extraBody?: Record<string, unknown>;
  };
  statistics?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  modelName?: string;
  durationSeconds?: number;
  reasoning?: string;
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

export interface TranslationPreviewUnit {
  index: number;
  sourceText: string;
  translatedText: string;
  hasTranslation: boolean;
}

export interface TranslationPreviewChapter {
  chapter: WorkspaceChapterDescriptor;
  units: TranslationPreviewUnit[];
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

export interface TranslatorMetadata {
  title?: string;
  description?: string;
}

export interface TranslatorEntry {
  metadata?: TranslatorMetadata;
  type?: string;
  modelName: string;
  slidingWindow?: {
    overlapChars?: number;
  };
  requestOptions?: Record<string, unknown>;
  models?: Record<string, string>;
  reviewIterations?: number;
}

export interface TranslationProcessorWorkflowFieldMetadata {
  key: string;
  label: string;
  description?: string;
  input: 'llm-profile' | 'number' | 'yaml';
  yamlShape?: 'object' | 'string-map';
  required?: boolean;
  min?: number;
  placeholder?: string;
  section?: 'basic' | 'advanced';
}

export interface TranslationProcessorWorkflowMetadata {
  workflow: string;
  title: string;
  description?: string;
  fields: TranslationProcessorWorkflowFieldMetadata[];
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
