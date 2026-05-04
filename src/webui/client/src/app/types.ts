export interface LogEntry {
  id: number;
  level: 'error' | 'warning' | 'info' | 'success';
  message: string;
  timestamp: string;
  workspaceId?: string | null;
}

export interface LogDigest {
  total: number;
  latestId: number;
}

export interface LogPage {
  items: LogEntry[];
  total: number;
  latestId: number;
  nextBeforeId?: number;
}

export interface LogSession {
  runId: string;
  startedAt: string;
}

export interface UsageStatsSummary {
  translatedCharacters: number;
  translatedBlocks: number;
  modelCalls: number;
  failedModelCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface UsageStatsDailyPoint {
  date: string;
  translatedCharacters: number;
  translatedBlocks: number;
  modelCalls: number;
  failedModelCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface UsageStatsSnapshot {
  summary: UsageStatsSummary;
  dailyPoints: UsageStatsDailyPoint[];
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

export interface LlmRequestHistorySummaryItem {
  id: number;
  version: 1;
  requestId: string;
  timestamp: string;
  type: 'completion' | 'error';
  source?: string;
  meta?: LlmRequestHistoryEntry['meta'];
  statistics?: LlmRequestHistoryEntry['statistics'];
  modelName?: string;
  durationSeconds?: number;
  errorMessage?: string;
}

export interface LlmRequestHistoryDigest {
  total: number;
  latestId: number;
}

export interface LlmRequestHistoryPage {
  items: LlmRequestHistorySummaryItem[];
  total: number;
  latestId: number;
  nextBeforeId?: number;
}

export interface LlmRequestHistoryDetail extends LlmRequestHistoryEntry {
  id: number;
}

export interface ProjectResourceVersions {
  dictionaryRevision: number;
  chaptersRevision: number;
  topologyRevision: number;
  workspaceConfigRevision: number;
  repetitionPatternsRevision: number;
}

export interface ManagedWorkspace {
  name: string;
  dir: string;
  lastOpenedAt: string;
  managed: boolean;
  deprecated?: boolean;
  deprecationMessage?: string;
}

export interface WorkspaceArchiveManifest {
  archiveType: 'workspace';
  archiveVersion: 1;
  workspaceRoot: string;
  projectName: string;
  exportedAt: string;
  sourceDirectoryName: string;
  workspaceSchemaVersion: number;
  projectStateSchemaVersion: number;
}

export interface PlotSummaryProgress {
  status: 'running' | 'paused' | 'done' | 'error';
  totalChapters: number;
  completedChapters: number;
  totalBatches: number;
  completedBatches: number;
  currentChapterId?: number;
  errorMessage?: string;
}

export interface ScanDictionaryProgress {
  status: 'running' | 'paused' | 'done' | 'error';
  totalBatches: number;
  completedBatches: number;
  totalLines: number;
  currentBatchIndex?: number;
  errorMessage?: string;
}

export interface TranscribeDictionaryProgress {
  status: 'running' | 'paused' | 'done' | 'error';
  totalBatches: number;
  completedBatches: number;
  skippedBatches: number;
  totalLines: number;
  currentBatchIndex?: number;
  errorMessage?: string;
}

export interface ProofreadProgress {
  status: 'running' | 'paused' | 'done' | 'error';
  mode: 'linear' | 'simultaneous';
  totalChapters: number;
  completedChapters: number;
  totalBatches: number;
  completedBatches: number;
  currentChapterId?: number;
  chapterIds: number[];
  warningCount: number;
  lastWarningMessage?: string;
  errorMessage?: string;
}

export interface ProjectStatus {
  workspaceId?: string | null;
  isActiveWorkspace?: boolean;
  hasProject: boolean;
  isBusy: boolean;
  plotSummaryReady: boolean;
  plotSummaryProgress: PlotSummaryProgress | null;
  scanDictionaryProgress: ScanDictionaryProgress | null;
  transcribeDictionaryProgress: TranscribeDictionaryProgress | null;
  proofreadProgress: ProofreadProgress | null;
  snapshot: TranslationProjectSnapshot | null;
}

export interface OpenWorkspaceStatus {
  workspaceId: string;
  projectDir: string;
  projectName: string;
  isActive: boolean;
  isBusy: boolean;
  plotSummaryReady: boolean;
  snapshot: TranslationProjectSnapshot | null;
  resourceVersions: ProjectResourceVersions;
}

export interface WorkspaceEventEnvelope<T> {
  workspaceId: string | null;
  data: T;
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

export interface TextPostProcessorDescriptor {
  id: string;
  name: string;
  description: string;
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

export interface TranslationStepQueueEntryDetail
  extends TranslationStepQueueEntrySnapshot {
  queueSequence: number;
  attemptCount: number;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  runId?: string;
  inputText: string;
  outputText?: string;
  dependencyMode?: 'previousTranslations' | 'glossaryTerms' | 'contextNetwork';
  readyToDispatch: boolean;
  blockedReason?: string;
  metadata: Record<string, string | number | boolean>;
}

export interface ContextNetworkBuildResult {
  vectorStoreType: 'registered' | 'memory';
  fragmentCount: number;
  edgeCount: number;
  minEdgeStrength: number;
}

export interface RepetitionPatternLocation {
  chapterId: number;
  chapterFilePath: string;
  unitIndex: number;
  fragmentIndex: number;
  lineIndex: number;
  sourceSentence: string;
  translatedSentence: string;
  globalStartIndex: number;
  globalEndIndex: number;
  sentenceStartIndex: number;
  sentenceEndIndex: number;
  matchStartInSentence: number;
  matchEndInSentence: number;
}

export interface RepetitionPatternTranslationVariant {
  text: string;
  normalizedText: string;
  count: number;
  locations: RepetitionPatternLocation[];
}

export interface RepetitionPatternAnalysis {
  text: string;
  length: number;
  occurrenceCount: number;
  locations: RepetitionPatternLocation[];
  translations: RepetitionPatternTranslationVariant[];
  isTranslationConsistent: boolean;
}

export interface RepetitionPatternAnalysisResult {
  fullTextLength: number;
  totalSentenceCount: number;
  patterns: RepetitionPatternAnalysis[];
}

export interface SavedRepetitionPatternLocation {
  chapterId: number;
  chapterFilePath: string;
  unitIndex: number;
  fragmentIndex: number;
  lineIndex: number;
  sourceSentence: string;
  globalStartIndex: number;
  globalEndIndex: number;
  sentenceStartIndex: number;
  sentenceEndIndex: number;
  matchStartInSentence: number;
  matchEndInSentence: number;
}

export interface SavedRepetitionPatternAnalysis {
  text: string;
  length: number;
  occurrenceCount: number;
  locations: SavedRepetitionPatternLocation[];
}

export interface SavedRepetitionPatternAnalysisResult {
  schemaVersion: 1;
  generatedAt: string;
  scanOptions: {
    minOccurrences?: number;
    minLength?: number;
    maxResults?: number;
  };
  fullTextLength: number;
  totalSentenceCount: number;
  patterns: SavedRepetitionPatternAnalysis[];
}

export interface RepetitionPatternContextResult {
  chapterId: number;
  unitIndex: number;
  startUnitIndex: number;
  endUnitIndexExclusive: number;
  entries: Array<{
    unitIndex: number;
    content: string;
    isFocus: boolean;
  }>;
}

export interface RepetitionPatternConsistencyFixProgress {
  status: 'running' | 'done' | 'error';
  llmProfileName: string;
  totalPatterns: number;
  completedPatterns: number;
  failedPatterns: number;
  runningPatterns: string[];
  lastAppliedPatternText?: string;
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

export interface DictionaryImportResult {
  filePath: string;
  termCount: number;
  newTermCount: number;
  updatedTermCount: number;
}

export interface WorkspaceChapterDescriptor {
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
}

export interface TextPostProcessorDescriptor {
  id: string;
  name: string;
  description: string;
}

export interface ImportArchiveFailedFile {
  filePath: string;
  error: string;
}

export interface ImportArchiveChapterResult {
  chapterId: number;
  filePath: string;
}

export interface ImportArchiveResult {
  ok: boolean;
  addedCount: number;
  failedCount: number;
  addedChapters: ImportArchiveChapterResult[];
  failedFiles: ImportArchiveFailedFile[];
}

export interface StoryTopologyRouteDescriptor {
  id: string;
  name: string;
  parentRouteId: string | null;
  forkAfterChapterId: number | null;
  chapters: number[];
  childRouteIds: string[];
  depth: number;
  isMain: boolean;
}

export interface StoryTopologyDescriptor {
  schemaVersion: number;
  hasPersistedTopology: boolean;
  hasBranches: boolean;
  routes: StoryTopologyRouteDescriptor[];
}

export interface CreateStoryBranchPayload {
  name: string;
  parentRouteId?: string;
  forkAfterChapterId: number;
  chapterIds?: number[];
}

export interface UpdateStoryRoutePayload {
  name?: string;
  forkAfterChapterId?: number;
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

export type EditableTranslationFormat = 'naturedialog' | 'm3t';

export interface ChapterTranslationEditorRange {
  from: number;
  to: number;
  startLineNumber: number;
  endLineNumber: number;
}

export interface ChapterTranslationEditorDiagnostic extends ChapterTranslationEditorRange {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  unitIndex?: number;
}

export interface ChapterTranslationEditorGlossaryMatch {
  from: number;
  to: number;
  text: string;
  term: string;
  translation?: string;
  kind: 'sourceTerm' | 'targetTranslation';
}

export interface ChapterTranslationEditorLineUpdate {
  unitIndex: number;
  fragmentIndex: number;
  lineIndex: number;
  sourceText: string;
  previousText: string;
  nextText: string;
  changed: boolean;
}

export interface ChapterTranslationEditorDocument {
  baseline: {
    chapterId: number;
    format: EditableTranslationFormat;
    unitCount: number;
    rawLineCount: number;
  };
  content: string;
  units: Array<{
    unitIndex: number;
    fragmentIndex: number;
    lineIndex: number;
    sourceText: string;
    translatedText: string;
    targetCandidates: string[];
  }>;
  diagnostics: ChapterTranslationEditorDiagnostic[];
  glossaryMatches: ChapterTranslationEditorGlossaryMatch[];
  repetitionMatches: ChapterTranslationEditorRepetitionMatch[];
}

export interface ChapterTranslationEditorRepetitionMatch {
  unitIndex: number;
  text: string;
  matchStartInSentence: number;
  matchEndInSentence: number;
  hoverText: string;
}

export interface ChapterTranslationEditorValidationResult {
  baseline: ChapterTranslationEditorDocument['baseline'];
  content: string;
  normalizedContent: string;
  parsedUnitCount: number;
  rawLineCount: number;
  hasLineCountChange: boolean;
  lineCountDelta: number;
  diagnostics: ChapterTranslationEditorDiagnostic[];
  updates: ChapterTranslationEditorLineUpdate[];
  canApply: boolean;
}

export interface ApplyChapterTranslationEditorResult {
  validation: ChapterTranslationEditorValidationResult;
  appliedUpdateCount: number;
}

export type ChapterTranslationAssistantMode = 'question' | 'modify' | 'polish';

export interface ChapterTranslationAssistantConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChapterTranslationAssistantUnit {
  id: string;
  sourceText: string;
  translatedText: string;
}

export interface ChapterTranslationAssistantRequest {
  chapterId: number;
  format: EditableTranslationFormat;
  llmProfileName: string;
  mode: ChapterTranslationAssistantMode;
  selectedUnits: ChapterTranslationAssistantUnit[];
  conversationTurns: ChapterTranslationAssistantConversationTurn[];
  instruction: string;
  glossaryHints: string[];
  repetitionHints: string[];
}

export interface ChapterTranslationAssistantResponse {
  assistantText: string;
}

export interface WorkspaceConfig {
  projectName: string;
  glossary: {
    path?: string;
    autoFilter?: boolean;
  };
  dependencyTracking?: {
    sourceRevision: number;
    glossaryRevision: number;
  };
  pipelineStrategy?: 'default' | 'context-network';
  translator: {
    translatorName?: string;
  };
  customRequirements: string[];
  editorRequirementsText?: string;
  styleGuidanceMode?: 'requirements' | 'examples';
  styleRequirementsText?: string;
  styleLibraryName?: string;
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
  supportsStructuredOutput?: boolean;
  pca?: {
    enabled: boolean;
    weightsFilePath?: string;
  };
}

export interface VectorStoreConfig {
  provider: 'qdrant' | 'chroma' | 'sqlite-memory';
  endpoint: string;
  apiKey?: string;
  apiKeyEnv?: string;
  defaultCollection?: string;
  distance: 'cosine' | 'dot' | 'euclid' | 'manhattan';
  timeoutMs: number;
  retries: number;
  extraHeaders?: Record<string, string>;
  options?: Record<string, unknown>;
}

export interface VectorStoreConnectionStatus {
  state: 'idle' | 'checking' | 'connected' | 'error';
  checkedAt?: string;
  error?: string;
  trigger?: 'startup' | 'save' | 'manual' | 'set-default';
}

export interface StyleLibrarySummary {
  name: string;
  displayName?: string;
  vectorStoreName: string;
  collectionName: string;
  targetLanguage?: string;
  chunkLength?: number;
  embeddingFingerprint?: string;
  embeddingState: 'compatible' | 'invalid' | 'unknown';
  invalidationReason?: string;
  source: 'registered' | 'discovered';
  discoveryMode: 'managed' | 'discovered';
  managedByApp: boolean;
  existsInVectorStore: boolean;
  metadata?: Record<string, unknown>;
  sourceSummary?: {
    fileCount?: number;
    chunkCount?: number;
    characterCount?: number;
  };
}

export interface StyleLibraryCatalog {
  libraries: StyleLibrarySummary[];
  discoveryErrors: Record<string, string>;
}

export interface CreateStyleLibraryInput {
  displayName?: string;
  vectorStoreName: string;
  collectionName?: string;
  targetLanguage: string;
  chunkLength: number;
  managedByApp?: boolean;
  metadata?: Record<string, unknown>;
}

export interface StyleLibraryImportResult {
  libraryName: string;
  collectionName: string;
  importedFiles: string[];
  skippedFiles: string[];
  chunkCount: number;
  characterCount: number;
}

export interface StyleLibraryChunkMatch {
  id: string;
  score: number;
  rawScore?: number;
  payload?: Record<string, unknown>;
  document?: string;
  vector?: number[];
  chunkIndex: number;
  queryText: string;
}

export interface StyleLibraryQueryChunkResult {
  chunkIndex: number;
  text: string;
  charCount: number;
  matches: StyleLibraryChunkMatch[];
}

export interface StyleLibraryQueryResult {
  libraryName: string;
  collectionName: string;
  chunks: StyleLibraryQueryChunkResult[];
  matches: StyleLibraryChunkMatch[];
}

export interface TranslatorMetadata {
  title?: string;
  description?: string;
}

export interface TranslatorEntry {
  metadata?: TranslatorMetadata;
  sourceLanguage: string;
  targetLanguage: string;
  promptSet: string;
  type?: string;
  modelNames: string[];
  maxConcurrentWorkItems?: number;
  slidingWindow?: {
    overlapChars?: number;
  };
  requestOptions?: Record<string, unknown>;
  steps?: Record<string, TranslatorStepConfig>;
  models?: Record<string, string>;
  reviewIterations?: number;
}

export interface TranslatorStepConfig {
  modelNames: string[];
  requestOptions?: Record<string, unknown>;
}

export interface TranslationProcessorConfig {
  workflow?: string;
  modelNames: string[];
  maxConcurrentWorkItems?: number;
  slidingWindow?: {
    overlapChars?: number;
  };
  requestOptions?: Record<string, unknown>;
  steps?: Record<string, TranslatorStepConfig>;
  models?: Record<string, string>;
  reviewIterations?: number;
}

export interface TranslationProcessorWorkflowFieldMetadata {
  key: string;
  label: string;
  description?: string;
  input: 'llm-profile' | 'number' | 'select' | 'text' | 'textarea' | 'yaml';
  options?: Array<{
    label: string;
    value: string;
    description?: string;
  }>;
  optionsSource?: 'style-libraries';
  visibleWhen?: {
    key: string;
    equals: string;
  };
  requiredWhen?: {
    key: string;
    equals: string;
  };
  yamlShape?: 'object' | 'string-map';
  required?: boolean;
  min?: number;
  minLength?: number;
  placeholder?: string;
  section?: 'basic' | 'advanced';
}

export interface TranslationProcessorWorkflowMetadata {
  workflow: string;
  title: string;
  description?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  promptSet?: string;
  translatorFields?: TranslationProcessorWorkflowFieldMetadata[];
  workspaceFields?: TranslationProcessorWorkflowFieldMetadata[];
  fields?: TranslationProcessorWorkflowFieldMetadata[];
}

export interface GlossaryExtractorConfig {
  modelNames: string[];
  maxCharsPerBatch?: number;
  occurrenceTopK?: number;
  occurrenceTopP?: number;
  requestOptions?: Record<string, unknown>;
}

export interface GlossaryUpdaterConfig {
  workflow?: string;
  modelNames: string[];
  requestOptions?: Record<string, unknown>;
}

export interface PlotSummaryConfig {
  modelNames: string[];
  fragmentsPerBatch?: number;
  maxContextSummaries?: number;
  requestOptions?: Record<string, unknown>;
}

export interface AlignmentRepairConfig {
  modelNames: string[];
  requestOptions?: Record<string, unknown>;
}
