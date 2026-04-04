import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Form,
  Input,
  Layout,
  List,
  Menu,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { UploadFile } from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  BookOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  DownloadOutlined,
  ExportOutlined,
  FileTextOutlined,
  FileZipOutlined,
  FolderOpenOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RobotOutlined,
  SettingOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { api } from './api.ts';
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
  WorkspaceConfig,
} from './types.ts';
import { useEventStream } from './useEventStream.ts';

const { Header, Sider, Content } = Layout;
const { TextArea } = Input;
const IMPORT_FORMAT_OPTIONS = [
  { label: '自动/默认', value: '' },
  { label: '纯文本', value: 'plain_text' },
  { label: 'Nature Dialog', value: 'naturedialog' },
  { label: 'Nature Dialog (保留角色名)', value: 'naturedialog_keepname' },
  { label: 'M3T', value: 'm3t' },
  { label: 'GalTransl JSON', value: 'galtransl_json' },
];

type MainView = 'workspace' | 'settings';

export function AppShell() {
  const { message } = AntdApp.useApp();
  const [view, setView] = useState<MainView>('workspace');
  const [workspaces, setWorkspaces] = useState<ManagedWorkspace[]>([]);
  const [projectStatus, setProjectStatus] = useState<ProjectStatus | null>(null);
  const [snapshot, setSnapshot] = useState<TranslationProjectSnapshot | null>(
    null,
  );
  const [workspaceConfig, setWorkspaceConfig] = useState<WorkspaceConfig | null>(
    null,
  );
  const [dictionary, setDictionary] = useState<GlossaryTerm[]>([]);
  const [chapters, setChapters] = useState<WorkspaceChapterDescriptor[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [history, setHistory] = useState('');
  const [uploadFiles, setUploadFiles] = useState<UploadFile[]>([]);
  const [dictionaryModalOpen, setDictionaryModalOpen] = useState(false);
  const [editingTerm, setEditingTerm] = useState<GlossaryTerm | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);

  const [llmProfiles, setLlmProfiles] = useState<Record<string, LlmProfileConfig>>(
    {},
  );
  const [defaultLlmName, setDefaultLlmName] = useState<string>();
  const [embeddingConfig, setEmbeddingConfig] = useState<LlmProfileConfig | null>(
    null,
  );
  const [translators, setTranslators] = useState<Record<string, TranslatorEntry>>(
    {},
  );
  const [extractorConfig, setExtractorConfig] =
    useState<GlossaryExtractorConfig | null>(null);
  const [updaterConfig, setUpdaterConfig] =
    useState<GlossaryUpdaterConfig | null>(null);
  const [plotConfig, setPlotConfig] = useState<PlotSummaryConfig | null>(null);
  const [alignmentConfig, setAlignmentConfig] =
    useState<AlignmentRepairConfig | null>(null);
  const [selectedLlmName, setSelectedLlmName] = useState<string>();
  const [selectedTranslatorName, setSelectedTranslatorName] =
    useState<string>();

  const [uploadForm] = Form.useForm();
  const [workspaceForm] = Form.useForm();
  const [dictionaryForm] = Form.useForm();
  const [llmForm] = Form.useForm();
  const [embeddingForm] = Form.useForm();
  const [translatorForm] = Form.useForm();
  const [extractorForm] = Form.useForm();
  const [updaterForm] = Form.useForm();
  const [plotForm] = Form.useForm();
  const [alignmentForm] = Form.useForm();

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
    const [dictionaryRes, chaptersRes, configRes, historyRes] =
      await Promise.all([
        api.getDictionary().catch(() => ({ terms: [] })),
        api.getChapters().catch(() => ({ chapters: [] })),
        api.getWorkspaceConfig().catch(() => null),
        api.getHistory().catch(() => ({ history: '' })),
      ]);
    setDictionary(dictionaryRes.terms);
    setChapters(chaptersRes.chapters);
    setWorkspaceConfig(configRes);
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
      setExtractorConfig(extractorRes);
      setUpdaterConfig(updaterRes);
      setPlotConfig(plotRes);
      setAlignmentConfig(alignmentRes);

      const llmNames = Object.keys(llmRes.profiles);
      const firstLlmName = llmNames[0];
      if (firstLlmName) {
        const target = llmRes.defaultName ?? firstLlmName;
        selectLlmProfile(target, llmRes.profiles);
      } else {
        llmForm.resetFields();
      }

      const translatorNames = Object.keys(translatorsRes.translators);
      const firstTranslatorName = translatorNames[0];
      if (firstTranslatorName) {
        selectTranslator(
          firstTranslatorName,
          translatorsRes.translators[firstTranslatorName],
        );
      } else {
        translatorForm.resetFields();
      }

      embeddingForm.setFieldsValue(profileToForm(embeddingRes, 'embedding'));
      extractorForm.setFieldsValue(auxToForm(extractorRes));
      updaterForm.setFieldsValue(auxToForm(updaterRes));
      plotForm.setFieldsValue(auxToForm(plotRes));
      alignmentForm.setFieldsValue(auxToForm(alignmentRes));
    } finally {
      setSettingsLoading(false);
    }
  }, [
    alignmentForm,
    embeddingForm,
    extractorForm,
    llmForm,
    plotForm,
    translatorForm,
    updaterForm,
  ]);

  const appendLog = useCallback((entry: LogEntry) => {
    setLogs((prev) => {
      const next = [...prev, entry];
      return next.slice(-500);
    });
  }, []);

  const { connected } = useEventStream({
    onSnapshot: (nextSnapshot) => {
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
    onScanProgress: (progress) =>
      setProjectStatus((prev) =>
        prev ? { ...prev, scanDictionaryProgress: progress } : prev,
      ),
    onPlotProgress: (progress) =>
      setProjectStatus((prev) =>
        prev ? { ...prev, plotSummaryProgress: progress } : prev,
      ),
  });

  useEffect(() => {
    void refreshBootData();
    void refreshSettings();
  }, [refreshBootData, refreshSettings]);

  useEffect(() => {
    if (snapshot) {
      void refreshProjectData();
    } else {
      setDictionary([]);
      setChapters([]);
      setWorkspaceConfig(null);
      setHistory('');
    }
  }, [snapshot?.projectName, refreshProjectData]); // eslint-disable-line react-hooks/exhaustive-deps

  const translatorOptions = useMemo(
    () =>
      Object.keys(translators).map((name) => ({
        label: name,
        value: name,
      })),
    [translators],
  );

  async function withMessage(
    promise: Promise<unknown>,
    successText: string,
  ): Promise<void> {
    await promise;
    message.success(successText);
  }

  async function handleUploadSubmit(values: {
    projectName: string;
    importFormat?: string;
    translatorName?: string;
    srcLang?: string;
    tgtLang?: string;
    manifestJson?: string;
  }) {
    const file = uploadFiles[0]?.originFileObj;
    if (!file) {
      message.error('请先选择 ZIP 文件');
      return;
    }

    const formData = new FormData();
    formData.set('file', file);
    formData.set('projectName', values.projectName);
    if (values.importFormat) formData.set('importFormat', values.importFormat);
    if (values.translatorName) {
      formData.set('translatorName', values.translatorName);
    }
    if (values.srcLang) formData.set('srcLang', values.srcLang);
    if (values.tgtLang) formData.set('tgtLang', values.tgtLang);
    if (values.manifestJson) formData.set('manifestJson', values.manifestJson);

    await api.createWorkspace(formData);
    setUploadFiles([]);
    uploadForm.resetFields(['manifestJson']);
    await refreshBootData();
    await refreshProjectData();
    message.success('工作区已创建并打开');
  }

  async function handleOpenWorkspace(workspace: ManagedWorkspace) {
    await api.openWorkspace(workspace.dir, workspace.name);
    await refreshBootData();
    await refreshProjectData();
    message.success(`已打开工作区：${workspace.name}`);
  }

  async function handleDeleteWorkspace(workspace: ManagedWorkspace) {
    await api.deleteWorkspace(workspace.dir);
    await refreshBootData();
    message.success(`已删除工作区：${workspace.name}`);
  }

  async function handleProjectCommand(
    command:
      | 'start'
      | 'pause'
      | 'resume'
      | 'abort'
      | 'scan'
      | 'plot'
      | 'close'
      | 'remove',
  ) {
    switch (command) {
      case 'start':
        await withMessage(api.startTranslation(), '翻译已启动');
        break;
      case 'pause':
        await withMessage(api.pauseTranslation(), '暂停请求已提交');
        break;
      case 'resume':
        await withMessage(api.resumeTranslation(), '翻译已恢复');
        break;
      case 'abort':
        await withMessage(api.abortTranslation(), '翻译已中止');
        break;
      case 'scan':
        await withMessage(api.scanDictionary(), '已开始扫描术语表');
        break;
      case 'plot':
        await withMessage(api.startPlotSummary(), '已开始生成情节大纲');
        break;
      case 'close':
        await withMessage(api.closeWorkspace(), '已关闭工作区');
        await refreshBootData();
        break;
      case 'remove':
        await withMessage(api.removeCurrentWorkspace(), '已移除当前工作区');
        await refreshBootData();
        break;
    }
  }

  function openDictionaryEditor(record?: GlossaryTerm) {
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
  }

  async function handleSaveDictionary(values: Record<string, string>) {
    await api.saveDictionaryTerm(values as never);
    setDictionaryModalOpen(false);
    await refreshProjectData();
    message.success('术语条目已保存');
  }

  async function handleDeleteDictionary(term: string) {
    await api.deleteDictionaryTerm(term);
    await refreshProjectData();
    message.success('术语条目已删除');
  }

  async function handleWorkspaceConfigSave(values: {
    projectName: string;
    glossaryPath?: string;
    translatorName?: string;
    defaultImportFormat?: string;
    defaultExportFormat?: string;
    customRequirements?: string;
  }) {
    await api.updateWorkspaceConfig({
      projectName: values.projectName,
      glossary: {
        path: values.glossaryPath?.trim() || undefined,
      },
      translator: {
        translatorName: values.translatorName || null,
      },
      defaultImportFormat: values.defaultImportFormat || null,
      defaultExportFormat: values.defaultExportFormat || null,
      customRequirements: splitLines(values.customRequirements),
    });
    await refreshProjectData();
    message.success('工作区配置已保存');
  }

  async function moveChapter(index: number, delta: -1 | 1) {
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= chapters.length) return;
    const next = [...chapters];
    const [current] = next.splice(index, 1);
    if (!current) return;
    next.splice(nextIndex, 0, current);
    await api.reorderChapters(next.map((chapter) => chapter.id));
    setChapters(next);
    message.success('章节顺序已更新');
  }

  async function downloadExport(format: string) {
    const blob = await api.downloadExport(format);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${snapshot?.projectName ?? 'soloyakusha'}-${format}.zip`;
    link.click();
    URL.revokeObjectURL(url);
    message.success('导出已开始下载');
  }

  function selectLlmProfile(
    name: string,
    profiles = llmProfiles,
  ) {
    const profile = profiles[name];
    if (!profile) return;
    setSelectedLlmName(name);
    llmForm.setFieldsValue(profileToForm(profile, name));
  }

  function selectTranslator(name: string, entry?: TranslatorEntry) {
    const translator = entry ?? translators[name];
    if (!translator) return;
    setSelectedTranslatorName(name);
    translatorForm.setFieldsValue({
      translatorName: name,
      type: translator.type ?? 'default',
      modelName: translator.modelName,
      reviewIterations: translator.reviewIterations,
      overlapChars: translator.slidingWindow?.overlapChars,
      requestOptionsJson: stringifyJson(translator.requestOptions),
      modelsJson: stringifyJson(translator.models),
    });
  }

  async function saveLlmProfile(values: Record<string, unknown>) {
    const name = String(values.profileName ?? '').trim();
    if (!name) {
      message.error('Profile 名称不能为空');
      return;
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
  }

  async function saveEmbedding(values: Record<string, unknown>) {
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
  }

  async function saveTranslator(values: Record<string, unknown>) {
    const name = String(values.translatorName ?? '').trim();
    if (!name) {
      message.error('翻译器名称不能为空');
      return;
    }
    const payload: TranslatorEntry = {
      type: optionalString(values.type),
      modelName: String(values.modelName ?? ''),
      reviewIterations: optionalNumber(values.reviewIterations),
      slidingWindow:
        optionalNumber(values.overlapChars) !== undefined
          ? { overlapChars: optionalNumber(values.overlapChars) }
          : undefined,
      requestOptions: parseJsonObject(values.requestOptionsJson),
      models: parseJsonStringMap(values.modelsJson),
    };
    await api.saveTranslator(name, payload);
    await refreshSettings();
    message.success('翻译器已保存');
  }

  async function saveAuxiliaryConfig(
    kind: 'extractor' | 'updater' | 'plot' | 'alignment',
    values: Record<string, unknown>,
  ) {
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
  }

  const workspaceMenuItems = [
    { key: 'workspace', icon: <FolderOpenOutlined />, label: '工作台' },
    { key: 'settings', icon: <SettingOutlined />, label: '系统设置' },
  ];

  const renderProgressAlerts = () => (
    <Space direction="vertical" style={{ width: '100%' }}>
      {projectStatus?.scanDictionaryProgress && (
        <Alert
          type={
            projectStatus.scanDictionaryProgress.status === 'error'
              ? 'error'
              : 'info'
          }
          message={`术语扫描：${projectStatus.scanDictionaryProgress.completedBatches}/${projectStatus.scanDictionaryProgress.totalBatches} 批`}
          description={projectStatus.scanDictionaryProgress.errorMessage}
        />
      )}
      {projectStatus?.plotSummaryProgress && (
        <Alert
          type={
            projectStatus.plotSummaryProgress.status === 'error'
              ? 'error'
              : 'info'
          }
          message={`情节总结：${projectStatus.plotSummaryProgress.completedBatches}/${projectStatus.plotSummaryProgress.totalBatches} 批`}
          description={projectStatus.plotSummaryProgress.errorMessage}
        />
      )}
    </Space>
  );

  const workspaceView = (
    <div className="section-stack">
      <Row gutter={16}>
        <Col span={12}>
          <Card
            title={
              <Space>
                <FileZipOutlined />
                上传压缩包创建工作区
              </Space>
            }
            extra={
              <Tag color="blue">
                远程友好
              </Tag>
            }
          >
            <Form
              form={uploadForm}
              layout="vertical"
              className="compact-form"
              initialValues={{ projectName: '新建项目' }}
              onFinish={(values) => {
                void handleUploadSubmit(values);
              }}
            >
              <Form.Item
                label="项目名称"
                name="projectName"
                rules={[{ required: true, message: '请输入项目名称' }]}
              >
                <Input placeholder="例如：某轻小说项目" />
              </Form.Item>
              <Form.Item label="默认导入格式" name="importFormat">
                <Select options={IMPORT_FORMAT_OPTIONS} />
              </Form.Item>
              <Form.Item label="默认翻译器" name="translatorName">
                <Select
                  allowClear
                  options={translatorOptions}
                  placeholder="使用全局默认翻译器"
                />
              </Form.Item>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item label="源语言" name="srcLang">
                    <Input placeholder="例如：日语" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="目标语言" name="tgtLang">
                    <Input placeholder="例如：中文" />
                  </Form.Item>
                </Col>
              </Row>
              <Form.Item label="项目压缩包">
                <Upload.Dragger
                  accept=".zip"
                  beforeUpload={() => false}
                  maxCount={1}
                  fileList={uploadFiles}
                  onChange={({ fileList }) =>
                    setUploadFiles(fileList.slice(-1))
                  }
                >
                  <p className="ant-upload-drag-icon">
                    <CloudUploadOutlined />
                  </p>
                  <p>拖入或点击上传 ZIP</p>
                  <span className="upload-hint">
                    导入后工作区将由程序托管到独立目录中
                  </span>
                </Upload.Dragger>
              </Form.Item>
              <Collapse
                items={[
                  {
                    key: 'manifest',
                    label: '高级：导入 Manifest JSON',
                    children: (
                      <Form.Item
                        label="Manifest JSON"
                        name="manifestJson"
                        extra="可选，用于指定 chapterPaths / branches / glossaryPath 等高级导入配置。"
                      >
                        <TextArea rows={8} placeholder='{"chapterPaths":["..."]}' />
                      </Form.Item>
                    ),
                  },
                ]}
              />
              <Button type="primary" htmlType="submit" block>
                创建并打开工作区
              </Button>
            </Form>
          </Card>
        </Col>
        <Col span={12}>
          <Card
            title={
              <Space>
                <FolderOpenOutlined />
                最近工作区
              </Space>
            }
            extra={
              <Button
                icon={<ReloadOutlined />}
                onClick={() => void refreshBootData()}
              >
                刷新
              </Button>
            }
          >
            {workspaces.length === 0 ? (
              <Empty description="暂无工作区" />
            ) : (
              <List
                dataSource={workspaces}
                renderItem={(workspace) => (
                  <List.Item
                    actions={[
                      <Button
                        key="open"
                        type="link"
                        onClick={() => void handleOpenWorkspace(workspace)}
                      >
                        打开
                      </Button>,
                      <Popconfirm
                        key="delete"
                        title="确认删除该工作区？"
                        onConfirm={() => void handleDeleteWorkspace(workspace)}
                      >
                        <Button type="link" danger>
                          删除
                        </Button>
                      </Popconfirm>,
                    ]}
                  >
                    <List.Item.Meta
                      title={
                        <Space>
                          <span>{workspace.name}</span>
                          {workspace.managed && <Tag color="green">托管</Tag>}
                        </Space>
                      }
                      description={
                        <div>
                          <div>{workspace.dir}</div>
                          <Typography.Text type="secondary">
                            最近打开：{new Date(workspace.lastOpenedAt).toLocaleString()}
                          </Typography.Text>
                        </div>
                      }
                    />
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>
      </Row>

      {snapshot ? (
        <Tabs
          defaultActiveKey="dashboard"
          items={[
            {
              key: 'dashboard',
              label: '项目总览',
              children: (
                <div className="section-stack">
                  <Card
                    title={
                      <Space>
                        <RobotOutlined />
                        {snapshot.projectName}
                      </Space>
                    }
                    extra={
                      <Tag color={statusColor(snapshot.lifecycle.status)}>
                        {snapshot.lifecycle.status}
                      </Tag>
                    }
                  >
                    <Space wrap>
                      <Button
                        type="primary"
                        icon={<PlayCircleOutlined />}
                        disabled={!snapshot.lifecycle.canStart}
                        onClick={() => void handleProjectCommand('start')}
                      >
                        启动
                      </Button>
                      <Button
                        icon={<PauseCircleOutlined />}
                        disabled={!snapshot.lifecycle.canStop}
                        onClick={() => void handleProjectCommand('pause')}
                      >
                        暂停
                      </Button>
                      <Button
                        icon={<PlayCircleOutlined />}
                        disabled={!snapshot.lifecycle.canResume}
                        onClick={() => void handleProjectCommand('resume')}
                      >
                        恢复
                      </Button>
                      <Button
                        danger
                        icon={<StopOutlined />}
                        disabled={!snapshot.lifecycle.canAbort}
                        onClick={() => void handleProjectCommand('abort')}
                      >
                        中止
                      </Button>
                      <Button onClick={() => void handleProjectCommand('scan')}>
                        扫描术语
                      </Button>
                      <Button onClick={() => void handleProjectCommand('plot')}>
                        生成情节大纲
                      </Button>
                      <Button onClick={() => void handleProjectCommand('close')}>
                        关闭工作区
                      </Button>
                      <Popconfirm
                        title="确认删除当前工作区？"
                        onConfirm={() => void handleProjectCommand('remove')}
                      >
                        <Button danger>移除工作区</Button>
                      </Popconfirm>
                    </Space>
                  </Card>

                  <Row gutter={16}>
                    <Col span={6}>
                      <Card>
                        <Statistic
                          title="章节进度"
                          value={snapshot.progress.chapterProgressRatio * 100}
                          suffix="%"
                          precision={1}
                        />
                        <Typography.Text type="secondary">
                          {snapshot.progress.translatedChapters}/
                          {snapshot.progress.totalChapters}
                        </Typography.Text>
                      </Card>
                    </Col>
                    <Col span={6}>
                      <Card>
                        <Statistic
                          title="片段进度"
                          value={snapshot.progress.fragmentProgressRatio * 100}
                          suffix="%"
                          precision={1}
                        />
                        <Typography.Text type="secondary">
                          {snapshot.progress.translatedFragments}/
                          {snapshot.progress.totalFragments}
                        </Typography.Text>
                      </Card>
                    </Col>
                    <Col span={6}>
                      <Card>
                        <Statistic
                          title="排队/运行"
                          value={`${snapshot.lifecycle.queuedWorkItems}/${snapshot.lifecycle.activeWorkItems}`}
                        />
                      </Card>
                    </Col>
                    <Col span={6}>
                      <Card>
                        <Statistic
                          title="术语表"
                          value={snapshot.glossary?.totalTerms ?? 0}
                        />
                        <Typography.Text type="secondary">
                          已译 {snapshot.glossary?.translatedTerms ?? 0}
                        </Typography.Text>
                      </Card>
                    </Col>
                  </Row>

                  {renderProgressAlerts()}

                  <Card title="步骤队列">
                    {snapshot.queueSnapshots.length === 0 ? (
                      <Empty description="暂无步骤数据" />
                    ) : (
                      <div className="step-list">
                        {snapshot.queueSnapshots.map((queue) => (
                          <div className="step-card" key={queue.stepId}>
                            <Flex justify="space-between" align="center">
                              <div>
                                <Typography.Text strong>
                                  {queue.description}
                                </Typography.Text>
                                {queue.isFinalStep && (
                                  <Tag color="green" style={{ marginLeft: 8 }}>
                                    最终步骤
                                  </Tag>
                                )}
                              </div>
                              <Typography.Text type="secondary">
                                {queue.progress.completedFragments}/
                                {queue.progress.totalFragments}
                              </Typography.Text>
                            </Flex>
                            <Progress
                              percent={Number(
                                (queue.progress.completionRatio * 100).toFixed(1),
                              )}
                              status={
                                queue.progress.completionRatio >= 1
                                  ? 'success'
                                  : 'active'
                              }
                            />
                            <Space wrap size={[8, 8]}>
                              <Tag>ready {queue.progress.readyFragments}</Tag>
                              <Tag>queued {queue.progress.queuedFragments}</Tag>
                              <Tag>running {queue.progress.runningFragments}</Tag>
                              <Tag>waiting {queue.progress.waitingFragments}</Tag>
                            </Space>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                </div>
              ),
            },
            {
              key: 'dictionary',
              label: '术语表',
              children: (
                <Card
                  title={
                    <Space>
                      <BookOutlined />
                      术语表
                    </Space>
                  }
                  extra={
                    <Space>
                      <Button onClick={() => void refreshProjectData()}>刷新</Button>
                      <Button onClick={() => void handleProjectCommand('scan')}>
                        重新扫描
                      </Button>
                      <Button
                        type="primary"
                        onClick={() => openDictionaryEditor()}
                      >
                        新建条目
                      </Button>
                    </Space>
                  }
                >
                  <Table
                    rowKey="term"
                    dataSource={dictionary}
                    pagination={{ pageSize: 10 }}
                    columns={[
                      {
                        title: '术语',
                        dataIndex: 'term',
                        width: 180,
                      },
                      {
                        title: '译文',
                        dataIndex: 'translation',
                        width: 180,
                      },
                      {
                        title: '类别',
                        dataIndex: 'category',
                        width: 120,
                        render: (value: string | undefined) =>
                          value ? <Tag>{value}</Tag> : '-',
                      },
                      {
                        title: '状态',
                        dataIndex: 'status',
                        width: 120,
                        render: (value: string | undefined) =>
                          value ? (
                            <Tag color={value === 'translated' ? 'green' : 'gold'}>
                              {value}
                            </Tag>
                          ) : (
                            '-'
                          ),
                      },
                      {
                        title: '出现次数',
                        render: (_, record) =>
                          `${record.totalOccurrenceCount ?? 0} / ${record.textBlockOccurrenceCount ?? 0}`,
                        width: 120,
                      },
                      {
                        title: '描述',
                        dataIndex: 'description',
                        ellipsis: true,
                      },
                      {
                        title: '操作',
                        width: 140,
                        render: (_, record) => (
                          <Space>
                            <Button
                              type="link"
                              onClick={() => openDictionaryEditor(record)}
                            >
                              编辑
                            </Button>
                            <Popconfirm
                              title="确认删除该术语？"
                              onConfirm={() =>
                                void handleDeleteDictionary(record.term)
                              }
                            >
                              <Button type="link" danger>
                                删除
                              </Button>
                            </Popconfirm>
                          </Space>
                        ),
                      },
                    ]}
                  />
                </Card>
              ),
            },
            {
              key: 'chapters',
              label: '章节管理',
              children: (
                <Card title="章节列表">
                  <Table
                    rowKey="id"
                    dataSource={chapters}
                    pagination={false}
                    columns={[
                      { title: 'ID', dataIndex: 'id', width: 70 },
                      { title: '文件路径', dataIndex: 'filePath' },
                      { title: '片段', dataIndex: 'fragmentCount', width: 90 },
                      {
                        title: '已译行数',
                        dataIndex: 'translatedLineCount',
                        width: 100,
                      },
                      {
                        title: '操作',
                        width: 220,
                        render: (_, record, index) => (
                          <Space>
                            <Button
                              icon={<ArrowUpOutlined />}
                              onClick={() => void moveChapter(index, -1)}
                            />
                            <Button
                              icon={<ArrowDownOutlined />}
                              onClick={() => void moveChapter(index, 1)}
                            />
                            <Popconfirm
                              title="确认清空该章节的译文？"
                              onConfirm={() =>
                                void api
                                  .clearChapterTranslations([record.id])
                                  .then(refreshProjectData)
                              }
                            >
                              <Button>清空译文</Button>
                            </Popconfirm>
                            <Popconfirm
                              title="确认移除该章节？"
                              onConfirm={() =>
                                void api.removeChapter(record.id).then(async () => {
                                  await refreshProjectData();
                                  message.success('章节已移除');
                                })
                              }
                            >
                              <Button danger>移除</Button>
                            </Popconfirm>
                          </Space>
                        ),
                      },
                    ]}
                  />
                </Card>
              ),
            },
            {
              key: 'workspace-config',
              label: '工作区配置',
              children: (
                <div className="section-stack">
                  <Card title="项目配置">
                    <Form
                      form={workspaceForm}
                      layout="vertical"
                      className="compact-form"
                      onFinish={(values) => {
                        void handleWorkspaceConfigSave(values);
                      }}
                    >
                      <Row gutter={16}>
                        <Col span={12}>
                          <Form.Item
                            name="projectName"
                            label="项目名称"
                            rules={[{ required: true }]}
                          >
                            <Input />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item name="translatorName" label="翻译器">
                            <Select allowClear options={translatorOptions} />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Row gutter={16}>
                        <Col span={12}>
                          <Form.Item name="glossaryPath" label="术语表路径">
                            <Input placeholder="Data/glossary.json" />
                          </Form.Item>
                        </Col>
                        <Col span={6}>
                          <Form.Item
                            name="defaultImportFormat"
                            label="默认导入格式"
                          >
                            <Select options={IMPORT_FORMAT_OPTIONS} />
                          </Form.Item>
                        </Col>
                        <Col span={6}>
                          <Form.Item
                            name="defaultExportFormat"
                            label="默认导出格式"
                          >
                            <Select options={IMPORT_FORMAT_OPTIONS} />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Form.Item name="customRequirements" label="自定义要求">
                        <TextArea rows={6} placeholder="每行一条要求" />
                      </Form.Item>
                      <Button type="primary" htmlType="submit">
                        保存配置
                      </Button>
                    </Form>
                  </Card>

                  <Row gutter={16}>
                    <Col span={12}>
                      <Card
                        title="导出项目"
                        extra={<ExportOutlined />}
                      >
                        <Space direction="vertical" style={{ width: '100%' }}>
                          <Button
                            icon={<DownloadOutlined />}
                            type="primary"
                            onClick={() => void downloadExport('plain_text')}
                          >
                            下载纯文本导出 ZIP
                          </Button>
                          <Button onClick={() => void downloadExport('naturedialog')}>
                            下载 Nature Dialog 导出 ZIP
                          </Button>
                          <Button onClick={() => void downloadExport('m3t')}>
                            下载 M3T 导出 ZIP
                          </Button>
                          <Button
                            onClick={() => void downloadExport('galtransl_json')}
                          >
                            下载 GalTransl JSON 导出 ZIP
                          </Button>
                        </Space>
                      </Card>
                    </Col>
                    <Col span={12}>
                      <Card title="重置项目" extra={<DeleteOutlined />}>
                        <Space direction="vertical" style={{ width: '100%' }}>
                          <Button
                            danger
                            onClick={() =>
                              void api
                                .resetProject({ clearAllTranslations: true })
                                .then(async () => {
                                  await refreshProjectData();
                                  message.success('已清空所有译文');
                                })
                            }
                          >
                            清空全部译文
                          </Button>
                          <Button
                            danger
                            onClick={() =>
                              void api
                                .resetProject({ clearGlossary: true })
                                .then(async () => {
                                  await refreshProjectData();
                                  message.success('已清空术语表');
                                })
                            }
                          >
                            清空术语表
                          </Button>
                          <Button
                            danger
                            onClick={() =>
                              void api
                                .resetProject({ clearGlossaryTranslations: true })
                                .then(async () => {
                                  await refreshProjectData();
                                  message.success('已清空术语表译文');
                                })
                            }
                          >
                            清空术语表译文
                          </Button>
                          <Button
                            danger
                            onClick={() =>
                              void api
                                .resetProject({ clearPlotSummaries: true })
                                .then(() => {
                                  message.success('已清空情节大纲');
                                })
                            }
                          >
                            清空情节大纲
                          </Button>
                        </Space>
                      </Card>
                    </Col>
                  </Row>
                </div>
              ),
            },
            {
              key: 'history',
              label: '历史与日志',
              children: (
                <Row gutter={16}>
                  <Col span={12}>
                    <Card
                      title="事件日志"
                      extra={
                        <Space>
                          <Button
                            onClick={() =>
                              void api.clearLogs().then(async () => {
                                setLogs([]);
                                message.success('日志已清空');
                              })
                            }
                          >
                            清空
                          </Button>
                          <Button onClick={() => void refreshBootData()}>
                            刷新
                          </Button>
                        </Space>
                      }
                    >
                      {logs.length === 0 ? (
                        <Empty description="暂无日志" />
                      ) : (
                        <div className="log-list">
                          <List
                            size="small"
                            dataSource={[...logs].reverse()}
                            renderItem={(item) => (
                              <List.Item>
                                <Space direction="vertical" size={0}>
                                  <Space>
                                    <Tag color={logColor(item.level)}>
                                      {item.level}
                                    </Tag>
                                    <Typography.Text type="secondary">
                                      {new Date(item.timestamp).toLocaleTimeString()}
                                    </Typography.Text>
                                  </Space>
                                  <Typography.Text>{item.message}</Typography.Text>
                                </Space>
                              </List.Item>
                            )}
                          />
                        </div>
                      )}
                    </Card>
                  </Col>
                  <Col span={12}>
                    <Card
                      title="LLM 请求历史"
                      extra={
                        <Button
                          onClick={() =>
                            void api.getHistory().then((res) => setHistory(res.history))
                          }
                        >
                          刷新
                        </Button>
                      }
                    >
                      {history ? (
                        <div className="mono-block">{history}</div>
                      ) : (
                        <Empty description="暂无请求历史" />
                      )}
                    </Card>
                  </Col>
                </Row>
              ),
            },
          ]}
        />
      ) : (
        <Card>
          <Empty description="当前未打开工作区" />
        </Card>
      )}
    </div>
  );

  const settingsView = (
    <Tabs
      defaultActiveKey="llm"
      items={[
        {
          key: 'llm',
          label: 'LLM Profiles',
          children: (
            <Row gutter={16}>
              <Col span={7}>
                <Card
                  title="Chat Profiles"
                  loading={settingsLoading}
                  extra={
                    <Button
                      onClick={() => {
                        setSelectedLlmName(undefined);
                        llmForm.resetFields();
                        llmForm.setFieldsValue({
                          modelType: 'chat',
                          provider: 'openai',
                          retries: 2,
                        });
                      }}
                    >
                      新建
                    </Button>
                  }
                >
                  <List
                    dataSource={Object.keys(llmProfiles)}
                    renderItem={(name) => (
                      <List.Item
                        onClick={() => selectLlmProfile(name)}
                        style={{
                          cursor: 'pointer',
                          background:
                            name === selectedLlmName
                              ? 'rgba(108,140,255,.12)'
                              : undefined,
                          paddingInline: 12,
                          borderRadius: 8,
                        }}
                      >
                        <List.Item.Meta
                          title={
                            <Space>
                              <span>{name}</span>
                              {name === defaultLlmName && (
                                <Tag color="blue">默认</Tag>
                              )}
                            </Space>
                          }
                          description={llmProfiles[name]?.modelName}
                        />
                      </List.Item>
                    )}
                  />
                </Card>
              </Col>
              <Col span={17}>
                <Card title="编辑 Profile" loading={settingsLoading}>
                  <Form
                    form={llmForm}
                    layout="vertical"
                    className="compact-form"
                    onFinish={(values) => void saveLlmProfile(values)}
                  >
                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item
                          name="profileName"
                          label="Profile 名称"
                          rules={[{ required: true }]}
                        >
                          <Input />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item
                          name="provider"
                          label="Provider"
                          rules={[{ required: true }]}
                        >
                          <Select
                            options={[
                              { label: 'OpenAI Compatible', value: 'openai' },
                              { label: 'Anthropic', value: 'anthropic' },
                            ]}
                          />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="modelType" label="类型">
                          <Select
                            options={[{ label: 'chat', value: 'chat' }]}
                            disabled
                          />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item
                          name="modelName"
                          label="模型名"
                          rules={[{ required: true }]}
                        >
                          <Input />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item
                          name="endpoint"
                          label="Endpoint"
                          rules={[{ required: true }]}
                        >
                          <Input />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="apiKey" label="API Key">
                          <Input.Password />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="apiKeyEnv" label="API Key 环境变量">
                          <Input placeholder="例如 OPENAI_API_KEY" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item name="qps" label="QPS">
                          <Input type="number" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="maxParallelRequests" label="并发数">
                          <Input type="number" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="retries" label="重试次数">
                          <Input type="number" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Form.Item
                      name="defaultRequestConfigJson"
                      label="默认请求配置（JSON）"
                    >
                      <TextArea rows={5} />
                    </Form.Item>
                    <Space>
                      <Button type="primary" htmlType="submit">
                        保存 Profile
                      </Button>
                      {selectedLlmName && (
                        <>
                          <Button
                            onClick={() =>
                              void api
                                .setDefaultLlmProfile(selectedLlmName)
                                .then(async () => {
                                  await refreshSettings();
                                  message.success('默认 LLM 已更新');
                                })
                            }
                          >
                            设为默认
                          </Button>
                          <Popconfirm
                            title="确认删除该 Profile？"
                            onConfirm={() =>
                              void api
                                .deleteLlmProfile(selectedLlmName)
                                .then(async () => {
                                  await refreshSettings();
                                  message.success('Profile 已删除');
                                })
                            }
                          >
                            <Button danger>删除</Button>
                          </Popconfirm>
                        </>
                      )}
                    </Space>
                  </Form>
                </Card>

                <Card title="Embedding 配置" loading={settingsLoading} className="mt-2">
                  <Form
                    form={embeddingForm}
                    layout="vertical"
                    className="compact-form"
                    onFinish={(values) => void saveEmbedding(values)}
                  >
                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item
                          name="provider"
                          label="Provider"
                          rules={[{ required: true }]}
                        >
                          <Select
                            options={[
                              { label: 'OpenAI Compatible', value: 'openai' },
                              { label: 'Anthropic', value: 'anthropic' },
                            ]}
                          />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item
                          name="modelName"
                          label="模型名"
                          rules={[{ required: true }]}
                        >
                          <Input />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item
                          name="endpoint"
                          label="Endpoint"
                          rules={[{ required: true }]}
                        >
                          <Input />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="apiKey" label="API Key">
                          <Input.Password />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="apiKeyEnv" label="API Key 环境变量">
                          <Input />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Button type="primary" htmlType="submit">
                      保存 Embedding
                    </Button>
                  </Form>
                </Card>
              </Col>
            </Row>
          ),
        },
        {
          key: 'translator',
          label: '翻译器',
          children: (
            <Row gutter={16}>
              <Col span={7}>
                <Card
                  title="翻译器列表"
                  loading={settingsLoading}
                  extra={
                    <Button
                      onClick={() => {
                        setSelectedTranslatorName(undefined);
                        translatorForm.resetFields();
                        translatorForm.setFieldsValue({ type: 'default' });
                      }}
                    >
                      新建
                    </Button>
                  }
                >
                  <List
                    dataSource={Object.keys(translators)}
                    renderItem={(name) => (
                      <List.Item
                        onClick={() => selectTranslator(name)}
                        style={{
                          cursor: 'pointer',
                          background:
                            name === selectedTranslatorName
                              ? 'rgba(108,140,255,.12)'
                              : undefined,
                          paddingInline: 12,
                          borderRadius: 8,
                        }}
                      >
                        <List.Item.Meta
                          title={name}
                          description={translators[name]?.modelName}
                        />
                      </List.Item>
                    )}
                  />
                </Card>
              </Col>
              <Col span={17}>
                <Card title="编辑翻译器" loading={settingsLoading}>
                  <Form
                    form={translatorForm}
                    layout="vertical"
                    className="compact-form"
                    onFinish={(values) => void saveTranslator(values)}
                  >
                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item
                          name="translatorName"
                          label="名称"
                          rules={[{ required: true }]}
                        >
                          <Input />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="type" label="工作流">
                          <Select
                            options={[
                              { label: 'default', value: 'default' },
                              { label: 'multi-stage', value: 'multi-stage' },
                            ]}
                          />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item
                          name="modelName"
                          label="默认模型"
                          rules={[{ required: true }]}
                        >
                          <Select
                            showSearch
                            options={Object.keys(llmProfiles).map((name) => ({
                              label: name,
                              value: name,
                            }))}
                          />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item name="reviewIterations" label="评审轮数">
                          <Input type="number" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="overlapChars" label="滑窗重叠字符数">
                          <Input type="number" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Form.Item name="requestOptionsJson" label="请求选项（JSON）">
                      <TextArea rows={5} />
                    </Form.Item>
                    <Form.Item name="modelsJson" label="步骤模型覆盖（JSON）">
                      <TextArea rows={5} />
                    </Form.Item>
                    <Space>
                      <Button type="primary" htmlType="submit">
                        保存翻译器
                      </Button>
                      {selectedTranslatorName && (
                        <Popconfirm
                          title="确认删除该翻译器？"
                          onConfirm={() =>
                            void api
                              .deleteTranslator(selectedTranslatorName)
                              .then(async () => {
                                await refreshSettings();
                                message.success('翻译器已删除');
                              })
                          }
                        >
                          <Button danger>删除</Button>
                        </Popconfirm>
                      )}
                    </Space>
                  </Form>
                </Card>
              </Col>
            </Row>
          ),
        },
        {
          key: 'auxiliary',
          label: '辅助配置',
          children: (
            <div className="section-stack">
              <Row gutter={16}>
                <Col span={12}>
                  <Card title="术语提取" loading={settingsLoading}>
                    <Form
                      form={extractorForm}
                      layout="vertical"
                      className="compact-form"
                      onFinish={(values) =>
                        void saveAuxiliaryConfig('extractor', values)
                      }
                    >
                      <AuxiliaryCommonFields />
                      <Row gutter={16}>
                        <Col span={8}>
                          <Form.Item name="maxCharsPerBatch" label="每批最大字符">
                            <Input type="number" />
                          </Form.Item>
                        </Col>
                        <Col span={8}>
                          <Form.Item name="occurrenceTopK" label="Top K">
                            <Input type="number" />
                          </Form.Item>
                        </Col>
                        <Col span={8}>
                          <Form.Item name="occurrenceTopP" label="Top P">
                            <Input type="number" />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Button type="primary" htmlType="submit">
                        保存
                      </Button>
                    </Form>
                  </Card>
                </Col>
                <Col span={12}>
                  <Card title="术语更新" loading={settingsLoading}>
                    <Form
                      form={updaterForm}
                      layout="vertical"
                      className="compact-form"
                      onFinish={(values) =>
                        void saveAuxiliaryConfig('updater', values)
                      }
                    >
                      <Row gutter={16}>
                        <Col span={8}>
                          <Form.Item name="workflow" label="工作流">
                            <Input placeholder="default" />
                          </Form.Item>
                        </Col>
                        <Col span={16}>
                          <Form.Item
                            name="modelName"
                            label="模型名"
                            rules={[{ required: true }]}
                          >
                            <Input />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Form.Item name="requestOptionsJson" label="请求选项（JSON）">
                        <TextArea rows={4} />
                      </Form.Item>
                      <Button type="primary" htmlType="submit">
                        保存
                      </Button>
                    </Form>
                  </Card>
                </Col>
              </Row>
              <Row gutter={16}>
                <Col span={12}>
                  <Card title="情节总结" loading={settingsLoading}>
                    <Form
                      form={plotForm}
                      layout="vertical"
                      className="compact-form"
                      onFinish={(values) =>
                        void saveAuxiliaryConfig('plot', values)
                      }
                    >
                      <Row gutter={16}>
                        <Col span={12}>
                          <Form.Item
                            name="modelName"
                            label="模型名"
                            rules={[{ required: true }]}
                          >
                            <Input />
                          </Form.Item>
                        </Col>
                        <Col span={6}>
                          <Form.Item name="fragmentsPerBatch" label="每批片段数">
                            <Input type="number" />
                          </Form.Item>
                        </Col>
                        <Col span={6}>
                          <Form.Item
                            name="maxContextSummaries"
                            label="最大上下文摘要数"
                          >
                            <Input type="number" />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Form.Item name="requestOptionsJson" label="请求选项（JSON）">
                        <TextArea rows={4} />
                      </Form.Item>
                      <Button type="primary" htmlType="submit">
                        保存
                      </Button>
                    </Form>
                  </Card>
                </Col>
                <Col span={12}>
                  <Card title="对齐补翻" loading={settingsLoading}>
                    <Form
                      form={alignmentForm}
                      layout="vertical"
                      className="compact-form"
                      onFinish={(values) =>
                        void saveAuxiliaryConfig('alignment', values)
                      }
                    >
                      <Form.Item
                        name="modelName"
                        label="模型名"
                        rules={[{ required: true }]}
                      >
                        <Input />
                      </Form.Item>
                      <Form.Item name="requestOptionsJson" label="请求选项（JSON）">
                        <TextArea rows={4} />
                      </Form.Item>
                      <Button type="primary" htmlType="submit">
                        保存
                      </Button>
                    </Form>
                  </Card>
                </Col>
              </Row>
            </div>
          ),
        },
      ]}
    />
  );

  return (
    <>
      <Layout className="app-shell">
        <Sider width={220}>
          <div style={{ padding: 20 }}>
            <Typography.Title level={4} style={{ margin: 0, color: '#fff' }}>
              SoloYakusha
            </Typography.Title>
            <Typography.Text type="secondary">
              Web 工作台
            </Typography.Text>
          </div>
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[view]}
            items={workspaceMenuItems}
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
            {view === 'workspace' ? workspaceView : settingsView}
          </Content>
        </Layout>
      </Layout>

      <Modal
        title={editingTerm ? '编辑术语条目' : '新建术语条目'}
        open={dictionaryModalOpen}
        onCancel={() => setDictionaryModalOpen(false)}
        onOk={() => void dictionaryForm.submit()}
      >
        <Form
          form={dictionaryForm}
          layout="vertical"
          className="compact-form"
          onFinish={(values) => void handleSaveDictionary(values)}
        >
          <Form.Item name="originalTerm" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="term" label="术语" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="translation" label="译文">
            <Input />
          </Form.Item>
          <Form.Item name="category" label="类别">
            <Select
              allowClear
              options={[
                { label: 'personName', value: 'personName' },
                { label: 'placeName', value: 'placeName' },
                { label: 'properNoun', value: 'properNoun' },
                { label: 'personTitle', value: 'personTitle' },
                { label: 'catchphrase', value: 'catchphrase' },
              ]}
            />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select
              allowClear
              options={[
                { label: 'translated', value: 'translated' },
                { label: 'untranslated', value: 'untranslated' },
              ]}
            />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <TextArea rows={4} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function AuxiliaryCommonFields() {
  return (
    <>
      <Form.Item
        name="modelName"
        label="模型名"
        rules={[{ required: true }]}
      >
        <Input />
      </Form.Item>
      <Form.Item name="requestOptionsJson" label="请求选项（JSON）">
        <TextArea rows={4} />
      </Form.Item>
    </>
  );
}

function profileToForm(profile: LlmProfileConfig | null, name?: string) {
  if (!profile) {
    return {
      profileName: name,
      provider: 'openai',
      modelType: 'chat',
      retries: 2,
    };
  }
  return {
    profileName: name,
    provider: profile.provider,
    modelName: profile.modelName,
    apiKey: profile.apiKey,
    apiKeyEnv: profile.apiKeyEnv,
    endpoint: profile.endpoint,
    qps: profile.qps,
    maxParallelRequests: profile.maxParallelRequests,
    modelType: profile.modelType,
    retries: profile.retries,
    defaultRequestConfigJson: stringifyJson(profile.defaultRequestConfig),
  };
}

function auxToForm(
  config:
    | GlossaryExtractorConfig
    | GlossaryUpdaterConfig
    | PlotSummaryConfig
    | AlignmentRepairConfig
    | null,
) {
  if (!config) {
    return {};
  }
  return {
    ...config,
    requestOptionsJson: stringifyJson(config.requestOptions),
  };
}

function splitLines(value?: string): string[] {
  return (value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function optionalString(value: unknown): string | undefined {
  const next = String(value ?? '').trim();
  return next ? next : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  const text = String(value ?? '').trim();
  if (!text) {
    return undefined;
  }
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('必须提供 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

function parseJsonStringMap(value: unknown): Record<string, string> | undefined {
  const parsed = parseJsonObject(value);
  if (!parsed) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item !== 'string') {
      throw new Error('步骤模型覆盖必须是 string map');
    }
    result[key] = item;
  }
  return result;
}

function stringifyJson(value: unknown): string | undefined {
  return value ? JSON.stringify(value, null, 2) : undefined;
}

function statusColor(status: string) {
  switch (status) {
    case 'running':
      return 'processing';
    case 'completed':
      return 'success';
    case 'aborted':
      return 'error';
    case 'stopped':
    case 'stopping':
      return 'warning';
    default:
      return 'default';
  }
}

function logColor(level: string) {
  switch (level) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'success':
      return 'success';
    default:
      return 'processing';
  }
}
