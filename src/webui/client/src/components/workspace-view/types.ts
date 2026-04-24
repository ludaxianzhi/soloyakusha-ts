import type { FormInstance } from 'antd';
import type {
  CreateStoryBranchPayload,
  DictionaryImportResult,
  GlossaryTerm,
  ImportArchiveResult,
  ProjectStatus,
  RepetitionPatternAnalysisResult,
  RepetitionPatternConsistencyFixProgress,
  RepetitionPatternContextResult,
  SavedRepetitionPatternAnalysisResult,
  StoryTopologyDescriptor,
  TranslationProjectSnapshot,
  UpdateStoryRoutePayload,
  WorkspaceChapterDescriptor,
} from '../../app/types.ts';

export type ProjectCommand =
  | 'start'
  | 'pause'
  | 'resume'
  | 'abort'
  | 'scan'
  | 'plot'
  | 'close'
  | 'remove';

export type TaskActivityKind = 'scan' | 'plot';

export interface WorkspaceViewProps {
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
  defaultImportFormat?: string;
  translatorOptions: Array<{ label: string; value: string }>;
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
  onProjectCommand: (command: ProjectCommand) => void | Promise<void>;
  onBuildContextNetwork: (
    input: {
      vectorStoreType: 'registered' | 'memory';
      minEdgeStrength: number;
    },
  ) => void | Promise<void>;
  onAbortTaskActivity: (task: TaskActivityKind) => void | Promise<void>;
  onResumeTaskActivity: (task: TaskActivityKind) => void | Promise<void>;
  onOpenDictionaryEditor: (record?: GlossaryTerm) => void;
  onDeleteDictionary: (term: string) => void | Promise<void>;
  onImportDictionaryFromContent: (
    content: string,
    format: 'csv' | 'tsv',
  ) => Promise<DictionaryImportResult>;
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
  onDownloadExport: (format: string) => void | Promise<void>;
  onResetProject: (
    payload: Record<string, unknown>,
    successText: string,
  ) => void | Promise<void>;
  onDismissTaskActivity: (task: TaskActivityKind) => void | Promise<void>;
}
