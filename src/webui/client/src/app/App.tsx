import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as AntdApp, Form, Layout, Menu, Space, Spin, Tag, Typography } from 'antd';
import {
  ClockCircleOutlined,
  FolderOpenOutlined,
  PlusCircleOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api.ts';
import {
  auxToForm,
  buildTranslatorPayload,
  formatTranslatorLanguagePair,
  normalizeModelChain,
  parseLlmRequestConfigYaml,
  optionalNumber,
  optionalString,
  parseYamlObject,
  profileToForm,
  splitLines,
  translatorToForm,
  toErrorMessage,
  vectorStoreToForm,
} from './ui-helpers.ts';
import type {
  AlignmentRepairConfig,
  CreateStoryBranchPayload,
  GlossaryExtractorConfig,
  GlossaryTerm,
  GlossaryUpdaterConfig,
  LlmProfileConfig,
  ManagedWorkspace,
  PlotSummaryConfig,
  ProjectStatus,
  ProjectResourceVersions,
  RepetitionPatternAnalysisResult,
  SavedRepetitionPatternAnalysisResult,
  StoryTopologyDescriptor,
  TranslationProcessorWorkflowMetadata,
  TranslationProjectSnapshot,
  TranslatorEntry,
  UpdateStoryRoutePayload,
  VectorStoreConfig,
  VectorStoreConnectionStatus,
  WorkspaceChapterDescriptor,
} from './types.ts';
import { useEventStream } from './useEventStream.ts';
import { DictionaryEditorModal } from '../components/DictionaryEditorModal.tsx';
import type { ProjectCommand, TaskActivityKind } from '../components/WorkspaceView.tsx';

const LazyChapterTranslationEditorPage = lazy(async () => {
  const { ChapterTranslationEditorPage } = await import(
    '../features/chapter-editor/ChapterTranslationEditorPage.tsx'
  );
  return { default: ChapterTranslationEditorPage };
});

const LazyWorkspaceCreatePage = lazy(async () => {
  const { WorkspaceCreatePage } = await import(
    '../features/workspace-create/WorkspaceCreatePage.tsx'
  );
  return { default: WorkspaceCreatePage };
});

const LazyRecentWorkspacesView = lazy(async () => {
  const { RecentWorkspacesView } = await import('../components/RecentWorkspacesView.tsx');
  return { default: RecentWorkspacesView };
});

const LazySettingsView = lazy(async () => {
  const { SettingsView } = await import('../components/SettingsView.tsx');
  return { default: SettingsView };
});

const LazyWorkspaceView = lazy(async () => {
  const { WorkspaceView } = await import('../components/WorkspaceView.tsx');
  return { default: WorkspaceView };
});

function RouteLoadingFallback() {
  return (
    <div
      style={{
        minHeight: 240,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Spin size="large" tip="正在加载页面..." />
    </div>
  );
}

const { Header, Sider, Content } = Layout;

type SettingsSection =
  | 'llmProfiles'
  | 'embedding'
  | 'vector'
  | 'translator'
  | 'extractor'
  | 'updater'
  | 'plot'
  | 'alignment';

type SettingsLoadingState = Record<SettingsSection, boolean>;

const INITIAL_SETTINGS_LOADING: SettingsLoadingState = {
  llmProfiles: false,
  embedding: false,
  vector: false,
  translator: false,
  extractor: false,
  updater: false,
  plot: false,
  alignment: false,
};

export function AppShell() {
  const { message } = AntdApp.useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<ManagedWorkspace[]>([]);
  const [projectStatus, setProjectStatus] = useState<ProjectStatus | null>(null);
  const [snapshot, setSnapshot] = useState<TranslationProjectSnapshot | null>(null);
  const [dictionary, setDictionary] = useState<GlossaryTerm[]>([]);
  const [repeatedPatterns, setRepeatedPatterns] = useState<SavedRepetitionPatternAnalysisResult | null>(
    null,
  );
  const repeatedPatternsRef = useRef<SavedRepetitionPatternAnalysisResult | null>(null);
  const chaptersRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const topologyRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const [chapters, setChapters] = useState<WorkspaceChapterDescriptor[]>([]);
  const [topology, setTopology] = useState<StoryTopologyDescriptor | null>(null);
  const [dictionaryModalOpen, setDictionaryModalOpen] = useState(false);
  const [editingTerm, setEditingTerm] = useState<GlossaryTerm | null>(null);
  const [settingsLoading, setSettingsLoading] = useState<SettingsLoadingState>(
    INITIAL_SETTINGS_LOADING,
  );
  const [importingWorkspaceArchive, setImportingWorkspaceArchive] = useState(false);
  const [exportingWorkspaceArchiveDir, setExportingWorkspaceArchiveDir] = useState<
    string | null
  >(null);
  const [llmProfiles, setLlmProfiles] = useState<Record<string, LlmProfileConfig>>({});
  const [defaultLlmName, setDefaultLlmName] = useState<string>();
  const [translators, setTranslators] = useState<Record<string, TranslatorEntry>>({});
  const [translatorWorkflows, setTranslatorWorkflows] = useState<
    TranslationProcessorWorkflowMetadata[]
  >([]);
  const [embeddingConfig, setEmbeddingConfig] = useState<LlmProfileConfig | null>(null);
  const [vectorConfig, setVectorConfig] = useState<VectorStoreConfig | null>(null);
  const [vectorConnectionStatus, setVectorConnectionStatus] =
    useState<VectorStoreConnectionStatus>({ state: 'idle' });
  const [extractorConfig, setExtractorConfig] = useState<GlossaryExtractorConfig | null>(null);
  const [updaterConfig, setUpdaterConfig] = useState<GlossaryUpdaterConfig | null>(null);
  const [plotConfig, setPlotConfig] = useState<PlotSummaryConfig | null>(null);
  const [alignmentConfig, setAlignmentConfig] = useState<AlignmentRepairConfig | null>(null);
  const [selectedLlmName, setSelectedLlmName] = useState<string>();
  const [selectedTranslatorName, setSelectedTranslatorName] = useState<string>();
  const workspaceResourceVersionsRef = useRef<ProjectResourceVersions>({
    dictionaryRevision: 0,
    chaptersRevision: 0,
    topologyRevision: 0,
    workspaceConfigRevision: 0,
    repetitionPatternsRevision: 0,
  });

  const [workspaceForm] = Form.useForm<Record<string, unknown>>();
  const [dictionaryForm] = Form.useForm<Record<string, unknown>>();
  const [llmForm] = Form.useForm<Record<string, unknown>>();
  const [embeddingForm] = Form.useForm<Record<string, unknown>>();
  const [vectorForm] = Form.useForm<Record<string, unknown>>();
  const [translatorForm] = Form.useForm<Record<string, unknown>>();
  const [extractorForm] = Form.useForm<Record<string, unknown>>();
  const [updaterForm] = Form.useForm<Record<string, unknown>>();
  const [plotForm] = Form.useForm<Record<string, unknown>>();
  const [alignmentForm] = Form.useForm<Record<string, unknown>>();
  const defaultImportFormat = Form.useWatch('defaultImportFormat', workspaceForm);
  const workflowMap = useMemo(
    () =>
      new Map(
        translatorWorkflows.map((workflow) => [workflow.workflow, workflow] as const),
      ),
    [translatorWorkflows],
  );

  const runAction = useCallback(
    async (action: () => Promise<void>) => {
      try {
        await action();
      } catch (error) {
        message.error(toErrorMessage(error));
      }
    },
    [message],
  );

  const runSettingsAction = useCallback(
    async (sections: SettingsSection[], action: () => Promise<void>) => {
      setSettingsLoading((prev) => {
        const next = { ...prev };
        for (const section of sections) {
          next[section] = true;
        }
        return next;
      });
      try {
        await action();
      } finally {
        setSettingsLoading((prev) => {
          const next = { ...prev };
          for (const section of sections) {
            next[section] = false;
          }
          return next;
        });
      }
    },
    [],
  );

  const refreshBootData = useCallback(async () => {
    const [workspaceRes, activeRes, translatorsRes, llmRes] = await Promise.all([
      api.listWorkspaces(),
      api.getActiveProject(),
      api.getTranslators().catch(() => ({ translators: {} })),
      api.getLlmProfiles().catch(() => ({ profiles: {}, defaultName: undefined })),
    ]);
    setWorkspaces(workspaceRes.workspaces);
    setProjectStatus(activeRes);
    setSnapshot(activeRes.snapshot);
    setTranslators(translatorsRes.translators);
    setLlmProfiles(llmRes.profiles);
    setDefaultLlmName(llmRes.defaultName);
  }, []);

  const refreshProjectStatus = useCallback(async () => {
    const status = await api.getProjectStatus();
    setProjectStatus(status);
    setSnapshot(status.snapshot);
  }, []);

  const resetWorkspaceResourceVersions = useCallback((value = 0) => {
    workspaceResourceVersionsRef.current = {
      dictionaryRevision: value,
      chaptersRevision: value,
      topologyRevision: value,
      workspaceConfigRevision: value,
      repetitionPatternsRevision: value,
    };
  }, []);

  const resetWorkspaceDataCaches = useCallback(() => {
    setDictionary([]);
    setRepeatedPatterns(null);
    setChapters([]);
    setTopology(null);
    workspaceForm.resetFields();
    resetWorkspaceResourceVersions(0);
  }, [resetWorkspaceResourceVersions, workspaceForm]);

  const refreshDictionary = useCallback(async () => {
    let nextRevision: number | undefined;
    try {
      const versions = await api.getProjectResourceVersions();
      nextRevision = versions.dictionaryRevision;
      if (nextRevision === workspaceResourceVersionsRef.current.dictionaryRevision) {
        return;
      }
    } catch {
      // ignore version probe failures and fall back to direct fetch
    }
    const dictionaryRes = await api.getDictionary().catch(() => ({ terms: [] }));
    setDictionary(dictionaryRes.terms);
    workspaceResourceVersionsRef.current = {
      ...workspaceResourceVersionsRef.current,
      dictionaryRevision:
        nextRevision ?? workspaceResourceVersionsRef.current.dictionaryRevision + 1,
    };
  }, []);

  useEffect(() => {
    repeatedPatternsRef.current = repeatedPatterns;
  }, [repeatedPatterns]);

  const refreshRepeatedPatterns = useCallback(
    async (options?: { chapterIds?: number[] }) => {
      let nextRevision: number | undefined;
      try {
        const versions = await api.getProjectResourceVersions();
        nextRevision = versions.repetitionPatternsRevision;
        if (
          nextRevision === workspaceResourceVersionsRef.current.repetitionPatternsRevision &&
          !options?.chapterIds?.length
        ) {
          return repeatedPatternsRef.current;
        }
      } catch {
        // ignore version probe failures and fall back to direct fetch
      }
      const result = await api.getRepeatedPatterns(options);
      setRepeatedPatterns(result);
      workspaceResourceVersionsRef.current = {
        ...workspaceResourceVersionsRef.current,
        repetitionPatternsRevision:
          nextRevision ?? workspaceResourceVersionsRef.current.repetitionPatternsRevision + 1,
      };
      return result;
    },
    [],
  );

  const scanRepeatedPatterns = useCallback(
    async (options?: {
      minOccurrences?: number;
      minLength?: number;
      maxResults?: number;
    }) => {
      const result = await api.scanRepeatedPatterns(options);
      setRepeatedPatterns(result);
      workspaceResourceVersionsRef.current = {
        ...workspaceResourceVersionsRef.current,
        repetitionPatternsRevision: workspaceResourceVersionsRef.current.repetitionPatternsRevision + 1,
      };
      return result;
    },
    [],
  );

  const hydrateRepeatedPatterns = useCallback(
    async (input: { chapterIds?: number[]; patternTexts?: string[] }) =>
      api.hydrateRepeatedPatterns(input),
    [],
  );

  const handleSaveRepeatedPatternTranslation = useCallback(
    async (input: {
      chapterId: number;
      fragmentIndex: number;
      lineIndex: number;
      translation: string;
    }) => {
      await api.saveRepeatedPatternTranslation(input);
      await refreshProjectStatus();
    },
    [refreshProjectStatus],
  );

  const handleLoadRepeatedPatternContext = useCallback(
    async (input: { chapterId: number; unitIndex: number }) =>
      api.getRepeatedPatternContext(input),
    [],
  );

  const handleStartRepeatedPatternConsistencyFix = useCallback(
    async (input: {
      llmProfileName: string;
      chapterIds?: number[];
    }) => api.startRepeatedPatternConsistencyFix(input),
    [],
  );

  const handleGetRepeatedPatternConsistencyFixStatus = useCallback(
    async () => api.getRepeatedPatternConsistencyFixStatus(),
    [],
  );

  const handleClearRepeatedPatternConsistencyFixStatus = useCallback(
    async () => {
      await api.clearRepeatedPatternConsistencyFixStatus();
    },
    [],
  );

  const refreshChapters = useCallback(() => {
    if (chaptersRefreshPromiseRef.current) {
      return chaptersRefreshPromiseRef.current;
    }

    const refreshPromise = (async () => {
      let nextRevision: number | undefined;
      try {
        const versions = await api.getProjectResourceVersions();
        nextRevision = versions.chaptersRevision;
        if (nextRevision === workspaceResourceVersionsRef.current.chaptersRevision) {
          return;
        }
      } catch {
        // ignore version probe failures and fall back to direct fetch
      }
      const chaptersRes = await api.getChapters().catch(() => ({ chapters: [] }));
      setChapters(chaptersRes.chapters);
      workspaceResourceVersionsRef.current = {
        ...workspaceResourceVersionsRef.current,
        chaptersRevision:
          nextRevision ?? workspaceResourceVersionsRef.current.chaptersRevision + 1,
      };
    })();

    chaptersRefreshPromiseRef.current = refreshPromise;
    refreshPromise.finally(() => {
      if (chaptersRefreshPromiseRef.current === refreshPromise) {
        chaptersRefreshPromiseRef.current = null;
      }
    });
    return refreshPromise;
  }, []);

  const refreshTopology = useCallback(() => {
    if (topologyRefreshPromiseRef.current) {
      return topologyRefreshPromiseRef.current;
    }

    const refreshPromise = (async () => {
      let nextRevision: number | undefined;
      try {
        const versions = await api.getProjectResourceVersions();
        nextRevision = versions.topologyRevision;
        if (nextRevision === workspaceResourceVersionsRef.current.topologyRevision) {
          return;
        }
      } catch {
        // ignore version probe failures and fall back to direct fetch
      }
      const topologyRes = await api.getTopology().catch(() => ({ topology: null }));
      setTopology(topologyRes.topology);
      workspaceResourceVersionsRef.current = {
        ...workspaceResourceVersionsRef.current,
        topologyRevision:
          nextRevision ?? workspaceResourceVersionsRef.current.topologyRevision + 1,
      };
    })();

    topologyRefreshPromiseRef.current = refreshPromise;
    refreshPromise.finally(() => {
      if (topologyRefreshPromiseRef.current === refreshPromise) {
        topologyRefreshPromiseRef.current = null;
      }
    });
    return refreshPromise;
  }, []);

  const refreshWorkspaceConfig = useCallback(async () => {
    let nextRevision: number | undefined;
    try {
      const versions = await api.getProjectResourceVersions();
      nextRevision = versions.workspaceConfigRevision;
      if (nextRevision === workspaceResourceVersionsRef.current.workspaceConfigRevision) {
        return;
      }
    } catch {
      // ignore version probe failures and fall back to direct fetch
    }
    const configRes = await api.getWorkspaceConfig().catch(() => null);
    if (!configRes) {
      return;
    }

    workspaceForm.setFieldsValue({
      projectName: configRes.projectName,
      glossaryPath: configRes.glossary.path,
      translatorName: configRes.translator.translatorName,
      defaultImportFormat: configRes.defaultImportFormat,
      defaultExportFormat: configRes.defaultExportFormat,
      customRequirements: configRes.customRequirements.join('\n'),
    });
    workspaceResourceVersionsRef.current = {
      ...workspaceResourceVersionsRef.current,
      workspaceConfigRevision:
        nextRevision ?? workspaceResourceVersionsRef.current.workspaceConfigRevision + 1,
    };
  }, [workspaceForm]);

  const selectLlmProfile = useCallback((name: string) => {
    setSelectedLlmName(name);
  }, []);

  const selectTranslator = useCallback(
    (name: string) => {
      setSelectedTranslatorName(name);
    },
    [],
  );

  const refreshSettings = useCallback(async () => {
    await runSettingsAction(Object.keys(INITIAL_SETTINGS_LOADING) as SettingsSection[], async () => {
      const [
        llmRes,
        embeddingRes,
        vectorRes,
        translatorsRes,
        workflowRes,
        extractorRes,
        updaterRes,
        plotRes,
        alignmentRes,
      ] = await Promise.all([
        api.getLlmProfiles(),
        api.getEmbeddingConfig(),
        api.getVectorStores(),
        api.getTranslators(),
        api.getTranslatorWorkflows(),
        api.getGlossaryExtractor(),
        api.getGlossaryUpdater(),
        api.getPlotSummaryConfig(),
        api.getAlignmentRepairConfig(),
      ]);

      setLlmProfiles(llmRes.profiles);
      setDefaultLlmName(llmRes.defaultName);
      setEmbeddingConfig(embeddingRes);
      setVectorConfig(vectorRes.config);
      setVectorConnectionStatus(vectorRes.status);
      setTranslators(translatorsRes.translators);
      setTranslatorWorkflows(workflowRes.workflows);
      setExtractorConfig(extractorRes as GlossaryExtractorConfig | null);
      setUpdaterConfig(updaterRes as GlossaryUpdaterConfig | null);
      setPlotConfig(plotRes as PlotSummaryConfig | null);
      setAlignmentConfig(alignmentRes as AlignmentRepairConfig | null);
      setSelectedLlmName((current) => {
        if (current && llmRes.profiles[current]) {
          return current;
        }
        return llmRes.defaultName ?? Object.keys(llmRes.profiles)[0];
      });
      setSelectedTranslatorName((current) => {
        if (current && translatorsRes.translators[current]) {
          return current;
        }
        return Object.keys(translatorsRes.translators)[0];
      });
    });
  }, [runSettingsAction]);

  const eventHandlers = useMemo(
    () => ({
      onSnapshot: (nextSnapshot: TranslationProjectSnapshot | null) => {
        setSnapshot(nextSnapshot);
        setProjectStatus((prev) =>
          prev
            ? {
                ...prev,
                hasProject: nextSnapshot !== null,
                snapshot: nextSnapshot,
              }
            : {
                hasProject: nextSnapshot !== null,
                isBusy: false,
                plotSummaryReady: false,
                plotSummaryProgress: null,
                scanDictionaryProgress: null,
                snapshot: nextSnapshot,
              },
        );
      },
      onScanProgress: (progress: ProjectStatus['scanDictionaryProgress']) =>
        {
          setProjectStatus((prev) =>
            prev
              ? {
                  ...prev,
                  isBusy: progress?.status === 'running',
                  scanDictionaryProgress: progress,
                }
              : prev,
          );
          if (progress && progress.status !== 'running') {
            void refreshProjectStatus().catch(() => undefined);
          }
        },
      onPlotProgress: (progress: ProjectStatus['plotSummaryProgress']) =>
        {
          setProjectStatus((prev) =>
            prev
              ? {
                  ...prev,
                  isBusy: progress?.status === 'running',
                  plotSummaryReady:
                    progress?.status === 'done' ? true : prev.plotSummaryReady,
                  plotSummaryProgress: progress,
                }
              : prev,
          );
          if (progress && progress.status !== 'running') {
            void refreshProjectStatus().catch(() => undefined);
          }
        },
    }),
    [refreshProjectStatus],
  );

  const { connected } = useEventStream(eventHandlers);

  useEffect(() => {
    void refreshBootData();
  }, [refreshBootData]);

  useEffect(() => {
    if (location.pathname === '/settings') {
      void refreshSettings();
    }
  }, [location.pathname, refreshSettings]);

  useEffect(() => {
    resetWorkspaceDataCaches();
  }, [resetWorkspaceDataCaches, snapshot?.projectName]);

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    void refreshRepeatedPatterns().catch(() => {
      setRepeatedPatterns(null);
    });
  }, [refreshRepeatedPatterns, snapshot]);

  useEffect(() => {
    if (location.pathname !== '/settings') {
      return;
    }

    if (selectedLlmName && llmProfiles[selectedLlmName]) {
      llmForm.setFieldsValue(profileToForm(llmProfiles[selectedLlmName], selectedLlmName));
      return;
    }

    llmForm.resetFields();
  }, [llmForm, llmProfiles, selectedLlmName, location.pathname]);

  useEffect(() => {
    if (location.pathname !== '/settings') {
      return;
    }

    if (selectedTranslatorName && translators[selectedTranslatorName]) {
      const translator = translators[selectedTranslatorName];
      const workflow =
        workflowMap.get(translator.type ?? 'default') ??
        workflowMap.get('default') ??
        translatorWorkflows[0];
      translatorForm.resetFields();
      translatorForm.setFieldsValue(
        translatorToForm(translator, selectedTranslatorName, workflow) as Record<
          string,
          {} | undefined
        >,
      );
      return;
    }

    translatorForm.resetFields();
    translatorForm.setFieldsValue(
      translatorToForm(
        null,
        undefined,
        workflowMap.get('default') ?? translatorWorkflows[0],
      ) as Record<string, {} | undefined>,
    );
  }, [
    location.pathname,
    selectedTranslatorName,
    translatorForm,
    translators,
    translatorWorkflows,
    workflowMap,
  ]);

  useEffect(() => {
    if (location.pathname !== '/settings') {
      return;
    }
    embeddingForm.setFieldsValue(profileToForm(embeddingConfig, 'embedding'));
  }, [embeddingConfig, embeddingForm, location.pathname]);

  useEffect(() => {
    if (location.pathname !== '/settings') {
      return;
    }
    vectorForm.setFieldsValue(vectorStoreToForm(vectorConfig));
  }, [location.pathname, vectorConfig, vectorForm]);

  useEffect(() => {
    if (location.pathname !== '/settings') {
      return;
    }
    extractorForm.setFieldsValue(auxToForm(extractorConfig));
  }, [extractorConfig, extractorForm, location.pathname]);

  useEffect(() => {
    if (location.pathname !== '/settings') {
      return;
    }
    updaterForm.setFieldsValue(auxToForm(updaterConfig));
  }, [location.pathname, updaterConfig, updaterForm]);

  useEffect(() => {
    if (location.pathname !== '/settings') {
      return;
    }
    plotForm.setFieldsValue(auxToForm(plotConfig));
  }, [location.pathname, plotConfig, plotForm]);

  useEffect(() => {
    if (location.pathname !== '/settings') {
      return;
    }
    alignmentForm.setFieldsValue(auxToForm(alignmentConfig));
  }, [alignmentConfig, alignmentForm, location.pathname]);

  const translatorOptions = useMemo(
    () =>
      Object.keys(translators).map((name) => ({
        label: translators[name]?.metadata?.title
          ? `${translators[name].metadata?.title} (${name}, ${formatTranslatorLanguagePair(translators[name])})`
          : `${name} (${formatTranslatorLanguagePair(translators[name])})`,
        value: name,
      })),
    [translators],
  );

  const llmProfileOptions = useMemo(
    () =>
      Object.keys(llmProfiles)
        .sort()
        .map((name) => ({
          label: name,
          value: name,
        })),
    [llmProfiles],
  );

  const handleOpenWorkspace = useCallback(
    async (workspace: ManagedWorkspace) => {
      await runAction(async () => {
        await api.openWorkspace(workspace.dir, workspace.name);
        await refreshBootData();
        resetWorkspaceDataCaches();
        navigate('/workspace/current');
        message.success(`已打开工作区：${workspace.name}`);
      });
    },
    [message, navigate, refreshBootData, resetWorkspaceDataCaches, runAction],
  );

  const handleDeleteWorkspace = useCallback(
    async (workspace: ManagedWorkspace) => {
      await runAction(async () => {
        await api.deleteWorkspace(workspace.dir);
        await refreshBootData();
        message.success(`已删除工作区：${workspace.name}`);
      });
    },
    [message, refreshBootData, runAction],
  );

  const handleImportWorkspaceArchive = useCallback(
    async (file: File) => {
      if (importingWorkspaceArchive) {
        return;
      }

      setImportingWorkspaceArchive(true);
      try {
        const result = await api.importWorkspaceArchive(file);
        await refreshBootData();
        message.success(`工作区已导入：${result.manifest.projectName}`);
      } catch (error) {
        message.error(toErrorMessage(error));
      } finally {
        setImportingWorkspaceArchive(false);
      }
    },
    [importingWorkspaceArchive, message, refreshBootData],
  );

  const handleExportWorkspaceArchive = useCallback(
    async (workspace: ManagedWorkspace) => {
      if (exportingWorkspaceArchiveDir === workspace.dir) {
        return;
      }

      setExportingWorkspaceArchiveDir(workspace.dir);
      try {
        const blob = await api.downloadWorkspaceArchive(workspace.dir);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${workspace.name}-workspace.zip`;
        link.click();
        URL.revokeObjectURL(url);
        message.success(`已开始导出工作区：${workspace.name}`);
      } catch (error) {
        message.error(toErrorMessage(error));
      } finally {
        setExportingWorkspaceArchiveDir(null);
      }
    },
    [exportingWorkspaceArchiveDir, message],
  );

  const handleProjectCommand = useCallback(
    async (command: ProjectCommand) => {
      await runAction(async () => {
        switch (command) {
          case 'start':
            await api.startTranslation();
            await refreshProjectStatus();
            message.success('翻译已启动');
            break;
          case 'pause':
            await api.pauseTranslation();
            await refreshProjectStatus();
            message.success('暂停请求已提交');
            break;
          case 'resume':
            await api.resumeTranslation();
            await refreshProjectStatus();
            message.success('翻译已恢复');
            break;
          case 'abort':
            await api.abortTranslation();
            await refreshProjectStatus();
            message.success('翻译已中止');
            break;
          case 'scan':
            await api.scanDictionary();
            await refreshProjectStatus();
            message.success('已开始扫描术语表');
            break;
          case 'plot':
            await api.startPlotSummary();
            await refreshProjectStatus();
            message.success('已开始生成情节大纲');
            break;
          case 'close':
            await api.closeWorkspace();
            await refreshBootData();
            resetWorkspaceDataCaches();
            navigate('/workspaces/recent');
            message.success('已关闭工作区');
            break;
          case 'remove':
            await api.removeCurrentWorkspace();
            await refreshBootData();
            resetWorkspaceDataCaches();
            navigate('/workspaces/recent');
            message.success('已移除工作区');
            break;
        }
      });
    },
    [message, navigate, refreshBootData, resetWorkspaceDataCaches, runAction],
  );

  const openDictionaryEditor = useCallback(
    (record?: GlossaryTerm) => {
      setEditingTerm(record ?? null);
      dictionaryForm.setFieldsValue({
        originalTerm: record?.term,
        term: record?.term,
        translation: record?.translation,
        description: record?.description,
        category: record?.category,
        status: record?.status,
      });
      if (!record) {
        dictionaryForm.resetFields();
      }
      setDictionaryModalOpen(true);
    },
    [dictionaryForm],
  );

  const handleSaveDictionary = useCallback(
    async (values: Record<string, unknown>) => {
      await runAction(async () => {
        await api.saveDictionaryTerm(
          values as Partial<GlossaryTerm> & { term: string },
        );
        setDictionaryModalOpen(false);
        await Promise.all([refreshDictionary(), refreshProjectStatus()]);
        message.success('术语条目已保存');
      });
    },
    [message, refreshDictionary, refreshProjectStatus, runAction],
  );

  const handleDeleteDictionary = useCallback(
    async (term: string) => {
      await runAction(async () => {
        await api.deleteDictionaryTerm(term);
        await Promise.all([refreshDictionary(), refreshProjectStatus()]);
        message.success('术语条目已删除');
      });
    },
    [message, refreshDictionary, refreshProjectStatus, runAction],
  );

  const handleImportDictionaryFromContent = useCallback(
    async (content: string, format: 'csv' | 'tsv') => {
      try {
        const result = await api.importDictionaryFromContent(content, format);
        await Promise.all([refreshDictionary(), refreshProjectStatus()]);
        message.success(
          `术语导入完成：${result.termCount} 项（新增 ${result.newTermCount}，更新 ${result.updatedTermCount}）`,
        );
        return result;
      } catch (error) {
        message.error(toErrorMessage(error));
        throw error;
      }
    },
    [message, refreshDictionary, refreshProjectStatus],
  );

  const handleWorkspaceConfigSave = useCallback(
    async (values: Record<string, unknown>) => {
      await runAction(async () => {
        await api.updateWorkspaceConfig({
          projectName: String(values.projectName ?? ''),
          glossary: {
            path: String(values.glossaryPath ?? '').trim() || undefined,
          },
          translator: {
            translatorName: String(values.translatorName ?? '').trim(),
          },
          defaultImportFormat: String(values.defaultImportFormat ?? '') || null,
          defaultExportFormat: String(values.defaultExportFormat ?? '') || null,
          customRequirements: splitLines(String(values.customRequirements ?? '')),
        });
        await Promise.all([
          refreshWorkspaceConfig(),
          refreshProjectStatus(),
          refreshBootData(),
        ]);
        message.success('工作区配置已保存');
      });
    },
    [message, refreshBootData, refreshProjectStatus, refreshWorkspaceConfig, runAction],
  );

  const handleClearChapterTranslations = useCallback(
    async (chapterIds: number[]) => {
      await runAction(async () => {
        await api.clearChapterTranslations(chapterIds);
        await Promise.all([refreshChapters(), refreshProjectStatus()]);
        message.success('章节译文已清空');
      });
    },
    [message, refreshChapters, refreshProjectStatus, runAction],
  );

  const handleRemoveChapters = useCallback(
    async (
      chapterIds: number[],
      options: { cascadeBranches?: boolean } = {},
    ) => {
      if (chapterIds.length === 0) {
        return;
      }
      await runAction(async () => {
        await api.removeChapters(chapterIds, options);
        await Promise.all([refreshChapters(), refreshTopology(), refreshProjectStatus()]);
        message.success(
          chapterIds.length === 1
            ? '章节已移除'
            : `已移除 ${chapterIds.length} 个章节`,
        );
      });
    },
    [message, refreshChapters, refreshProjectStatus, refreshTopology, runAction],
  );

  const handleImportChapterArchive = useCallback(
    async (payload: {
      file: File;
      importFormat?: string;
      importPattern?: string;
      importTranslation?: boolean;
    }) => {
      const formData = new FormData();
      formData.set('file', payload.file);
      if (payload.importFormat) {
        formData.set('importFormat', payload.importFormat);
      }
      if (payload.importPattern) {
        formData.set('importPattern', payload.importPattern);
      }
      if (payload.importTranslation !== undefined) {
        formData.set('importTranslation', String(payload.importTranslation));
      }

      const result = await api.importChapterArchive(formData);
      if (result.addedCount > 0) {
        await Promise.all([refreshChapters(), refreshTopology(), refreshProjectStatus()]);
      }
      return result;
    },
    [refreshChapters, refreshProjectStatus, refreshTopology],
  );

  const handleCreateStoryBranch = useCallback(
    async (payload: CreateStoryBranchPayload) => {
      try {
        await api.createStoryBranch(payload);
        await Promise.all([refreshChapters(), refreshTopology()]);
        message.success(`分支“${payload.name}”已创建`);
      } catch (error) {
        message.error(toErrorMessage(error));
        throw error;
      }
    },
    [message, refreshChapters, refreshTopology],
  );

  const handleUpdateStoryRoute = useCallback(
    async (routeId: string, payload: UpdateStoryRoutePayload) => {
      await runAction(async () => {
        await api.updateStoryRoute(routeId, payload);
        await Promise.all([refreshChapters(), refreshTopology()]);
        message.success('路线已更新');
      });
    },
    [message, refreshChapters, refreshTopology, runAction],
  );

  const handleReorderStoryRouteChapters = useCallback(
    async (routeId: string, chapterIds: number[]) => {
      await runAction(async () => {
        await api.reorderStoryRouteChapters(routeId, chapterIds);
        await Promise.all([refreshChapters(), refreshTopology()]);
        message.success('路线内章节顺序已更新');
      });
    },
    [message, refreshChapters, refreshTopology, runAction],
  );

  const handleRemoveStoryRoute = useCallback(
    async (routeId: string) => {
      await runAction(async () => {
        await api.removeStoryRoute(routeId);
        await Promise.all([refreshChapters(), refreshTopology()]);
        message.success('路线已删除');
      });
    },
    [message, refreshChapters, refreshTopology, runAction],
  );

  const handleMoveChapterToRoute = useCallback(
    async (chapterId: number, targetRouteId: string, targetIndex: number) => {
      await runAction(async () => {
        await api.moveChapterToRoute(chapterId, targetRouteId, targetIndex);
        await Promise.all([refreshChapters(), refreshTopology()]);
        message.success('章节已移动');
      });
    },
    [message, refreshChapters, refreshTopology, runAction],
  );

  const handleDownloadExport= useCallback(
    async (format: string) => {
      await runAction(async () => {
        const blob = await api.downloadExport(format);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${snapshot?.projectName ?? 'soloyakusha'}-${format}.zip`;
        link.click();
        URL.revokeObjectURL(url);
        message.success('导出已开始下载');
      });
    },
    [message, runAction, snapshot?.projectName],
  );

  const handleResetProject = useCallback(
    async (payload: Record<string, unknown>, successText: string) => {
      await runAction(async () => {
        await api.resetProject(payload);
        await Promise.all([
          refreshDictionary(),
          refreshChapters(),
          refreshTopology(),
          refreshWorkspaceConfig(),
          refreshProjectStatus(),
        ]);
        message.success(successText);
      });
    },
    [
      message,
      refreshChapters,
      refreshDictionary,
      refreshProjectStatus,
      refreshTopology,
      refreshWorkspaceConfig,
      runAction,
    ],
  );

  const handleClearLogs = useCallback(async () => {
    await runAction(async () => {
      await api.clearLogs();
      message.success('日志已清空');
    });
  }, [message, runAction]);

  const handleDismissTaskActivity = useCallback(
    async (task: TaskActivityKind) => {
      await runAction(async () => {
        await api.clearTaskProgress(task);
      });
    },
    [runAction],
  );

  const handleCreateLlmProfile = useCallback(() => {
    setSelectedLlmName(undefined);
    llmForm.resetFields();
    llmForm.setFieldsValue({
      modelType: 'chat',
      provider: 'openai',
      retries: 2,
    });
  }, [llmForm]);

  const handleSaveLlmProfile = useCallback(
    async (values: Record<string, unknown>) => {
      await runAction(async () => {
        const name = String(values.profileName ?? '').trim();
        if (!name) {
          throw new Error('Profile 名称不能为空');
        }
        const payload: LlmProfileConfig = {
          provider: values.provider as 'openai' | 'anthropic',
          modelName: String(values.modelName ?? ''),
          endpoint: String(values.endpoint ?? ''),
          apiKey: optionalString(values.apiKey),
          apiKeyEnv: optionalString(values.apiKeyEnv),
          qps: optionalNumber(values.qps),
          maxParallelRequests: optionalNumber(values.maxParallelRequests),
          modelType: (values.modelType as 'chat' | 'embedding') ?? 'chat',
          retries: optionalNumber(values.retries) ?? 2,
          defaultRequestConfig: parseLlmRequestConfigYaml(
            values.defaultRequestConfigYaml,
          ),
        };
        await runSettingsAction(['llmProfiles'], async () => {
          await api.saveLlmProfile(name, payload);
          setLlmProfiles((prev) => ({
            ...prev,
            [name]: payload,
          }));
          setSelectedLlmName(name);
        });
        message.success('LLM Profile 已保存');
      });
    },
    [message, runAction, runSettingsAction],
  );

  const handleSetDefaultLlmProfile = useCallback(async () => {
    if (!selectedLlmName) {
      return;
    }
    await runAction(async () => {
      await runSettingsAction(['llmProfiles'], async () => {
        await api.setDefaultLlmProfile(selectedLlmName);
        setDefaultLlmName(selectedLlmName);
      });
      message.success('默认 LLM 已更新');
    });
  }, [message, runAction, runSettingsAction, selectedLlmName]);

  const handleDeleteLlmProfile = useCallback(async () => {
    if (!selectedLlmName) {
      return;
    }
    await runAction(async () => {
      await runSettingsAction(['llmProfiles'], async () => {
        await api.deleteLlmProfile(selectedLlmName);
        const nextProfiles = { ...llmProfiles };
        delete nextProfiles[selectedLlmName];
        setLlmProfiles(nextProfiles);
        setDefaultLlmName((current) =>
          current === selectedLlmName ? undefined : current,
        );
        setSelectedLlmName((current) => {
          if (current !== selectedLlmName) {
            return current;
          }
          return defaultLlmName === selectedLlmName
            ? Object.keys(nextProfiles)[0]
            : defaultLlmName;
        });
      });
      message.success('Profile 已删除');
    });
  }, [defaultLlmName, llmProfiles, message, runAction, runSettingsAction, selectedLlmName]);

  const handleSaveEmbedding = useCallback(
    async (values: Record<string, unknown>) => {
      await runAction(async () => {
        const payload: LlmProfileConfig = {
          provider: values.provider as 'openai' | 'anthropic',
          modelName: String(values.modelName ?? ''),
          endpoint: String(values.endpoint ?? ''),
          apiKey: optionalString(values.apiKey),
          apiKeyEnv: optionalString(values.apiKeyEnv),
          qps: optionalNumber(values.qps),
          maxParallelRequests: optionalNumber(values.maxParallelRequests),
          modelType: 'embedding',
          retries: optionalNumber(values.retries) ?? 2,
          defaultRequestConfig: parseLlmRequestConfigYaml(
            values.defaultRequestConfigYaml,
          ),
        };
        await runSettingsAction(['embedding'], async () => {
          await api.saveEmbeddingConfig(payload);
          setEmbeddingConfig(payload);
        });
        message.success('Embedding 配置已保存');
      });
    },
    [message, runAction, runSettingsAction],
  );

  const buildVectorStorePayload = useCallback((values: Record<string, unknown>) => {
    return {
      provider: (values.provider as VectorStoreConfig['provider']) ?? 'qdrant',
      endpoint: String(values.endpoint ?? ''),
      apiKey: optionalString(values.apiKey),
      apiKeyEnv: optionalString(values.apiKeyEnv),
      defaultCollection: optionalString(values.defaultCollection),
      distance: (values.distance as VectorStoreConfig['distance']) ?? 'cosine',
      timeoutMs: optionalNumber(values.timeoutMs) ?? 60_000,
      retries: optionalNumber(values.retries) ?? 3,
    } satisfies VectorStoreConfig;
  }, []);

  const handleSaveVectorStore = useCallback(
    async (values: Record<string, unknown>) => {
      await runAction(async () => {
        const payload = buildVectorStorePayload(values);
        let connection: VectorStoreConnectionStatus | undefined;
        await runSettingsAction(['vector'], async () => {
          const result = await api.saveVectorStore(payload);
          connection = result.connection;
          setVectorConfig(payload);
          setVectorConnectionStatus(result.connection);
        });
        if (connection?.state === 'connected') {
          message.success('向量数据库配置已保存，并已成功连接');
        } else {
          message.warning(
            `向量数据库配置已保存，但连接失败：${connection?.error ?? '未知错误'}`,
          );
        }
      });
    },
    [buildVectorStorePayload, message, runAction, runSettingsAction],
  );

  const handleConnectVectorStore = useCallback(async () => {
    await runAction(async () => {
      const values = await vectorForm.validateFields();
      const payload = buildVectorStorePayload(values);
      await runSettingsAction(['vector'], async () => {
        const result = await api.connectVectorStore({ config: payload });
        setVectorConnectionStatus(result.connection);
        if (result.connection.state === 'connected') {
          message.success('向量数据库连接成功');
        } else {
          message.warning(`连接失败：${result.connection.error ?? '未知错误'}`);
        }
      });
    });
  }, [buildVectorStorePayload, message, runAction, runSettingsAction, vectorForm]);

  const handleDeleteVectorStore = useCallback(async () => {
    if (!vectorConfig) {
      return;
    }
    await runAction(async () => {
      await runSettingsAction(['vector'], async () => {
        await api.deleteVectorStore();
        setVectorConfig(null);
        setVectorConnectionStatus({ state: 'idle' });
      });
      message.success('向量数据库配置已删除');
    });
  }, [message, runAction, runSettingsAction, vectorConfig]);

  const handleCreateTranslator = useCallback(() => {
    setSelectedTranslatorName(undefined);
    translatorForm.resetFields();
    translatorForm.setFieldsValue(
      translatorToForm(
        null,
        undefined,
        workflowMap.get('default') ?? translatorWorkflows[0],
      ) as Record<string, {} | undefined>,
    );
  }, [translatorForm, translatorWorkflows, workflowMap]);

  const handleSaveTranslator = useCallback(
    async (values: Record<string, unknown>) => {
      await runAction(async () => {
        const name = String(values.translatorName ?? '').trim();
        if (!name) {
          throw new Error('翻译器名称不能为空');
        }
        const workflowName = optionalString(values.type) ?? 'default';
        const workflow =
          workflowMap.get(workflowName) ??
          workflowMap.get('default') ??
          translatorWorkflows[0];
        if (!workflow) {
          throw new Error('未找到可用的翻译器工作流元数据');
        }
        const payload: TranslatorEntry = buildTranslatorPayload(values, workflow);
        await runSettingsAction(['translator'], async () => {
          await api.saveTranslator(name, payload);
          setTranslators((prev) => ({
            ...prev,
            [name]: payload,
          }));
          setSelectedTranslatorName(name);
        });
        message.success('翻译器已保存');
      });
    },
    [message, runAction, runSettingsAction, translatorWorkflows, workflowMap],
  );

  const handleDeleteTranslator = useCallback(async () => {
    if (!selectedTranslatorName) {
      return;
    }
    await runAction(async () => {
      await runSettingsAction(['translator'], async () => {
        await api.deleteTranslator(selectedTranslatorName);
        const nextTranslators = { ...translators };
        delete nextTranslators[selectedTranslatorName];
        setTranslators(nextTranslators);
        setSelectedTranslatorName((current) => {
          if (current !== selectedTranslatorName) {
            return current;
          }
          return Object.keys(nextTranslators)[0];
        });
      });
      message.success('翻译器已删除');
    });
  }, [message, runAction, runSettingsAction, selectedTranslatorName, translators]);

  const handleSaveAuxiliaryConfig = useCallback(
    async (
      kind: 'extractor' | 'updater' | 'plot' | 'alignment',
      values: Record<string, unknown>,
    ) => {
      await runAction(async () => {
        if (kind === 'extractor') {
          const payload: GlossaryExtractorConfig = {
            modelNames: normalizeModelChain(values.modelNames),
            maxCharsPerBatch: optionalNumber(values.maxCharsPerBatch),
            occurrenceTopK: optionalNumber(values.occurrenceTopK),
            occurrenceTopP: optionalNumber(values.occurrenceTopP),
            requestOptions: parseYamlObject(values.requestOptionsYaml),
          };
          await runSettingsAction(['extractor'], async () => {
            await api.saveGlossaryExtractor(payload);
            setExtractorConfig(payload);
          });
        } else if (kind === 'updater') {
          const payload: GlossaryUpdaterConfig = {
            workflow: optionalString(values.workflow),
            modelNames: normalizeModelChain(values.modelNames),
            requestOptions: parseYamlObject(values.requestOptionsYaml),
          };
          await runSettingsAction(['updater'], async () => {
            await api.saveGlossaryUpdater(payload);
            setUpdaterConfig(payload);
          });
        } else if (kind === 'plot') {
          const payload: PlotSummaryConfig = {
            modelNames: normalizeModelChain(values.modelNames),
            fragmentsPerBatch: optionalNumber(values.fragmentsPerBatch),
            maxContextSummaries: optionalNumber(values.maxContextSummaries),
            requestOptions: parseYamlObject(values.requestOptionsYaml),
          };
          await runSettingsAction(['plot'], async () => {
            await api.savePlotSummaryConfig(payload);
            setPlotConfig(payload);
          });
        } else {
          const payload: AlignmentRepairConfig = {
            modelNames: normalizeModelChain(values.modelNames),
            requestOptions: parseYamlObject(values.requestOptionsYaml),
          };
          await runSettingsAction(['alignment'], async () => {
            await api.saveAlignmentRepairConfig(payload);
            setAlignmentConfig(payload);
          });
        }
        message.success('辅助配置已保存');
      });
    },
    [message, runAction, runSettingsAction],
  );

  const navigationItems = useMemo(
    () => [
      {
        key: '/workspace/current',
        icon: <FolderOpenOutlined />,
        label: '当前工作区',
      },
      {
        key: '/workspace/create',
        icon: <PlusCircleOutlined />,
        label: '创建工作区',
      },
      {
        key: '/workspaces/recent',
        icon: <ClockCircleOutlined />,
        label: '最近工作区',
      },
      { key: '/settings', icon: <SettingOutlined />, label: '系统设置' },
    ],
    [],
  );

  const currentNavigationKey = useMemo(
    () =>
      navigationItems.find((item) => item.key === location.pathname)?.key ??
      '/workspace/current',
    [location.pathname, navigationItems],
  );

  const currentSectionTitle = useMemo(
    () => {
      if (location.pathname.startsWith('/workspace/editor')) {
        return '章节文本编辑器';
      }
      return (
        navigationItems.find((item) => item.key === currentNavigationKey)?.label ?? '当前工作区'
      );
    },
    [currentNavigationKey, location.pathname, navigationItems],
  );

  return (
      <>
        <Layout className="app-shell">
        <Sider width={208}>
          <div style={{ padding: 16 }}>
            <Typography.Title level={4} style={{ margin: 0, color: '#fff' }}>
              SoloYakusha
            </Typography.Title>
            <Typography.Text type="secondary">Web 工作台</Typography.Text>
          </div>
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[currentNavigationKey]}
            items={navigationItems}
            onClick={(event) => navigate(event.key)}
          />
        </Sider>
        <Layout>
          <Header
            style={{
              background: 'transparent',
              display: 'flex',
              alignItems: 'center',
              padding: '0 16px',
            }}
          >
            <Space>
              <Typography.Title level={5} style={{ margin: 0, color: '#fff' }}>
                {currentSectionTitle}
              </Typography.Title>
              <Tag color={connected ? 'green' : 'red'}>
                {connected ? 'SSE 已连接' : 'SSE 断开'}
              </Tag>
              {projectStatus?.isBusy && <Tag color="gold">正在执行操作</Tag>}
            </Space>
          </Header>
          <Content style={{ padding: 16 }}>
            <Suspense fallback={<RouteLoadingFallback />}>
              <Routes>
                <Route path="/" element={<Navigate replace to="/workspace/current" />} />
                <Route
                  path="/workspace/current"
                  element={
                    <LazyWorkspaceView
                      key={snapshot?.projectName ?? 'no-workspace'}
                      snapshot={snapshot}
                      projectStatus={projectStatus}
                      sseConnected={connected}
                      dictionary={dictionary}
                      repeatedPatterns={repeatedPatterns}
                      chapters={chapters}
                      topology={topology}
                      workspaceForm={workspaceForm}
                      defaultImportFormat={
                        typeof defaultImportFormat === 'string'
                          ? defaultImportFormat
                          : undefined
                      }
                      translatorOptions={translatorOptions}
                      llmProfileOptions={llmProfileOptions}
                      defaultLlmProfileName={defaultLlmName}
                      onRefreshProjectStatus={refreshProjectStatus}
                      onRefreshDictionary={refreshDictionary}
                      onRefreshRepeatedPatterns={refreshRepeatedPatterns}
                      onScanRepeatedPatterns={scanRepeatedPatterns}
                      onHydrateRepeatedPatterns={hydrateRepeatedPatterns}
                      onSaveRepeatedPatternTranslation={handleSaveRepeatedPatternTranslation}
                      onLoadRepeatedPatternContext={handleLoadRepeatedPatternContext}
                      onStartRepeatedPatternConsistencyFix={
                        handleStartRepeatedPatternConsistencyFix
                      }
                      onGetRepeatedPatternConsistencyFixStatus={
                        handleGetRepeatedPatternConsistencyFixStatus
                      }
                      onClearRepeatedPatternConsistencyFixStatus={
                        handleClearRepeatedPatternConsistencyFixStatus
                      }
                      onRefreshChapters={refreshChapters}
                      onRefreshTopology={refreshTopology}
                      onRefreshWorkspaceConfig={refreshWorkspaceConfig}
                      onProjectCommand={handleProjectCommand}
                      onOpenDictionaryEditor={openDictionaryEditor}
                      onDeleteDictionary={handleDeleteDictionary}
                      onImportDictionaryFromContent={handleImportDictionaryFromContent}
                      onWorkspaceConfigSave={handleWorkspaceConfigSave}
                      onClearChapterTranslations={handleClearChapterTranslations}
                      onRemoveChapters={handleRemoveChapters}
                      onCreateStoryBranch={handleCreateStoryBranch}
                      onUpdateStoryRoute={handleUpdateStoryRoute}
                      onReorderStoryRouteChapters={handleReorderStoryRouteChapters}
                      onMoveChapterToRoute={handleMoveChapterToRoute}
                      onRemoveStoryRoute={handleRemoveStoryRoute}
                      onImportChapterArchive={handleImportChapterArchive}
                      onDownloadExport={handleDownloadExport}
                      onResetProject={handleResetProject}
                      onClearLogs={handleClearLogs}
                      onDismissTaskActivity={handleDismissTaskActivity}
                    />
                  }
                />
                <Route
                  path="/workspace/editor/:chapterId?"
                  element={<LazyChapterTranslationEditorPage />}
                />
                <Route
                  path="/workspace/create"
                  element={
                    <LazyWorkspaceCreatePage
                      hasActiveWorkspace={Boolean(snapshot)}
                      translatorOptions={translatorOptions}
                      onRefreshBootData={refreshBootData}
                      onRefreshProjectData={async () => undefined}
                    />
                  }
                />
                <Route
                  path="/workspaces/recent"
                  element={
                    <LazyRecentWorkspacesView
                      workspaces={workspaces}
                      onRefreshBootData={() => void refreshBootData()}
                      onOpenWorkspace={handleOpenWorkspace}
                      onDeleteWorkspace={handleDeleteWorkspace}
                      onImportWorkspaceArchive={handleImportWorkspaceArchive}
                      onExportWorkspaceArchive={handleExportWorkspaceArchive}
                      importingArchive={importingWorkspaceArchive}
                      exportingArchiveDir={exportingWorkspaceArchiveDir ?? undefined}
                    />
                  }
                />
                <Route
                  path="/settings"
                  element={
                    <LazySettingsView
                      settingsLoading={settingsLoading}
                      llmProfiles={llmProfiles}
                      defaultLlmName={defaultLlmName}
                      selectedLlmName={selectedLlmName}
                      vectorConfig={vectorConfig}
                      vectorConnectionStatus={vectorConnectionStatus}
                      selectedTranslatorName={selectedTranslatorName}
                      translators={translators}
                      translatorWorkflows={translatorWorkflows}
                      llmForm={llmForm}
                      embeddingForm={embeddingForm}
                      vectorForm={vectorForm}
                      translatorForm={translatorForm}
                      extractorForm={extractorForm}
                      updaterForm={updaterForm}
                      plotForm={plotForm}
                      alignmentForm={alignmentForm}
                      onCreateLlmProfile={handleCreateLlmProfile}
                      onSelectLlmProfile={selectLlmProfile}
                      onSaveLlmProfile={handleSaveLlmProfile}
                      onSetDefaultLlmProfile={handleSetDefaultLlmProfile}
                      onDeleteLlmProfile={handleDeleteLlmProfile}
                      onSaveEmbedding={handleSaveEmbedding}
                      onSaveVectorStore={handleSaveVectorStore}
                      onConnectVectorStore={handleConnectVectorStore}
                      onDeleteVectorStore={handleDeleteVectorStore}
                      onCreateTranslator={handleCreateTranslator}
                      onSelectTranslator={selectTranslator}
                      onSaveTranslator={handleSaveTranslator}
                      onDeleteTranslator={handleDeleteTranslator}
                      onSaveAuxiliaryConfig={handleSaveAuxiliaryConfig}
                    />
                  }
                />
                <Route path="*" element={<Navigate replace to="/workspace/current" />} />
              </Routes>
            </Suspense>
          </Content>
        </Layout>
      </Layout>

      <DictionaryEditorModal
        open={dictionaryModalOpen}
        editingTerm={editingTerm}
        form={dictionaryForm}
        onCancel={() => setDictionaryModalOpen(false)}
        onSubmit={handleSaveDictionary}
      />
    </>
  );
}
