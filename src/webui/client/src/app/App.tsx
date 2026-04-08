import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntdApp, Button, Form, Layout, Menu, Space, Tag, Typography } from 'antd';
import {
  ClockCircleOutlined,
  FolderOpenOutlined,
  PlusCircleOutlined,
  ReloadOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api.ts';
import {
  auxToForm,
  buildTranslatorPayload,
  parseLlmRequestConfigYaml,
  optionalNumber,
  optionalString,
  parseYamlObject,
  profileToForm,
  splitLines,
  translatorToForm,
  toErrorMessage,
} from './ui-helpers.ts';
import type {
  AlignmentRepairConfig,
  CreateStoryBranchPayload,
  GlossaryExtractorConfig,
  GlossaryTerm,
  GlossaryUpdaterConfig,
  LlmRequestHistoryEntry,
  LlmProfileConfig,
  LogEntry,
  ManagedWorkspace,
  PlotSummaryConfig,
  ProjectStatus,
  StoryTopologyDescriptor,
  TranslationProcessorWorkflowMetadata,
  TranslationProjectSnapshot,
  TranslatorEntry,
  UpdateStoryRoutePayload,
  WorkspaceChapterDescriptor,
} from './types.ts';
import { useEventStream } from './useEventStream.ts';
import { DictionaryEditorModal } from '../components/DictionaryEditorModal.tsx';
import { RecentWorkspacesView } from '../components/RecentWorkspacesView.tsx';
import { SettingsView } from '../components/SettingsView.tsx';
import {
  WorkspaceView,
  type ProjectCommand,
  type TaskActivityKind,
} from '../components/WorkspaceView.tsx';
import { WorkspaceCreatePage } from '../features/workspace-create/WorkspaceCreatePage.tsx';

const { Header, Sider, Content } = Layout;

export function AppShell() {
  const { message } = AntdApp.useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<ManagedWorkspace[]>([]);
  const [projectStatus, setProjectStatus] = useState<ProjectStatus | null>(null);
  const [snapshot, setSnapshot] = useState<TranslationProjectSnapshot | null>(null);
  const [dictionary, setDictionary] = useState<GlossaryTerm[]>([]);
  const [chapters, setChapters] = useState<WorkspaceChapterDescriptor[]>([]);
  const [topology, setTopology] = useState<StoryTopologyDescriptor | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [history, setHistory] = useState<LlmRequestHistoryEntry[]>([]);
  const [dictionaryModalOpen, setDictionaryModalOpen] = useState(false);
  const [editingTerm, setEditingTerm] = useState<GlossaryTerm | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
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
  const [extractorConfig, setExtractorConfig] = useState<GlossaryExtractorConfig | null>(null);
  const [updaterConfig, setUpdaterConfig] = useState<GlossaryUpdaterConfig | null>(null);
  const [plotConfig, setPlotConfig] = useState<PlotSummaryConfig | null>(null);
  const [alignmentConfig, setAlignmentConfig] = useState<AlignmentRepairConfig | null>(null);
  const [selectedLlmName, setSelectedLlmName] = useState<string>();
  const [selectedTranslatorName, setSelectedTranslatorName] = useState<string>();

  const [workspaceForm] = Form.useForm<Record<string, unknown>>();
  const [dictionaryForm] = Form.useForm<Record<string, unknown>>();
  const [llmForm] = Form.useForm<Record<string, unknown>>();
  const [embeddingForm] = Form.useForm<Record<string, unknown>>();
  const [translatorForm] = Form.useForm<Record<string, unknown>>();
  const [extractorForm] = Form.useForm<Record<string, unknown>>();
  const [updaterForm] = Form.useForm<Record<string, unknown>>();
  const [plotForm] = Form.useForm<Record<string, unknown>>();
  const [alignmentForm] = Form.useForm<Record<string, unknown>>();
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

  const refreshBootData = useCallback(async () => {
    const [workspaceRes, activeRes, logsRes, translatorsRes] = await Promise.all([
      api.listWorkspaces(),
      api.getActiveProject(),
      api.getLogs(),
      api.getTranslators().catch(() => ({ translators: {} })),
    ]);
    setWorkspaces(workspaceRes.workspaces);
    setProjectStatus(activeRes);
    setSnapshot(activeRes.snapshot);
    setLogs(logsRes.logs);
    setTranslators(translatorsRes.translators);
  }, []);

  const refreshProjectStatus = useCallback(async () => {
    const status = await api.getProjectStatus();
    setProjectStatus(status);
    setSnapshot(status.snapshot);
  }, []);

  const refreshProjectData = useCallback(async () => {
    const [dictionaryRes, chaptersRes, topologyRes, configRes, historyRes] = await Promise.all([
      api.getDictionary().catch(() => ({ terms: [] })),
      api.getChapters().catch(() => ({ chapters: [] })),
      api.getTopology().catch(() => ({ topology: null })),
      api.getWorkspaceConfig().catch(() => null),
      api.getHistory().catch(() => ({ history: [] })),
    ]);
    setDictionary(dictionaryRes.terms);
    setChapters(chaptersRes.chapters);
    setTopology(topologyRes.topology);
    setHistory(historyRes.history);

    if (configRes) {
      workspaceForm.setFieldsValue({
        projectName: configRes.projectName,
        glossaryPath: configRes.glossary.path,
        translatorName: configRes.translator.translatorName,
        defaultImportFormat: configRes.defaultImportFormat,
        defaultExportFormat: configRes.defaultExportFormat,
        customRequirements: configRes.customRequirements.join('\n'),
      });
    }
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
    setSettingsLoading(true);
    try {
      const [
        llmRes,
        embeddingRes,
        translatorsRes,
        workflowRes,
        extractorRes,
        updaterRes,
        plotRes,
        alignmentRes,
      ] = await Promise.all([
        api.getLlmProfiles(),
        api.getEmbeddingConfig(),
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
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  const appendLog = useCallback((entry: LogEntry) => {
    setLogs((prev) => [...prev, entry].slice(-500));
  }, []);

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
      onLog: appendLog,
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
            void refreshProjectData().catch(() => undefined);
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
            void refreshProjectData().catch(() => undefined);
          }
        },
    }),
    [appendLog, refreshProjectData, refreshProjectStatus],
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
    if (snapshot) {
      void refreshProjectData();
    } else {
      setDictionary([]);
      setChapters([]);
      setHistory([]);
    }
  }, [refreshProjectData, snapshot?.projectName]);

  useEffect(() => {
    if (location.pathname !== '/settings') {
      return;
    }

    if (selectedLlmName && llmProfiles[selectedLlmName]) {
      llmForm.setFieldsValue(profileToForm(llmProfiles[selectedLlmName], selectedLlmName));
    } else {
      llmForm.resetFields();
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
    } else {
      translatorForm.resetFields();
      translatorForm.setFieldsValue(
        translatorToForm(
          null,
          undefined,
          workflowMap.get('default') ?? translatorWorkflows[0],
        ) as Record<string, {} | undefined>,
      );
    }

    embeddingForm.setFieldsValue(profileToForm(embeddingConfig, 'embedding'));
    extractorForm.setFieldsValue(auxToForm(extractorConfig));
    updaterForm.setFieldsValue(auxToForm(updaterConfig));
    plotForm.setFieldsValue(auxToForm(plotConfig));
    alignmentForm.setFieldsValue(auxToForm(alignmentConfig));
  }, [
    alignmentConfig,
    alignmentForm,
    embeddingConfig,
    embeddingForm,
    extractorConfig,
    extractorForm,
    llmForm,
    llmProfiles,
    plotConfig,
    plotForm,
    selectedLlmName,
    selectedTranslatorName,
    translatorForm,
    translators,
    translatorWorkflows,
    updaterConfig,
    updaterForm,
    workflowMap,
    location.pathname,
  ]);

  const translatorOptions = useMemo(
    () =>
      Object.keys(translators).map((name) => ({
        label: translators[name]?.metadata?.title
          ? `${translators[name].metadata?.title} (${name})`
          : name,
        value: name,
      })),
    [translators],
  );

  const handleOpenWorkspace = useCallback(
    async (workspace: ManagedWorkspace) => {
      await runAction(async () => {
        await api.openWorkspace(workspace.dir, workspace.name);
        await refreshBootData();
        await refreshProjectData();
        navigate('/workspace/current');
        message.success(`已打开工作区：${workspace.name}`);
      });
    },
    [message, navigate, refreshBootData, refreshProjectData, runAction],
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
            message.success('翻译已启动');
            break;
          case 'pause':
            await api.pauseTranslation();
            message.success('暂停请求已提交');
            break;
          case 'resume':
            await api.resumeTranslation();
            message.success('翻译已恢复');
            break;
          case 'abort':
            await api.abortTranslation();
            message.success('翻译已中止');
            break;
          case 'scan':
            await api.scanDictionary();
            message.success('已开始扫描术语表');
            break;
          case 'plot':
            await api.startPlotSummary();
            message.success('已开始生成情节大纲');
            break;
          case 'close':
            await api.closeWorkspace();
            await refreshBootData();
            navigate('/workspaces/recent');
            message.success('已关闭工作区');
            break;
          case 'remove':
            await api.removeCurrentWorkspace();
            await refreshBootData();
            navigate('/workspaces/recent');
            message.success('已移除工作区');
            break;
        }
      });
    },
    [message, navigate, refreshBootData, runAction],
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
        await refreshProjectData();
        message.success('术语条目已保存');
      });
    },
    [message, refreshProjectData, runAction],
  );

  const handleDeleteDictionary = useCallback(
    async (term: string) => {
      await runAction(async () => {
        await api.deleteDictionaryTerm(term);
        await refreshProjectData();
        message.success('术语条目已删除');
      });
    },
    [message, refreshProjectData, runAction],
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
            translatorName: String(values.translatorName ?? '') || null,
          },
          defaultImportFormat: String(values.defaultImportFormat ?? '') || null,
          defaultExportFormat: String(values.defaultExportFormat ?? '') || null,
          customRequirements: splitLines(String(values.customRequirements ?? '')),
        });
        await refreshProjectData();
        message.success('工作区配置已保存');
      });
    },
    [message, refreshProjectData, runAction],
  );

  const handleMoveChapter = useCallback(
    async (index: number, delta: -1 | 1) => {
      await runAction(async () => {
        const nextIndex = index + delta;
        if (nextIndex < 0 || nextIndex >= chapters.length) {
          return;
        }
        const next = [...chapters];
        const [current] = next.splice(index, 1);
        if (!current) {
          return;
        }
        next.splice(nextIndex, 0, current);
        await api.reorderChapters(next.map((chapter) => chapter.id));
        setChapters(next);
        message.success('章节顺序已更新');
      });
    },
    [chapters, message, runAction],
  );

  const handleClearChapterTranslations = useCallback(
    async (chapterIds: number[]) => {
      await runAction(async () => {
        await api.clearChapterTranslations(chapterIds);
        await refreshProjectData();
        message.success('章节译文已清空');
      });
    },
    [message, refreshProjectData, runAction],
  );

  const handleRemoveChapter = useCallback(
    async (chapterId: number) => {
      await runAction(async () => {
        await api.removeChapter(chapterId);
        await refreshProjectData();
        message.success('章节已移除');
      });
    },
    [message, refreshProjectData, runAction],
  );

  const handleCreateStoryBranch = useCallback(
    async (payload: CreateStoryBranchPayload) => {
      await runAction(async () => {
        await api.createStoryBranch(payload);
        await refreshProjectData();
        message.success(`分支“${payload.name}”已创建`);
      });
    },
    [message, refreshProjectData, runAction],
  );

  const handleUpdateStoryRoute = useCallback(
    async (routeId: string, payload: UpdateStoryRoutePayload) => {
      await runAction(async () => {
        await api.updateStoryRoute(routeId, payload);
        await refreshProjectData();
        message.success('路线已更新');
      });
    },
    [message, refreshProjectData, runAction],
  );

  const handleReorderStoryRouteChapters = useCallback(
    async (routeId: string, chapterIds: number[]) => {
      await runAction(async () => {
        await api.reorderStoryRouteChapters(routeId, chapterIds);
        await refreshProjectData();
        message.success('路线内章节顺序已更新');
      });
    },
    [message, refreshProjectData, runAction],
  );

  const handleRemoveStoryRoute = useCallback(
    async (routeId: string) => {
      await runAction(async () => {
        await api.removeStoryRoute(routeId);
        await refreshProjectData();
        message.success('路线已删除');
      });
    },
    [message, refreshProjectData, runAction],
  );

  const handleDownloadExport = useCallback(
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
        await refreshProjectData();
        message.success(successText);
      });
    },
    [message, refreshProjectData, runAction],
  );

  const handleClearLogs = useCallback(async () => {
    await runAction(async () => {
      await api.clearLogs();
      setLogs([]);
      message.success('日志已清空');
    });
  }, [message, runAction]);

  const handleRefreshHistory = useCallback(async () => {
    await runAction(async () => {
      const res = await api.getHistory();
      setHistory(res.history);
    });
  }, [runAction]);

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
        await api.saveLlmProfile(name, payload);
        await refreshSettings();
        message.success('LLM Profile 已保存');
      });
    },
    [message, refreshSettings, runAction],
  );

  const handleSetDefaultLlmProfile = useCallback(async () => {
    if (!selectedLlmName) {
      return;
    }
    await runAction(async () => {
      await api.setDefaultLlmProfile(selectedLlmName);
      await refreshSettings();
      message.success('默认 LLM 已更新');
    });
  }, [message, refreshSettings, runAction, selectedLlmName]);

  const handleDeleteLlmProfile = useCallback(async () => {
    if (!selectedLlmName) {
      return;
    }
    await runAction(async () => {
      await api.deleteLlmProfile(selectedLlmName);
      await refreshSettings();
      message.success('Profile 已删除');
    });
  }, [message, refreshSettings, runAction, selectedLlmName]);

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
        await api.saveEmbeddingConfig(payload);
        await refreshSettings();
        message.success('Embedding 配置已保存');
      });
    },
    [message, refreshSettings, runAction],
  );

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
        await api.saveTranslator(name, payload);
        await refreshSettings();
        message.success('翻译器已保存');
      });
    },
    [message, refreshSettings, runAction, translatorWorkflows, workflowMap],
  );

  const handleDeleteTranslator = useCallback(async () => {
    if (!selectedTranslatorName) {
      return;
    }
    await runAction(async () => {
      await api.deleteTranslator(selectedTranslatorName);
      await refreshSettings();
      message.success('翻译器已删除');
    });
  }, [message, refreshSettings, runAction, selectedTranslatorName]);

  const handleSaveAuxiliaryConfig = useCallback(
    async (
      kind: 'extractor' | 'updater' | 'plot' | 'alignment',
      values: Record<string, unknown>,
    ) => {
      await runAction(async () => {
        if (kind === 'extractor') {
          await api.saveGlossaryExtractor({
            modelName: String(values.modelName ?? ''),
            maxCharsPerBatch: optionalNumber(values.maxCharsPerBatch),
            occurrenceTopK: optionalNumber(values.occurrenceTopK),
            occurrenceTopP: optionalNumber(values.occurrenceTopP),
            requestOptions: parseYamlObject(values.requestOptionsYaml),
          });
        } else if (kind === 'updater') {
          await api.saveGlossaryUpdater({
            workflow: optionalString(values.workflow),
            modelName: String(values.modelName ?? ''),
            requestOptions: parseYamlObject(values.requestOptionsYaml),
          });
        } else if (kind === 'plot') {
          await api.savePlotSummaryConfig({
            modelName: String(values.modelName ?? ''),
            fragmentsPerBatch: optionalNumber(values.fragmentsPerBatch),
            maxContextSummaries: optionalNumber(values.maxContextSummaries),
            requestOptions: parseYamlObject(values.requestOptionsYaml),
          });
        } else {
          await api.saveAlignmentRepairConfig({
            modelName: String(values.modelName ?? ''),
            requestOptions: parseYamlObject(values.requestOptionsYaml),
          });
        }
        await refreshSettings();
        message.success('辅助配置已保存');
      });
    },
    [message, refreshSettings, runAction],
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
    () =>
      navigationItems.find((item) => item.key === currentNavigationKey)?.label ??
      '当前工作区',
    [currentNavigationKey, navigationItems],
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
              justifyContent: 'space-between',
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
            <Button icon={<ReloadOutlined />} onClick={() => void refreshBootData()}>
              刷新状态
            </Button>
          </Header>
          <Content style={{ padding: 16 }}>
            <Routes>
              <Route path="/" element={<Navigate replace to="/workspace/current" />} />
              <Route
                path="/workspace/current"
                element={
                  <WorkspaceView
                    snapshot={snapshot}
                    projectStatus={projectStatus}
                    dictionary={dictionary}
                    chapters={chapters}
                    topology={topology}
                    logs={logs}
                    history={history}
                    workspaceForm={workspaceForm}
                    translatorOptions={translatorOptions}
                    onRefreshProjectData={() => void refreshProjectData()}
                    onProjectCommand={handleProjectCommand}
                    onOpenDictionaryEditor={openDictionaryEditor}
                    onDeleteDictionary={handleDeleteDictionary}
                    onWorkspaceConfigSave={handleWorkspaceConfigSave}
                    onMoveChapter={handleMoveChapter}
                    onClearChapterTranslations={handleClearChapterTranslations}
                    onRemoveChapter={handleRemoveChapter}
                    onCreateStoryBranch={handleCreateStoryBranch}
                    onUpdateStoryRoute={handleUpdateStoryRoute}
                    onReorderStoryRouteChapters={handleReorderStoryRouteChapters}
                    onRemoveStoryRoute={handleRemoveStoryRoute}
                    onDownloadExport={handleDownloadExport}
                    onResetProject={handleResetProject}
                    onClearLogs={handleClearLogs}
                    onRefreshHistory={handleRefreshHistory}
                    onDismissTaskActivity={handleDismissTaskActivity}
                  />
                }
              />
              <Route
                path="/workspace/create"
                element={
                  <WorkspaceCreatePage
                    hasActiveWorkspace={Boolean(snapshot)}
                    translatorOptions={translatorOptions}
                    onRefreshBootData={refreshBootData}
                    onRefreshProjectData={refreshProjectData}
                  />
                }
              />
              <Route
                path="/workspaces/recent"
                element={
                  <RecentWorkspacesView
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
                  <SettingsView
                    settingsLoading={settingsLoading}
                    llmProfiles={llmProfiles}
                    defaultLlmName={defaultLlmName}
                    selectedLlmName={selectedLlmName}
                    selectedTranslatorName={selectedTranslatorName}
                    translators={translators}
                    translatorWorkflows={translatorWorkflows}
                    llmForm={llmForm}
                    embeddingForm={embeddingForm}
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
