import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntdApp, Button, Form, Layout, Menu, Space, Tag, Typography } from 'antd';
import type { UploadFile } from 'antd';
import { FolderOpenOutlined, ReloadOutlined, SettingOutlined } from '@ant-design/icons';
import { api } from './api.ts';
import {
  auxToForm,
  optionalNumber,
  optionalString,
  parseJsonObject,
  parseJsonStringMap,
  profileToForm,
  splitLines,
  stringifyJson,
  toErrorMessage,
} from './ui-helpers.ts';
import type {
  AlignmentRepairConfig,
  GlossaryExtractorConfig,
  GlossaryTerm,
  GlossaryUpdaterConfig,
  LlmProfileConfig,
  LogEntry,
  ManagedWorkspace,
  PlotSummaryConfig,
  ProjectStatus,
  TranslationProjectSnapshot,
  TranslatorEntry,
  WorkspaceChapterDescriptor,
} from './types.ts';
import { useEventStream } from './useEventStream.ts';
import { DictionaryEditorModal } from '../components/DictionaryEditorModal.tsx';
import { SettingsView } from '../components/SettingsView.tsx';
import { WorkspaceView, type ProjectCommand } from '../components/WorkspaceView.tsx';

const { Header, Sider, Content } = Layout;

type MainView = 'workspace' | 'settings';

