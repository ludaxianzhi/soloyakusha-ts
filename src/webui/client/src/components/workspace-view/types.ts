import type { FormInstance } from 'antd';
import type {
  CreateStoryBranchPayload,
  DictionaryImportResult,
  GlossaryTerm,
  ImportArchiveResult,
  ProofreaderEntry,
  ProjectStatus,
  RepetitionPatternAnalysisResult,
  RepetitionPatternConsistencyFixProgress,
  RepetitionPatternContextResult,
  SavedRepetitionPatternAnalysisResult,
  StoryTopologyDescriptor,
  TranslationProcessorWorkflowMetadata,
  TranslationProjectSnapshot,
  UpdateStoryRoutePayload,
  UpdateTranslationArchiveApplyResult,
  UpdateTranslationArchivePreviewResult,
  WorkspaceChapterDescriptor,
} from '../../app/types.ts';

export type ProjectCommand =
  | 'start'
  | 'pause'
  | 'resume'
  | 'abort'
  | 'scan'
  | 'transcribe'
  | 'plot'
  | 'close'
  | 'remove';

export type TaskActivityKind = 'scan' | 'transcribe' | 'plot' | 'proofread';
export type ProofreadTaskMode = 'linear' | 'simultaneous';
export type DictionaryFileFormat = 'json' | 'csv' | 'tsv' | 'yaml' | 'yml' | 'xml';

export type DictionaryScanStartOptions = {
  maxCharsPerBatch?: number;
  occurrenceTopK?: number;
  occurrenceTopP?: number;
};

export type DictionaryTranscribeStartOptions = {
  maxCharsPerBatch?: number;
  maxTermsPerRequest?: number;
};

