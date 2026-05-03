import type {
  AlignmentRepairConfig,
  ApplyChapterTranslationEditorResult,
  ChapterTranslationEditorDocument,
  ChapterTranslationEditorValidationResult,
  ChapterTranslationAssistantRequest,
  ChapterTranslationAssistantResponse,
  DictionaryImportResult,
  EditableTranslationFormat,
  GlossaryExtractorConfig,
  GlossaryTerm,
  LlmRequestHistoryDetail,
  LlmRequestHistoryDigest,
  ImportArchiveResult,
  LlmRequestHistoryPage,
  GlossaryUpdaterConfig,
  LlmProfileConfig,
  LogDigest,
  LogEntry,
  LogPage,
  LogSession,
  ManagedWorkspace,
  OpenWorkspaceStatus,
  PlotSummaryConfig,
  ProjectResourceVersions,
  ProjectStatus,
  RepetitionPatternAnalysisResult,
  RepetitionPatternConsistencyFixProgress,
  RepetitionPatternContextResult,
  SavedRepetitionPatternAnalysisResult,
  CreateStoryBranchPayload,
  ContextNetworkBuildResult,
  StoryTopologyDescriptor,
  TranslationProcessorWorkflowMetadata,
  TranslationProcessorConfig,
  TranslationProjectSnapshot,
  TranslationStepQueueEntryDetail,
  TranslatorEntry,
  UsageStatsSnapshot,
  VectorStoreConfig,
  VectorStoreConnectionStatus,
  TranslationPreviewChapter,
  UpdateStoryRoutePayload,
  CreateStyleLibraryInput,
  StyleLibraryCatalog,
  StyleLibraryImportResult,
  StyleLibraryQueryResult,
  TextPostProcessorDescriptor,
  WorkspaceArchiveManifest,
  WorkspaceChapterDescriptor,
  WorkspaceConfig,
} from './types.ts';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';
type JsonBody = object;
type ApiRequestInit = Omit<RequestInit, 'body'> & {
  body?: BodyInit | JsonBody | null;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  init?: ApiRequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  let body = init?.body;
  if (
    body &&
    !(body instanceof FormData) &&
    !(body instanceof Blob) &&
    typeof body !== 'string'
  ) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(body);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    body: body ?? undefined,
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let data: unknown;
    try {
      data = (await response.json()) as { error?: string };
      if (
        typeof data === 'object' &&
        data !== null &&
        'error' in data &&
        typeof data.error === 'string'
      ) {
        message = data.error;
      }
    } catch {
      // ignore JSON parsing failure
    }
    throw new ApiError(message, response.status, data);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function requestBlob(path: string, init?: ApiRequestInit): Promise<Blob> {
  const headers = new Headers(init?.headers);
  let body = init?.body;
  if (
    body &&
    !(body instanceof FormData) &&
    !(body instanceof Blob) &&
    typeof body !== 'string'
  ) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(body);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    body: body ?? undefined,
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = (await response.json()) as { error?: string };
      if (typeof data?.error === 'string') {
        message = data.error;
      }
    } catch {
      const fallbackText = await response.text().catch(() => '');
      if (fallbackText) {
        message = fallbackText;
      }
    }
    throw new Error(message);
  }

  return response.blob();
}