export function AppShell() {
  const { message } = AntdApp.useApp();
  const [view, setView] = useState<MainView>('workspace');
  const [workspaces, setWorkspaces] = useState<ManagedWorkspace[]>([]);
  const [projectStatus, setProjectStatus] = useState<ProjectStatus | null>(null);
  const [snapshot, setSnapshot] = useState<TranslationProjectSnapshot | null>(null);
  const [dictionary, setDictionary] = useState<GlossaryTerm[]>([]);
  const [chapters, setChapters] = useState<WorkspaceChapterDescriptor[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [history, setHistory] = useState('');
  const [uploadFiles, setUploadFiles] = useState<UploadFile[]>([]);
  const [dictionaryModalOpen, setDictionaryModalOpen] = useState(false);
  const [editingTerm, setEditingTerm] = useState<GlossaryTerm | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [llmProfiles, setLlmProfiles] = useState<Record<string, LlmProfileConfig>>({});
  const [defaultLlmName, setDefaultLlmName] = useState<string>();
  const [translators, setTranslators] = useState<Record<string, TranslatorEntry>>({});
  const [embeddingConfig, setEmbeddingConfig] = useState<LlmProfileConfig | null>(null);
  const [extractorConfig, setExtractorConfig] = useState<GlossaryExtractorConfig | null>(null);
  const [updaterConfig, setUpdaterConfig] = useState<GlossaryUpdaterConfig | null>(null);
  const [plotConfig, setPlotConfig] = useState<PlotSummaryConfig | null>(null);
  const [alignmentConfig, setAlignmentConfig] = useState<AlignmentRepairConfig | null>(null);
  const [selectedLlmName, setSelectedLlmName] = useState<string>();
  const [selectedTranslatorName, setSelectedTranslatorName] = useState<string>();

  const [uploadForm] = Form.useForm<Record<string, unknown>>();
  const [workspaceForm] = Form.useForm<Record<string, unknown>>();
  const [dictionaryForm] = Form.useForm<Record<string, unknown>>();
  const [llmForm] = Form.useForm<Record<string, unknown>>();
  const [embeddingForm] = Form.useForm<Record<string, unknown>>();
  const [translatorForm] = Form.useForm<Record<string, unknown>>();
  const [extractorForm] = Form.useForm<Record<string, unknown>>();
  const [updaterForm] = Form.useForm<Record<string, unknown>>();
  const [plotForm] = Form.useForm<Record<string, unknown>>();
  const [alignmentForm] = Form.useForm<Record<string, unknown>>();

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
    const [workspaceRes, activeRes, logsRes] = await Promise.all([
      api.listWorkspaces(),
      api.getActiveProject(),
      api.getLogs(),
    ]);
    setWorkspaces(workspaceRes.workspaces);
    setProjectStatus(activeRes);
    setSnapshot(activeRes.snapshot);
    setLogs(logsRes.logs);
  }, []);

  const refreshProjectData = useCallback(async () => {
    const [dictionaryRes, chaptersRes, configRes, historyRes] = await Promise.all([
      api.getDictionary().catch(() => ({ terms: [] })),
      api.getChapters().catch(() => ({ chapters: [] })),
      api.getWorkspaceConfig().catch(() => null),
      api.getHistory().catch(() => ({ history: '' })),
    ]);
    setDictionary(dictionaryRes.terms);
    setChapters(chaptersRes.chapters);
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
        extractorRes,
        updaterRes,
        plotRes,
        alignmentRes,
      ] = await Promise.all([
        api.getLlmProfiles(),
        api.getEmbeddingConfig(),
        api.getTranslators(),
        api.getGlossaryExtractor(),
        api.getGlossaryUpdater(),
        api.getPlotSummaryConfig(),
        api.getAlignmentRepairConfig(),
      ]);

      setLlmProfiles(llmRes.profiles);
      setDefaultLlmName(llmRes.defaultName);
      setEmbeddingConfig(embeddingRes);
      setTranslators(translatorsRes.translators);
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
        setProjectStatus((prev) =>
          prev ? { ...prev, scanDictionaryProgress: progress } : prev,
        ),
      onPlotProgress: (progress: ProjectStatus['plotSummaryProgress']) =>
        setProjectStatus((prev) =>
          prev ? { ...prev, plotSummaryProgress: progress } : prev,
        ),
    }),
    [appendLog],
  );

  const { connected } = useEventStream(eventHandlers);

  useEffect(() => {
    void refreshBootData();
  }, [refreshBootData]);

  useEffect(() => {
    if (view === 'settings') {
      void refreshSettings();
    }
  }, [refreshSettings, view]);

  useEffect(() => {
    if (snapshot) {
      void refreshProjectData();
    } else {
      setDictionary([]);
      setChapters([]);
      setHistory('');
    }
  }, [refreshProjectData, snapshot?.projectName]);

  useEffect(() => {
    if (view !== 'settings') {
      return;
    }

    if (selectedLlmName && llmProfiles[selectedLlmName]) {
      llmForm.setFieldsValue(profileToForm(llmProfiles[selectedLlmName], selectedLlmName));
    } else {
      llmForm.resetFields();
    }

    if (selectedTranslatorName && translators[selectedTranslatorName]) {
      const translator = translators[selectedTranslatorName];
      translatorForm.setFieldsValue({
        translatorName: selectedTranslatorName,
        type: translator.type ?? 'default',
        modelName: translator.modelName,
        reviewIterations: translator.reviewIterations,
        overlapChars: translator.slidingWindow?.overlapChars,
        requestOptionsJson: stringifyJson(translator.requestOptions),
        modelsJson: stringifyJson(translator.models),
      });
    } else {
      translatorForm.resetFields();
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
    updaterConfig,
    updaterForm,
    view,
  ]);

  const translatorOptions = useMemo(
    () =>
      Object.keys(translators).map((name) => ({
        label: name,
        value: name,
      })),
    [translators],
  );

  const handleUploadSubmit = useCallback(
    async (values: Record<string, unknown>) => {
      await runAction(async () => {
        const file = uploadFiles[0]?.originFileObj;
        if (!file) {
          throw new Error('请先选择 ZIP 文件');
        }

        const formData = new FormData();
        formData.set('file', file);
        formData.set('projectName', String(values.projectName ?? ''));
        if (values.importFormat) {
          formData.set('importFormat', String(values.importFormat));
        }
        if (values.translatorName) {
          formData.set('translatorName', String(values.translatorName));
        }
        if (values.srcLang) {
          formData.set('srcLang', String(values.srcLang));
        }
        if (values.tgtLang) {
          formData.set('tgtLang', String(values.tgtLang));
        }
        if (values.manifestJson) {
          formData.set('manifestJson', String(values.manifestJson));
        }

        await api.createWorkspace(formData);
        setUploadFiles([]);
        uploadForm.resetFields(['manifestJson']);
        await refreshBootData();
        await refreshProjectData();
        message.success('工作区已创建并打开');
      });
    },
    [message, refreshBootData, refreshProjectData, runAction, uploadFiles, uploadForm],
  );

  const handleOpenWorkspace = useCallback(
    async (workspace: ManagedWorkspace) => {
      await runAction(async () => {
        await api.openWorkspace(workspace.dir, workspace.name);
        await refreshBootData();
        await refreshProjectData();
        message.success(`已打开工作区：${workspace.name}`);
      });
    },
    [message, refreshBootData, refreshProjectData, runAction],
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
            message.success('已关闭工作区');
            break;
          case 'remove':
            await api.removeCurrentWorkspace();
            await refreshBootData();
            message.success('已移除工作区');
            break;
        }
      });
    },
    [message, refreshBootData, runAction],
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
          defaultRequestConfig: parseJsonObject(values.defaultRequestConfigJson),
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
          defaultRequestConfig: parseJsonObject(values.defaultRequestConfigJson),
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
    translatorForm.setFieldsValue({ type: 'default' });
  }, [translatorForm]);

  const handleSaveTranslator = useCallback(
    async (values: Record<string, unknown>) => {
      await runAction(async () => {
        const name = String(values.translatorName ?? '').trim();
        if (!name) {
          throw new Error('翻译器名称不能为空');
        }
        const overlapChars = optionalNumber(values.overlapChars);
        const payload: TranslatorEntry = {
          type: optionalString(values.type),
          modelName: String(values.modelName ?? ''),
          reviewIterations: optionalNumber(values.reviewIterations),
          slidingWindow:
            overlapChars !== undefined ? { overlapChars } : undefined,
          requestOptions: parseJsonObject(values.requestOptionsJson),
          models: parseJsonStringMap(values.modelsJson),
        };
        await api.saveTranslator(name, payload);
        await refreshSettings();
        message.success('翻译器已保存');
      });
    },
    [message, refreshSettings, runAction],
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
            requestOptions: parseJsonObject(values.requestOptionsJson),
          });
        } else if (kind === 'updater') {
          await api.saveGlossaryUpdater({
            workflow: optionalString(values.workflow),
            modelName: String(values.modelName ?? ''),
            requestOptions: parseJsonObject(values.requestOptionsJson),
          });
        } else if (kind === 'plot') {
          await api.savePlotSummaryConfig({
            modelName: String(values.modelName ?? ''),
            fragmentsPerBatch: optionalNumber(values.fragmentsPerBatch),
            maxContextSummaries: optionalNumber(values.maxContextSummaries),
            requestOptions: parseJsonObject(values.requestOptionsJson),
          });
        } else {
          await api.saveAlignmentRepairConfig({
            modelName: String(values.modelName ?? ''),
            requestOptions: parseJsonObject(values.requestOptionsJson),
          });
        }
        await refreshSettings();
        message.success('辅助配置已保存');
      });
    },
    [message, refreshSettings, runAction],
  );

  return (
    <>
      <Layout className="app-shell">
        <Sider width={220}>
          <div style={{ padding: 20 }}>
            <Typography.Title level={4} style={{ margin: 0, color: '#fff' }}>
              SoloYakusha
            </Typography.Title>
            <Typography.Text type="secondary">Web 工作台</Typography.Text>
          </div>
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[view]}
            items={[
              { key: 'workspace', icon: <FolderOpenOutlined />, label: '工作台' },
              { key: 'settings', icon: <SettingOutlined />, label: '系统设置' },
            ]}
            onClick={(event) => setView(event.key as MainView)}
          />
        </Sider>
        <Layout>
          <Header
            style={{
              background: 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Space>
              <Tag color={connected ? 'green' : 'red'}>
                {connected ? 'SSE 已连接' : 'SSE 断开'}
              </Tag>
              {projectStatus?.isBusy && <Tag color="gold">正在执行操作</Tag>}
            </Space>
            <Button icon={<ReloadOutlined />} onClick={() => void refreshBootData()}>
              刷新状态
            </Button>
          </Header>
          <Content style={{ padding: 24 }}>
            {view === 'workspace' ? (
              <WorkspaceView
                workspaces={workspaces}
                snapshot={snapshot}
                projectStatus={projectStatus}
                dictionary={dictionary}
                chapters={chapters}
                logs={logs}
                history={history}
                uploadForm={uploadForm}
                workspaceForm={workspaceForm}
                uploadFiles={uploadFiles}
                translatorOptions={translatorOptions}
                onUploadFilesChange={setUploadFiles}
                onUploadSubmit={handleUploadSubmit}
                onRefreshBootData={() => void refreshBootData()}
                onRefreshProjectData={() => void refreshProjectData()}
                onOpenWorkspace={handleOpenWorkspace}
                onDeleteWorkspace={handleDeleteWorkspace}
                onProjectCommand={handleProjectCommand}
                onOpenDictionaryEditor={openDictionaryEditor}
                onDeleteDictionary={handleDeleteDictionary}
                onWorkspaceConfigSave={handleWorkspaceConfigSave}
                onMoveChapter={handleMoveChapter}
                onClearChapterTranslations={handleClearChapterTranslations}
                onRemoveChapter={handleRemoveChapter}
                onDownloadExport={handleDownloadExport}
                onResetProject={handleResetProject}
                onClearLogs={handleClearLogs}
                onRefreshHistory={handleRefreshHistory}
              />
            ) : (
              <SettingsView
                settingsLoading={settingsLoading}
                llmProfiles={llmProfiles}
                defaultLlmName={defaultLlmName}
                selectedLlmName={selectedLlmName}
                selectedTranslatorName={selectedTranslatorName}
                translators={translators}
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
            )}
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