export interface WorkspaceViewProps {
  workspaceId?: string | null;
  snapshot: TranslationProjectSnapshot | null;
  projectStatus: ProjectStatus | null;
  pipelineStrategy?: 'default' | 'context-network';
  mobileMode?: boolean;
  sseConnected: boolean;
  dictionary: GlossaryTerm[];
  repeatedPatterns: SavedRepetitionPatternAnalysisResult | null;
  chapters: WorkspaceChapterDescriptor[];
  topology: StoryTopologyDescriptor | null;
  workspaceForm: FormInstance<Record<string, unknown>>;
  translatorOptions: Array<{ label: string; value: string }>;
  styleLibraryOptions: Array<{ label: string; value: string; description?: string }>;
  selectedTranslatorWorkflow?: TranslationProcessorWorkflowMetadata;
  llmProfileOptions: Array<{ label: string; value: string }>;
  defaultLlmProfileName?: string;
  onRefreshProjectStatus: () => void | Promise<void>;
  onRefreshDictionary: () => void | Promise<void>;
  onRefreshRepeatedPatterns: (options?: { chapterIds?: number[] }) => Promise<SavedRepetitionPatternAnalysisResult | null>;
  onScanRepeatedPatterns: (options?: {
    minOccurrences?: number;
    minLength?: number;
    maxResults?: number;
  }) => Promise<SavedRepetitionPatternAnalysisResult | null>;
  onHydrateRepeatedPatterns: (input: {
    chapterIds?: number[];
    patternTexts?: string[];
  }) => Promise<RepetitionPatternAnalysisResult | null>;
  onSaveRepeatedPatternTranslation: (input: {
    chapterId: number;
    fragmentIndex: number;
    lineIndex: number;
    translation: string;
  }) => Promise<void>;
  onLoadRepeatedPatternContext: (input: {
    chapterId: number;
    unitIndex: number;
  }) => Promise<RepetitionPatternContextResult>;
  onStartRepeatedPatternConsistencyFix: (input: {
    llmProfileName: string;
    chapterIds?: number[];
  }) => Promise<RepetitionPatternConsistencyFixProgress>;
  onGetRepeatedPatternConsistencyFixStatus: () => Promise<RepetitionPatternConsistencyFixProgress | null>;
  onClearRepeatedPatternConsistencyFixStatus: () => Promise<void>;
  onRefreshChapters: () => void | Promise<void>;
  onRefreshTopology: () => void | Promise<void>;
  onRefreshWorkspaceConfig: () => void | Promise<void>;
  onRefreshStyleLibraryOptions: () => void | Promise<void>;
  onProjectCommand: (command: ProjectCommand) => void | Promise<void>;
  onStartDictionaryScan: (options: DictionaryScanStartOptions) => void | Promise<void>;
  onStartDictionaryTranscribe: (options: DictionaryTranscribeStartOptions) => void | Promise<void>;
  onBuildContextNetwork: (
    input: {
      maxOutgoingCandidates: number;
      embeddingProfileName: string;
    },
  ) => void | Promise<void>;
  embeddingProfileOptions: Array<{ label: string; value: string }>;
  onStartProofread: (input: {
    chapterIds: number[];
    mode?: ProofreadTaskMode;
    proofreaderName?: string;
  }) => void | Promise<void>;
  proofreaders: Record<string, ProofreaderEntry>;
  defaultProofreaderName?: string;
  onAbortTaskActivity: (task: TaskActivityKind) => void | Promise<void>;
  onForceAbortTaskActivity: (task: TaskActivityKind) => void | Promise<void>;
  onRemoveTaskActivity: (task: TaskActivityKind) => void | Promise<void>;
  onResumeTaskActivity: (task: TaskActivityKind) => void | Promise<void>;
  onOpenDictionaryEditor: (record?: GlossaryTerm) => void;
  onDeleteDictionary: (terms: string[]) => void | Promise<void>;
  onSaveDictionaryTerms: (
    terms: Array<{ term: string; from?: string; translation: string; description?: string }>,
  ) => void | Promise<void>;
  onClearDictionaryTranslations: () => void | Promise<void>;
  dictionaryScanDefaults?: DictionaryScanStartOptions;
  dictionaryTranscribeDefaults?: DictionaryTranscribeStartOptions;
  onImportDictionaryFile: (file: File) => void | Promise<void>;
  onImportDictionaryFromContent: (
    content: string,
    format: 'csv' | 'tsv',
  ) => Promise<DictionaryImportResult>;
  onDownloadDictionaryExport: (format: DictionaryFileFormat) => void | Promise<void>;
  onWorkspaceConfigSave: (values: Record<string, unknown>) => void | Promise<void>;
  onClearChapterTranslations: (chapterIds: number[]) => void | Promise<void>;
  onRemoveChapters: (
    chapterIds: number[],
    options?: { cascadeBranches?: boolean },
  ) => void | Promise<void>;
  onCreateStoryBranch: (payload: CreateStoryBranchPayload) => void | Promise<void>;
  onUpdateStoryRoute: (
    routeId: string,
    payload: UpdateStoryRoutePayload,
  ) => void | Promise<void>;
  onReorderStoryRouteChapters: (
    routeId: string,
    chapterIds: number[],
  ) => void | Promise<void>;
  onMoveChapterToRoute: (
    chapterId: number,
    targetRouteId: string,
    targetIndex: number,
  ) => void | Promise<void>;
  onRemoveStoryRoute: (routeId: string) => void | Promise<void>;
  onImportChapterArchive: (payload: {
    file: File;
    importFormat?: string;
    importPattern?: string;
    importTranslation?: boolean;
  }) => Promise<ImportArchiveResult>;
  onPreviewTranslationUpdate: (payload: {
    file: File;
    importFormat?: string;
    importPattern?: string;
    importParams?: Record<string, unknown>;
  }) => Promise<UpdateTranslationArchivePreviewResult>;
  onApplyTranslationUpdate: (
    sessionId: string,
    chapterIds: number[],
    skipChapterIds?: number[],
  ) => Promise<UpdateTranslationArchiveApplyResult>;
  onDownloadExport: (format: string, params?: Record<string, unknown>) => void | Promise<void>;
  onDownloadChapters: (chapterIds: number[], format: string, params?: Record<string, unknown>) => void | Promise<void>;
  onBatchSaveTopology: (routes: { id: string; chapters: number[] }[]) => void | Promise<void>;
  onResetProject: (
    payload: Record<string, unknown>,
    successText: string,
  ) => void | Promise<void>;
  onDismissTaskActivity: (task: TaskActivityKind) => void | Promise<void>;
}
