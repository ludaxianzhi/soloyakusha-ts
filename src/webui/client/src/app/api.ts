import type {
  AlignmentRepairConfig,
  DictionaryImportResult,
  GlossaryExtractorConfig,
  GlossaryTerm,
  ImportArchiveResult,
  LlmRequestHistoryEntry,
  GlossaryUpdaterConfig,
  LlmProfileConfig,
  LogEntry,
  ManagedWorkspace,
  PlotSummaryConfig,
  ProjectStatus,
  CreateStoryBranchPayload,
  StoryTopologyDescriptor,
  TranslationProcessorWorkflowMetadata,
  TranslationProjectSnapshot,
  TranslationStepQueueEntryDetail,
  TranslatorEntry,
  TranslationPreviewChapter,
  UpdateStoryRoutePayload,
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
  getActiveProject: () => request<ProjectStatus>('/api/workspaces/active'),
  openWorkspace: (dir: string, projectName?: string) =>
    request<{ snapshot: TranslationProjectSnapshot | null }>(
      '/api/workspaces/open',
      {
        method: 'POST',
        body: { dir, projectName },
      },
    ),
  createWorkspace: (formData: FormData) =>
    request<{
      workspaceDir: string;
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
  closeWorkspace: () =>
    request<{ ok: boolean }>('/api/workspaces/close', { method: 'POST' }),
  removeCurrentWorkspace: () =>
    request<{ ok: boolean }>('/api/workspaces/remove', { method: 'POST' }),

  getProjectStatus: () => request<ProjectStatus>('/api/project/status'),
  getSnapshot: () =>
    request<TranslationProjectSnapshot | null>('/api/project/snapshot'),
  getSnapshotWithEntries: () =>
    request<TranslationProjectSnapshot | null>('/api/project/snapshot?includeEntries=1'),
  startTranslation: () => request('/api/project/start', { method: 'POST' }),
  pauseTranslation: () => request('/api/project/pause', { method: 'POST' }),
  resumeTranslation: () => request('/api/project/resume', { method: 'POST' }),
  abortTranslation: () => request('/api/project/abort', { method: 'POST' }),
  getQueueEntries: (stepId: string) =>
    request<{ stepId: string; entries: TranslationStepQueueEntryDetail[] }>(
      `/api/project/queue/${encodeURIComponent(stepId)}/entries`,
    ),

  getDictionary: () =>
    request<{ terms: GlossaryTerm[] }>('/api/project/dictionary'),
  saveDictionaryTerm: (term: Partial<GlossaryTerm> & { term: string }) =>
    request('/api/project/dictionary', { method: 'PUT', body: term }),
  deleteDictionaryTerm: (term: string) =>
    request('/api/project/dictionary', {
      method: 'DELETE',
      body: { term },
    }),
  scanDictionary: () =>
    request('/api/project/dictionary/scan', { method: 'POST' }),
  importDictionaryFromContent: (content: string, format: 'csv' | 'tsv') =>
    request<DictionaryImportResult>('/api/project/dictionary/import-content', {
      method: 'POST',
      body: { content, format },
    }),

  startPlotSummary: () =>
    request('/api/project/plot-summary', { method: 'POST' }),
  clearTaskProgress: (task: 'scan' | 'plot' | 'all') =>
    request('/api/project/task-ui/clear', {
      method: 'POST',
      body: { task },
    }),

  getChapters: () =>
    request<{ chapters: WorkspaceChapterDescriptor[] }>('/api/project/chapters'),
  getTopology: () =>
    request<{ topology: StoryTopologyDescriptor | null }>('/api/project/topology'),
  getChapterPreview: (chapterId: number) =>
    request<TranslationPreviewChapter>(`/api/project/preview/chapters/${chapterId}`),
  importChapterArchive: (formData: FormData) =>
    request<ImportArchiveResult>('/api/project/chapters/import-archive', {
      method: 'POST',
      body: formData,
    }),
  reorderChapters: (chapterIds: number[]) =>
    request('/api/project/chapters/reorder', {
      method: 'PUT',
      body: { chapterIds },
    }),
  removeChapter: (chapterId: number) =>
    request(`/api/project/chapters/${chapterId}`, { method: 'DELETE' }),
  removeChapters: (
    chapterIds: number[],
    options: { cascadeBranches?: boolean } = {},
  ) =>
    request('/api/project/chapters/remove', {
      method: 'POST',
      body: {
        chapterIds,
        cascadeBranches: options.cascadeBranches,
      },
    }),
  clearChapterTranslations: (chapterIds: number[]) =>
    request('/api/project/chapters/clear', {
      method: 'POST',
      body: { chapterIds },
    }),
  createStoryBranch: (payload: CreateStoryBranchPayload) =>
    request('/api/project/topology/routes', {
      method: 'POST',
      body: payload,
    }),
  updateStoryRoute: (routeId: string, payload: UpdateStoryRoutePayload) =>
    request(`/api/project/topology/routes/${encodeURIComponent(routeId)}`, {
      method: 'PUT',
      body: payload,
    }),
  reorderStoryRouteChapters: (routeId: string, chapterIds: number[]) =>
    request(`/api/project/topology/routes/${encodeURIComponent(routeId)}/reorder`, {
      method: 'PUT',
      body: { chapterIds },
    }),
  removeStoryRoute: (routeId: string) =>
    request(`/api/project/topology/routes/${encodeURIComponent(routeId)}`, {
      method: 'DELETE',
    }),
  moveChapterToRoute: (chapterId: number, targetRouteId: string, targetIndex: number) =>
    request('/api/project/topology/move-chapter', {
      method: 'POST',
      body: { chapterId, targetRouteId, targetIndex },
    }),

  getWorkspaceConfig: () => request<WorkspaceConfig>('/api/project/config'),
  updateWorkspaceConfig: (patch: Record<string, unknown>) =>
    request<{ ok: boolean; config: WorkspaceConfig }>('/api/project/config', {
      method: 'PUT',
      body: patch,
    }),
  resetProject: (payload: Record<string, unknown>) =>
    request('/api/project/reset', {
      method: 'POST',
      body: payload,
    }),

  getHistory: () =>
    request<{ history: LlmRequestHistoryEntry[] }>('/api/project/history'),
  getLogs: () => request<{ logs: LogEntry[] }>('/api/events/logs'),
  clearLogs: () => request('/api/events/logs/clear', { method: 'POST' }),

  downloadExport: (format: string) =>
    requestBlob('/api/project/export', {
      method: 'POST',
      body: { format },
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

  getTranslators: () =>
    request<{ translators: Record<string, TranslatorEntry> }>(
      '/api/config/translators',
    ),
  getTranslatorWorkflows: () =>
    request<{ workflows: TranslationProcessorWorkflowMetadata[] }>(
      '/api/config/translator-workflows',
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