export const api = {
  listWorkspaces: () =>
    request<{ workspaces: ManagedWorkspace[] }>('/api/workspaces'),
  listOpenedWorkspaces: () =>
    request<{
      activeWorkspaceId: string | null;
      workspaces: OpenWorkspaceStatus[];
    }>('/api/workspaces/opened'),
  getActiveProject: () => request<ProjectStatus>('/api/workspaces/active'),
  activateWorkspace: (input: { workspaceId?: string; dir?: string }) =>
    request<ProjectStatus>('/api/workspaces/active', {
      method: 'POST',
      body: input,
    }),
  openWorkspace: (dir: string, projectName?: string) =>
    request<{ workspaceId: string | null; snapshot: TranslationProjectSnapshot | null }>(
      '/api/workspaces/open',
      {
        method: 'POST',
        body: { dir, projectName },
      },
    ),
  createWorkspace: (formData: FormData) =>
    request<{
      workspaceDir: string;
      workspaceId: string | null;
      extractedFiles: string[];
      chapterFiles: string[];
      snapshot: TranslationProjectSnapshot | null;
    }>('/api/workspaces', {
      method: 'POST',
      body: formData,
    }),
  importWorkspaceArchive: (file: File) => {
    const formData = new FormData();
    formData.set('file', file);
    return request<{
      workspaceDir: string;
      extractedFiles: string[];
      manifest: WorkspaceArchiveManifest;
    }>('/api/workspaces/import', {
      method: 'POST',
      body: formData,
    });
  },
  deleteWorkspace: (dir: string) =>
    request<{ ok: boolean }>('/api/workspaces', {
      method: 'DELETE',
      body: { dir },
    }),
  closeWorkspace: (input?: { workspaceId?: string; dir?: string }) =>
    request<{ ok: boolean; activeWorkspaceId: string | null }>('/api/workspaces/close', {
      method: 'POST',
      body: input ?? {},
    }),
  removeCurrentWorkspace: (input?: { workspaceId?: string; dir?: string }) =>
    request<{ ok: boolean; activeWorkspaceId: string | null }>('/api/workspaces/remove', {
      method: 'POST',
      body: input ?? {},
    }),

  getProjectStatus: (workspaceId?: string) =>
    request<ProjectStatus>(`/api/project/status${buildWorkspaceQueryString(workspaceId)}`),
  getProjectResourceVersions: (workspaceId?: string) =>
    request<ProjectResourceVersions>(
      `/api/project/resources/versions${buildWorkspaceQueryString(workspaceId)}`,
    ),
  getPostProcessors: (workspaceId?: string) =>
    request<{ processors: TextPostProcessorDescriptor[] }>(
      `/api/project/post-processors${buildWorkspaceQueryString(workspaceId)}`,
    ),
  runBatchPostProcess: (chapterIds: number[], processorIds: string[], workspaceId?: string) =>
    request<{ ok: boolean }>(`/api/project/chapters/post-process${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'POST',
      body: { chapterIds, processorIds },
    }),
  getSnapshot: (workspaceId?: string) =>
    request<TranslationProjectSnapshot | null>(
      `/api/project/snapshot${buildWorkspaceQueryString(workspaceId)}`,
    ),
  getSnapshotWithEntries: (workspaceId?: string) =>
    request<TranslationProjectSnapshot | null>(
      `/api/project/snapshot${buildQueryString({ includeEntries: 1, workspaceId })}`,
    ),
  startTranslation: (workspaceId?: string) =>
    request(`/api/project/start${buildWorkspaceQueryString(workspaceId)}`, { method: 'POST' }),
  pauseTranslation: (workspaceId?: string) =>
    request(`/api/project/pause${buildWorkspaceQueryString(workspaceId)}`, { method: 'POST' }),
  resumeTranslation: (workspaceId?: string) =>
    request(`/api/project/resume${buildWorkspaceQueryString(workspaceId)}`, { method: 'POST' }),
  abortTranslation: (workspaceId?: string) =>
    request(`/api/project/abort${buildWorkspaceQueryString(workspaceId)}`, { method: 'POST' }),
  getQueueEntries: (stepId: string, workspaceId?: string) =>
    request<{ stepId: string; entries: TranslationStepQueueEntryDetail[] }>(
      `/api/project/queue/${encodeURIComponent(stepId)}/entries${buildWorkspaceQueryString(workspaceId)}`,
    ),
  getRepeatedPatterns: (options?: { chapterIds?: number[]; workspaceId?: string }) =>
    request<SavedRepetitionPatternAnalysisResult>(
      `/api/project/repetition-patterns${buildQueryString({
        chapterIds: options?.chapterIds?.join(','),
        workspaceId: options?.workspaceId,
      })}`,
     ),
  scanRepeatedPatterns: (input?: {
    minOccurrences?: number;
    minLength?: number;
    maxResults?: number;
  }, workspaceId?: string) =>
    request<SavedRepetitionPatternAnalysisResult>(`/api/project/repetition-patterns/scan${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'POST',
      body: input ?? {},
    }),
  hydrateRepeatedPatterns: (input: {
    chapterIds?: number[];
    patternTexts?: string[];
  }, workspaceId?: string) =>
    request<RepetitionPatternAnalysisResult>(`/api/project/repetition-patterns/hydrate${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'POST',
      body: input,
    }),
  saveRepeatedPatternTranslation: (input: {
    chapterId: number;
    fragmentIndex: number;
    lineIndex: number;
    translation: string;
  }, workspaceId?: string) =>
    request(`/api/project/repetition-patterns/translation${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'PUT',
      body: input,
    }),
  getRepeatedPatternContext: (input: { chapterId: number; unitIndex: number; workspaceId?: string }) =>
    request<RepetitionPatternContextResult>(
      `/api/project/repetition-patterns/context${buildQueryString(input)}`,
    ),
  startRepeatedPatternConsistencyFix: (input: {
    llmProfileName: string;
    chapterIds?: number[];
  }, workspaceId?: string) =>
    request<RepetitionPatternConsistencyFixProgress>(
      `/api/project/repetition-patterns/consistency-fix${buildWorkspaceQueryString(workspaceId)}`,
      {
        method: 'POST',
        body: input,
      },
    ),
  getRepeatedPatternConsistencyFixStatus: (workspaceId?: string) =>
    request<RepetitionPatternConsistencyFixProgress | null>(
      `/api/project/repetition-patterns/consistency-fix/status${buildWorkspaceQueryString(workspaceId)}`,
    ),
  clearRepeatedPatternConsistencyFixStatus: (workspaceId?: string) =>
    request(`/api/project/repetition-patterns/consistency-fix/clear${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'POST',
    }),

  getDictionary: (workspaceId?: string) =>
    request<{ terms: GlossaryTerm[] }>(`/api/project/dictionary${buildWorkspaceQueryString(workspaceId)}`),
  saveDictionaryTerm: (term: Partial<GlossaryTerm> & { term: string }, workspaceId?: string) =>
    request(`/api/project/dictionary${buildWorkspaceQueryString(workspaceId)}`, { method: 'PUT', body: term }),
  deleteDictionaryTerm: (term: string, workspaceId?: string) =>
    request(`/api/project/dictionary${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'DELETE',
      body: { term },
    }),
  scanDictionary: (workspaceId?: string) =>
    request(`/api/project/dictionary/scan${buildWorkspaceQueryString(workspaceId)}`, { method: 'POST' }),
  abortScanDictionary: (workspaceId?: string) =>
    request(`/api/project/dictionary/scan/abort${buildWorkspaceQueryString(workspaceId)}`, { method: 'POST' }),
  resumeScanDictionary: (workspaceId?: string) =>
    request(`/api/project/dictionary/scan/resume${buildWorkspaceQueryString(workspaceId)}`, { method: 'POST' }),
  importDictionaryFromContent: (content: string, format: 'csv' | 'tsv', workspaceId?: string) =>
    request<DictionaryImportResult>(`/api/project/dictionary/import-content${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'POST',
      body: { content, format },
    }),

  startPlotSummary: (workspaceId?: string) =>
    request(`/api/project/plot-summary${buildWorkspaceQueryString(workspaceId)}`, { method: 'POST' }),
  abortPlotSummary: (workspaceId?: string) =>
    request(`/api/project/plot-summary/abort${buildWorkspaceQueryString(workspaceId)}`, { method: 'POST' }),
  resumePlotSummary: (workspaceId?: string) =>
    request(`/api/project/plot-summary/resume${buildWorkspaceQueryString(workspaceId)}`, { method: 'POST' }),
  startProofread: (payload: {
    chapterIds: number[];
    mode?: 'linear' | 'simultaneous';
  }, workspaceId?: string) =>
    request(`/api/project/proofread${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'POST',
      body: payload,
    }),
  abortProofread: (workspaceId?: string) =>
    request(`/api/project/proofread/abort${buildWorkspaceQueryString(workspaceId)}`, { method: 'POST' }),
  forceAbortProofread: (workspaceId?: string) =>
    request(`/api/project/proofread/force-abort${buildWorkspaceQueryString(workspaceId)}`, { method: 'POST' }),
  resumeProofread: (workspaceId?: string) =>
    request(`/api/project/proofread/resume${buildWorkspaceQueryString(workspaceId)}`, { method: 'POST' }),
  removeProofreadTask: (workspaceId?: string) =>
    request(`/api/project/proofread/remove${buildWorkspaceQueryString(workspaceId)}`, { method: 'POST' }),
  clearTaskProgress: (task: 'scan' | 'plot' | 'proofread' | 'all', workspaceId?: string) =>
    request(`/api/project/task-ui/clear${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'POST',
      body: { task },
    }),

  getChapters: (workspaceId?: string) =>
    request<{ chapters: WorkspaceChapterDescriptor[] }>(`/api/project/chapters${buildWorkspaceQueryString(workspaceId)}`),
  getTopology: (workspaceId?: string) =>
    request<{ topology: StoryTopologyDescriptor | null }>(`/api/project/topology${buildWorkspaceQueryString(workspaceId)}`),
  getChapterPreview: (chapterId: number, workspaceId?: string) =>
    request<TranslationPreviewChapter>(`/api/project/preview/chapters/${chapterId}${buildWorkspaceQueryString(workspaceId)}`),
  getChapterEditorDocument: (chapterId: number, format: EditableTranslationFormat, workspaceId?: string) =>
    request<ChapterTranslationEditorDocument>(
      `/api/project/editor/chapters/${chapterId}${buildQueryString({ format, workspaceId })}`,
    ),
  validateChapterEditor: (payload: {
    chapterId: number;
    format: EditableTranslationFormat;
    content: string;
  }, workspaceId?: string) =>
    request<ChapterTranslationEditorValidationResult>(`/api/project/editor/validate${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'POST',
      body: payload,
    }),
  applyChapterEditor: (payload: {
    chapterId: number;
    format: EditableTranslationFormat;
    content: string;
  }, workspaceId?: string) =>
    request<ApplyChapterTranslationEditorResult>(`/api/project/editor/apply${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'POST',
      body: payload,
    }),
  runChapterTranslationAssistant: (payload: ChapterTranslationAssistantRequest, workspaceId?: string) =>
    request<ChapterTranslationAssistantResponse>(`/api/project/editor/assistant${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'POST',
      body: payload,
    }),
  importChapterArchive: (formData: FormData, workspaceId?: string) =>
    request<ImportArchiveResult>(`/api/project/chapters/import-archive${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'POST',
      body: formData,
    }),
  reorderChapters: (chapterIds: number[], workspaceId?: string) =>
    request(`/api/project/chapters/reorder${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'PUT',
      body: { chapterIds },
    }),
  removeChapter: (chapterId: number, workspaceId?: string) =>
    request(`/api/project/chapters/${chapterId}${buildWorkspaceQueryString(workspaceId)}`, { method: 'DELETE' }),
  removeChapters: (
    chapterIds: number[],
    options: { cascadeBranches?: boolean } = {},
    workspaceId?: string,
  ) =>
    request(`/api/project/chapters/remove${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'POST',
      body: {
        chapterIds,
        cascadeBranches: options.cascadeBranches,
      },
    }),
  clearChapterTranslations: (chapterIds: number[], workspaceId?: string) =>
    request(`/api/project/chapters/clear${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'POST',
      body: { chapterIds },
    }),
  createStoryBranch: (payload: CreateStoryBranchPayload, workspaceId?: string) =>
    request(`/api/project/topology/routes${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'POST',
      body: payload,
    }),
  updateStoryRoute: (routeId: string, payload: UpdateStoryRoutePayload, workspaceId?: string) =>
    request(`/api/project/topology/routes/${encodeURIComponent(routeId)}${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'PUT',
      body: payload,
    }),
  reorderStoryRouteChapters: (routeId: string, chapterIds: number[], workspaceId?: string) =>
    request(`/api/project/topology/routes/${encodeURIComponent(routeId)}/reorder${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'PUT',
      body: { chapterIds },
    }),
  removeStoryRoute: (routeId: string, workspaceId?: string) =>
    request(`/api/project/topology/routes/${encodeURIComponent(routeId)}${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'DELETE',
    }),
  moveChapterToRoute: (chapterId: number, targetRouteId: string, targetIndex: number, workspaceId?: string) =>
    request(`/api/project/topology/move-chapter${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'POST',
      body: { chapterId, targetRouteId, targetIndex },
    }),

  getWorkspaceConfig: (workspaceId?: string) => request<WorkspaceConfig>(`/api/project/config${buildWorkspaceQueryString(workspaceId)}`),
  updateWorkspaceConfig: (patch: Record<string, unknown>, workspaceId?: string) =>
    request<{ ok: boolean; config: WorkspaceConfig }>(`/api/project/config${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'PUT',
      body: patch,
    }),
  buildContextNetwork: (payload: {
    vectorStoreType: 'registered' | 'memory';
    minEdgeStrength: number;
  }, workspaceId?: string) =>
    request<ContextNetworkBuildResult>(`/api/project/context-network${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'POST',
      body: payload,
    }),
  resetProject: (payload: Record<string, unknown>, workspaceId?: string) =>
    request(`/api/project/reset${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'POST',
      body: payload,
    }),

  getHistorySummary: () =>
    request<LlmRequestHistoryDigest>('/api/activity/history/summary'),
  getHistory: (params?: { limit?: number; beforeId?: number }) =>
    request<LlmRequestHistoryPage>(
      `/api/activity/history${buildQueryString(params)}`,
    ),
  getHistoryDetail: (id: number) =>
    request<LlmRequestHistoryDetail>(`/api/activity/history/${id}`),
  deleteHistoryEntry: (id: number) =>
    request<{ ok: boolean }>(`/api/activity/history/${id}`, {
      method: 'DELETE',
    }),
  clearHistory: () =>
    request<{ ok: boolean; deletedCount: number }>('/api/activity/history', {
      method: 'DELETE',
    }),
  downloadHistoryExport: () =>
    requestBlob('/api/activity/history/export'),
  getLogsSummary: () =>
    request<LogDigest>('/api/events/logs/summary'),
  getLogSession: () =>
    request<LogSession>('/api/events/logs/session'),
  getLogs: (params?: { limit?: number; beforeId?: number }) =>
    request<LogPage>(`/api/events/logs${buildQueryString(params)}`),
  clearLogs: () => request('/api/events/logs/clear', { method: 'POST' }),
  downloadLogs: (format: 'json' | 'text' = 'text') =>
    requestBlob(`/api/events/logs/export${buildQueryString({ format })}`),
  getUsageStats: (days = 30) =>
    request<UsageStatsSnapshot>(`/api/activity/usage${buildQueryString({ days })}`),

  downloadExport: (format: string, workspaceId?: string) =>
    requestBlob(`/api/project/export${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'POST',
      body: { format },
    }),

  downloadChaptersExport: (chapterIds: number[], format: string, workspaceId?: string) =>
    requestBlob(`/api/project/chapters/export${buildWorkspaceQueryString(workspaceId)}`, {
      method: 'POST',
      body: { chapterIds, format },
    }),

  downloadWorkspaceArchive: (dir: string) =>
    requestBlob('/api/workspaces/export', {
      method: 'POST',
      body: { dir },
    }),

  getLlmProfiles: () =>
    request<{
      profiles: Record<string, LlmProfileConfig>;
      defaultName?: string;
    }>('/api/config/llm'),
  getLlmProfile: (name: string) =>
    request<LlmProfileConfig>(`/api/config/llm/${encodeURIComponent(name)}`),
  saveLlmProfile: (name: string, config: LlmProfileConfig) =>
    request(`/api/config/llm/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: config,
    }),
  deleteLlmProfile: (name: string) =>
    request(`/api/config/llm/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
  setDefaultLlmProfile: (name?: string) =>
    request('/api/config/llm-default', {
      method: 'PUT',
      body: { name },
    }),
  getEmbeddingConfig: () =>
    request<LlmProfileConfig | null>('/api/config/embedding'),
  saveEmbeddingConfig: (config: LlmProfileConfig) =>
    request('/api/config/embedding', { method: 'PUT', body: config }),
  uploadEmbeddingPcaWeights: (file: File) => {
    const formData = new FormData();
    formData.set('file', file);
    return request<{ filePath: string }>('/api/config/embedding/pca/upload', {
      method: 'POST',
      body: formData,
    });
  },
  getVectorStores: () =>
    request<{
      config: VectorStoreConfig | null;
      status: VectorStoreConnectionStatus;
    }>('/api/config/vector'),
  saveVectorStore: (config: VectorStoreConfig) =>
    request<{ ok: boolean; connection: VectorStoreConnectionStatus }>(
      '/api/config/vector',
      {
        method: 'PUT',
        body: config,
      },
    ),
  deleteVectorStore: () =>
    request('/api/config/vector', {
      method: 'DELETE',
    }),
  connectVectorStore: (input: { config?: VectorStoreConfig }) =>
    request<{ ok: boolean; connection: VectorStoreConnectionStatus }>(
      '/api/config/vector/connect',
      {
        method: 'POST',
        body: input,
      },
    ),
  getStyleLibraries: () =>
    request<StyleLibraryCatalog>('/api/style-libraries'),
  getStyleLibraryVectorStores: () =>
    request<{ names: string[] }>('/api/style-libraries/vector-stores'),
  saveStyleLibrary: (name: string, input: CreateStyleLibraryInput) =>
    request('/api/style-libraries/' + encodeURIComponent(name), {
      method: 'PUT',
      body: input,
    }),
  importStyleLibrary: (name: string, input: { file: File; formatName?: string }) => {
    const formData = new FormData();
    formData.set('file', input.file);
    if (input.formatName) {
      formData.set('formatName', input.formatName);
    }
    return request<StyleLibraryImportResult>(
      '/api/style-libraries/' + encodeURIComponent(name) + '/import',
      {
        method: 'POST',
        body: formData,
      },
    );
  },
  queryStyleLibrary: (name: string, text: string) =>
    request<StyleLibraryQueryResult>(
      '/api/style-libraries/' + encodeURIComponent(name) + '/query',
      {
        method: 'POST',
        body: { text },
      },
    ),
  deleteStyleLibrary: (name: string, deleteCollection = true) =>
    request<{ removedRegistry: boolean; removedCollection: boolean }>(
      '/api/style-libraries/' + encodeURIComponent(name) + buildQueryString({ deleteCollection: deleteCollection ? 1 : 0 }),
      {
        method: 'DELETE',
      },
    ),
  deleteExternalStyleLibrary: (input: {
    vectorStoreName: string;
    collectionName: string;
    deleteCollection?: boolean;
  }) =>
    request<{ removedRegistry: boolean; removedCollection: boolean }>(
      '/api/style-libraries/external',
      {
        method: 'DELETE',
        body: input,
      },
    ),

  getTranslators: () =>
    request<{ translators: Record<string, TranslatorEntry> }>(
      '/api/config/translators',
    ),
  getTranslatorWorkflows: () =>
    request<{ workflows: TranslationProcessorWorkflowMetadata[] }>(
      '/api/config/translator-workflows',
    ),
  getProofreadWorkflows: () =>
    request<{ workflows: TranslationProcessorWorkflowMetadata[] }>(
      '/api/config/proofread-workflows',
    ),
  saveTranslator: (name: string, config: TranslatorEntry) =>
    request(`/api/config/translators/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: config,
    }),
  deleteTranslator: (name: string) =>
    request(`/api/config/translators/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
  getProofreadProcessorConfig: () =>
    request<TranslationProcessorConfig | null>('/api/config/proofread-processor'),
  saveProofreadProcessorConfig: (config: TranslationProcessorConfig) =>
    request('/api/config/proofread-processor', {
      method: 'PUT',
      body: config,
    }),

  getGlossaryExtractor: () =>
    request<GlossaryExtractorConfig | null>(
      '/api/config/auxiliary/glossary-extractor',
    ),
  saveGlossaryExtractor: (config: GlossaryExtractorConfig) =>
    request('/api/config/auxiliary/glossary-extractor', {
      method: 'PUT',
      body: config,
    }),
  getGlossaryUpdater: () =>
    request<GlossaryUpdaterConfig | null>(
      '/api/config/auxiliary/glossary-updater',
    ),
  saveGlossaryUpdater: (config: GlossaryUpdaterConfig) =>
    request('/api/config/auxiliary/glossary-updater', {
      method: 'PUT',
      body: config,
    }),
  getPlotSummaryConfig: () =>
    request<PlotSummaryConfig | null>('/api/config/auxiliary/plot-summary'),
  savePlotSummaryConfig: (config: PlotSummaryConfig) =>
    request('/api/config/auxiliary/plot-summary', {
      method: 'PUT',
      body: config,
    }),
  getAlignmentRepairConfig: () =>
    request<AlignmentRepairConfig | null>(
      '/api/config/auxiliary/alignment-repair',
    ),
  saveAlignmentRepairConfig: (config: AlignmentRepairConfig) =>
    request('/api/config/auxiliary/alignment-repair', {
      method: 'PUT',
      body: config,
    }),
};

function buildQueryString(
  params?: Record<string, string | number | undefined>,
): string {
  if (!params) {
    return '';
  }
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    searchParams.set(key, String(value));
  }
  const query = searchParams.toString();
  return query ? `?${query}` : '';
}

function buildWorkspaceQueryString(workspaceId?: string): string {
  return buildQueryString({ workspaceId });
}
