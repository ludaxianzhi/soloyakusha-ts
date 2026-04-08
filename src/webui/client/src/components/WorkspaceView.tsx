import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Form,
  Input,
  List,
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
} from 'antd';
import type { FormInstance } from 'antd';
import { useMemo, useState, type ReactNode } from 'react';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  BookOutlined,
  CloseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EyeOutlined,
  ExportOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  RobotOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { IMPORT_FORMAT_OPTIONS, logColor, statusColor } from '../app/ui-helpers.ts';
import type {
  CreateStoryBranchPayload,
  GlossaryTerm,
  LlmRequestHistoryEntry,
  LogEntry,
  ProjectStatus,
  StoryTopologyDescriptor,
  TranslationProjectSnapshot,
  UpdateStoryRoutePayload,
  WorkspaceChapterDescriptor,
} from '../app/types.ts';
import { TranslationPreviewModal } from './TranslationPreviewModal.tsx';
import { StoryTopologyEditor } from './topology/StoryTopologyEditor.tsx';

const { TextArea } = Input;
export type ProjectCommand =
  | 'start'
  | 'pause'
  | 'resume'
  | 'abort'
  | 'scan'
  | 'plot'
  | 'close'
  | 'remove';

interface WorkspaceViewProps {
  snapshot: TranslationProjectSnapshot | null;
  projectStatus: ProjectStatus | null;
  dictionary: GlossaryTerm[];
  chapters: WorkspaceChapterDescriptor[];
  topology: StoryTopologyDescriptor | null;
  logs: LogEntry[];
  history: LlmRequestHistoryEntry[];
  workspaceForm: FormInstance<Record<string, unknown>>;
  translatorOptions: Array<{ label: string; value: string }>;
  onRefreshProjectData: () => void;
  onProjectCommand: (command: ProjectCommand) => void | Promise<void>;
  onOpenDictionaryEditor: (record?: GlossaryTerm) => void;
  onDeleteDictionary: (term: string) => void | Promise<void>;
  onWorkspaceConfigSave: (values: Record<string, unknown>) => void | Promise<void>;
  onMoveChapter: (index: number, delta: -1 | 1) => void | Promise<void>;
  onClearChapterTranslations: (chapterIds: number[]) => void | Promise<void>;
  onRemoveChapter: (chapterId: number) => void | Promise<void>;
  onCreateStoryBranch: (payload: CreateStoryBranchPayload) => void | Promise<void>;
  onUpdateStoryRoute: (
    routeId: string,
    payload: UpdateStoryRoutePayload,
  ) => void | Promise<void>;
  onReorderStoryRouteChapters: (
    routeId: string,
    chapterIds: number[],
  ) => void | Promise<void>;
  onRemoveStoryRoute: (routeId: string) => void | Promise<void>;
  onDownloadExport: (format: string) => void | Promise<void>;
  onResetProject: (
    payload: Record<string, unknown>,
    successText: string,
  ) => void | Promise<void>;
  onClearLogs: () => void | Promise<void>;
  onRefreshHistory: () => void | Promise<void>;
  onDismissTaskActivity: (task: TaskActivityKind) => void | Promise<void>;
}

export function WorkspaceView({
  snapshot,
  projectStatus,
  dictionary,
  chapters,
  topology,
  logs,
  history,
  workspaceForm,
  translatorOptions,
  onRefreshProjectData,
  onProjectCommand,
  onOpenDictionaryEditor,
  onDeleteDictionary,
  onWorkspaceConfigSave,
  onMoveChapter,
  onClearChapterTranslations,
  onRemoveChapter,
  onCreateStoryBranch,
  onUpdateStoryRoute,
  onReorderStoryRouteChapters,
  onRemoveStoryRoute,
  onDownloadExport,
  onResetProject,
  onClearLogs,
  onRefreshHistory,
  onDismissTaskActivity,
}: WorkspaceViewProps) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [branchDraft, setBranchDraft] = useState<{
    parentRouteId: string;
    forkAfterChapterId: number;
    initialName: string;
    eligibleChapterIds: number[];
  } | null>(null);
  const [branchName, setBranchName] = useState('');
  const [branchChapterIds, setBranchChapterIds] = useState<number[]>([]);
  const [routeEditorDraft, setRouteEditorDraft] = useState<{
    routeId: string;
    name: string;
    forkAfterChapterId?: number;
  } | null>(null);
  const [routeEditorName, setRouteEditorName] = useState('');
  const [routeEditorForkAfterChapterId, setRouteEditorForkAfterChapterId] = useState<
    number | undefined
  >(undefined);

  const routeMap = useMemo(
    () => new Map((topology?.routes ?? []).map((route) => [route.id, route] as const)),
    [topology],
  );
  const chapterMap = useMemo(
    () => new Map(chapters.map((chapter) => [chapter.id, chapter] as const)),
    [chapters],
  );
  const effectiveSelectedRouteId =
    selectedRouteId && routeMap.has(selectedRouteId)
      ? selectedRouteId
      : topology?.routes[0]?.id ?? null;
  const selectedRoute = effectiveSelectedRouteId
    ? routeMap.get(effectiveSelectedRouteId) ?? null
    : null;
  const selectedRouteParent = selectedRoute?.parentRouteId
    ? routeMap.get(selectedRoute.parentRouteId) ?? null
    : null;
  const selectedRouteForkOptions = selectedRouteParent?.chapters.map((chapterId) => {
    const chapter = chapterMap.get(chapterId);
    return {
      label: chapter ? formatChapterLabel(chapter) : `章节 ${chapterId}`,
      value: chapterId,
    };
  }) ?? [];

  if (!snapshot) {
    return (
      <Alert
        type="info"
        showIcon
        message="当前没有打开的工作区"
        description="请前往“创建工作区”或“最近工作区”页面创建 / 打开项目。"
      />
    );
  }

  return (
    <div className="section-stack">
      <Tabs
        size="small"
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
                        onClick={() => void onProjectCommand('start')}
                      >
                        启动
                      </Button>
                      <Button
                        icon={<PauseCircleOutlined />}
                        disabled={!snapshot.lifecycle.canStop}
                        onClick={() => void onProjectCommand('pause')}
                      >
                        暂停
                      </Button>
                      <Button
                        icon={<PlayCircleOutlined />}
                        disabled={!snapshot.lifecycle.canResume}
                        onClick={() => void onProjectCommand('resume')}
                      >
                        恢复
                      </Button>
                      <Button
                        danger
                        icon={<StopOutlined />}
                        disabled={!snapshot.lifecycle.canAbort}
                        onClick={() => void onProjectCommand('abort')}
                      >
                        中止
                      </Button>
                      <Button onClick={() => void onProjectCommand('scan')}>
                        扫描术语
                      </Button>
                      <Button onClick={() => void onProjectCommand('plot')}>
                        生成情节大纲
                      </Button>
                      <Button onClick={() => void onProjectCommand('close')}>
                        关闭工作区
                      </Button>
                      <Popconfirm
                        title="确认删除当前工作区？"
                        onConfirm={() => void onProjectCommand('remove')}
                      >
                        <Button danger>移除工作区</Button>
                      </Popconfirm>
                    </Space>
                  </Card>

                  <Row gutter={12}>
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

                  <TaskActivityPanels
                    projectStatus={projectStatus}
                    onDismissTaskActivity={onDismissTaskActivity}
                  />

                  <Card title="步骤队列">
                    {snapshot.queueSnapshots.length === 0 ? (
                      <Empty description="暂无步骤数据" />
                    ) : (
                      <div className="step-list">
                        {snapshot.queueSnapshots.map((queue) => (
                          <div className="step-card" key={queue.stepId}>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
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
                            </div>
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
                      <Button onClick={onRefreshProjectData}>刷新</Button>
                      <Button onClick={() => void onProjectCommand('scan')}>
                        重新扫描
                      </Button>
                      <Button type="primary" onClick={() => onOpenDictionaryEditor()}>
                        新建条目
                      </Button>
                    </Space>
                  }
                >
                  <TaskActivityPanels
                    projectStatus={projectStatus}
                    tasks={['scan']}
                    onDismissTaskActivity={onDismissTaskActivity}
                  />
                  <Table
                    rowKey="term"
                    dataSource={dictionary}
                    pagination={{ pageSize: 10 }}
                    columns={[
                      { title: '术语', dataIndex: 'term', width: 180 },
                      { title: '译文', dataIndex: 'translation', width: 180 },
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
                        width: 120,
                        render: (_, record: GlossaryTerm) =>
                          `${record.totalOccurrenceCount ?? 0} / ${record.textBlockOccurrenceCount ?? 0}`,
                      },
                      {
                        title: '描述',
                        dataIndex: 'description',
                        ellipsis: true,
                      },
                      {
                        title: '操作',
                        width: 140,
                        render: (_, record: GlossaryTerm) => (
                          <Space>
                            <Button
                              type="link"
                              onClick={() => onOpenDictionaryEditor(record)}
                            >
                              编辑
                            </Button>
                            <Popconfirm
                              title="确认删除该术语？"
                              onConfirm={() => void onDeleteDictionary(record.term)}
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
                <Card
                  title="章节管理"
                  extra={
                    topology?.hasBranches ? (
                      <Tag color="processing">拓扑已启用</Tag>
                    ) : (
                      <Tag>线性模式</Tag>
                    )
                  }
                >
                  <Tabs
                    size="small"
                    defaultActiveKey="list"
                    items={[
                      {
                        key: 'list',
                        label: '列表视图',
                        children: (
                          <Space direction="vertical" style={{ width: '100%' }} size={12}>
                            {topology?.hasBranches ? (
                              <Alert
                                type="info"
                                showIcon
                                message="当前存在分支路线"
                                description="线性排序按钮已切换为只读；如需调整分支内章节顺序，请在“拓扑视图”右侧的路线详情里操作。"
                              />
                            ) : null}
                            <Table
                              rowKey="id"
                              dataSource={chapters}
                              pagination={false}
                              columns={[
                                { title: 'ID', dataIndex: 'id', width: 70 },
                                { title: '文件路径', dataIndex: 'filePath' },
                                {
                                  title: '路线',
                                  width: 130,
                                  render: (_, record: WorkspaceChapterDescriptor) => (
                                    <Tag color={record.routeId === 'main' ? 'blue' : 'purple'}>
                                      {record.routeName ?? '主线'}
                                    </Tag>
                                  ),
                                },
                                { title: '片段', dataIndex: 'fragmentCount', width: 90 },
                                {
                                  title: '已译行数',
                                  dataIndex: 'translatedLineCount',
                                  width: 100,
                                },
                                {
                                  title: '拓扑',
                                  width: 180,
                                  render: (_, record: WorkspaceChapterDescriptor) => (
                                    <Space wrap size={[4, 4]}>
                                      {record.isForkPoint ? (
                                        <Tag color="processing">分叉点</Tag>
                                      ) : null}
                                      {(record.childBranchCount ?? 0) > 0 ? (
                                        <Tag color="gold">
                                          {`${record.childBranchCount} 个子分支`}
                                        </Tag>
                                      ) : (
                                        <Tag>线性节点</Tag>
                                      )}
                                    </Space>
                                  ),
                                },
                                {
                                  title: '操作',
                                  width: 360,
                                  render: (_, record: WorkspaceChapterDescriptor, index: number) => (
                                    <Space wrap>
                                      <Button
                                        icon={<ArrowUpOutlined />}
                                        disabled={Boolean(topology?.hasBranches)}
                                        onClick={() => void onMoveChapter(index, -1)}
                                      />
                                      <Button
                                        icon={<ArrowDownOutlined />}
                                        disabled={Boolean(topology?.hasBranches)}
                                        onClick={() => void onMoveChapter(index, 1)}
                                      />
                                      <Button
                                        type="dashed"
                                        onClick={() => {
                                          const eligibleChapterIds = chapters
                                            .filter(
                                              (chapter) =>
                                                chapter.routeId === record.routeId &&
                                                (chapter.routeChapterIndex ?? -1) >
                                                  (record.routeChapterIndex ?? -1),
                                            )
                                            .map((chapter) => chapter.id);
                                          const initialName = `${record.routeName ?? '分支'}-${record.id}`;
                                          setBranchDraft({
                                            parentRouteId: record.routeId ?? 'main',
                                            forkAfterChapterId: record.id,
                                            initialName,
                                            eligibleChapterIds,
                                          });
                                          setBranchName(initialName);
                                          setBranchChapterIds(eligibleChapterIds);
                                        }}
                                      >
                                        创建分支
                                      </Button>
                                      <Popconfirm
                                        title="确认清空该章节的译文？"
                                        onConfirm={() =>
                                          void onClearChapterTranslations([record.id])
                                        }
                                      >
                                        <Button>清空译文</Button>
                                      </Popconfirm>
                                      <Popconfirm
                                        title="确认移除该章节？"
                                        onConfirm={() => void onRemoveChapter(record.id)}
                                      >
                                        <Button danger>移除</Button>
                                      </Popconfirm>
                                    </Space>
                                  ),
                                },
                              ]}
                            />
                          </Space>
                        ),
                      },
                      {
                        key: 'topology',
                        label: '拓扑视图',
                        children: (
                          <Row gutter={16} align="top">
                            <Col span={16}>
                              <StoryTopologyEditor
                                topology={topology}
                                chapters={chapters}
                                selectedRouteId={effectiveSelectedRouteId}
                                onSelectRoute={setSelectedRouteId}
                              />
                            </Col>
                            <Col span={8}>
                              <Card title={selectedRoute ? `路线详情：${selectedRoute.name}` : '路线详情'}>
                                {selectedRoute ? (
                                  <Space
                                    direction="vertical"
                                    size={12}
                                    style={{ width: '100%' }}
                                  >
                                    <Descriptions
                                      size="small"
                                      column={1}
                                      items={[
                                        {
                                          key: 'type',
                                          label: '类型',
                                          children: selectedRoute.isMain ? '主线' : '分支',
                                        },
                                        {
                                          key: 'parent',
                                          label: '父路线',
                                          children: selectedRoute.parentRouteId ?? '—',
                                        },
                                        {
                                          key: 'fork',
                                          label: '分叉点',
                                          children:
                                            selectedRoute.forkAfterChapterId == null
                                              ? '—'
                                              : `章节 ${selectedRoute.forkAfterChapterId}`,
                                        },
                                        {
                                          key: 'count',
                                          label: '章节数',
                                          children: selectedRoute.chapters.length,
                                        },
                                      ]}
                                    />
                                    <Space wrap>
                                      <Button
                                        onClick={() => {
                                          setRouteEditorDraft({
                                            routeId: selectedRoute.id,
                                            name: selectedRoute.name,
                                            forkAfterChapterId:
                                              selectedRoute.forkAfterChapterId ?? undefined,
                                          });
                                          setRouteEditorName(selectedRoute.name);
                                          setRouteEditorForkAfterChapterId(
                                            selectedRoute.forkAfterChapterId ?? undefined,
                                          );
                                        }}
                                      >
                                        编辑路线
                                      </Button>
                                      {!selectedRoute.isMain ? (
                                        <Popconfirm
                                          title="仅空分支可删除，确认继续？"
                                          onConfirm={() =>
                                            void onRemoveStoryRoute(selectedRoute.id)
                                          }
                                        >
                                          <Button
                                            danger
                                            disabled={
                                              selectedRoute.chapters.length > 0 ||
                                              selectedRoute.childRouteIds.length > 0
                                            }
                                          >
                                            删除空分支
                                          </Button>
                                        </Popconfirm>
                                      ) : null}
                                    </Space>
                                    <List
                                      size="small"
                                      header="路线章节"
                                      dataSource={selectedRoute.chapters}
                                      renderItem={(chapterId, chapterIndex) => {
                                        const chapter = chapterMap.get(chapterId);
                                        return (
                                          <List.Item
                                            actions={[
                                              <Button
                                                key="up"
                                                size="small"
                                                icon={<ArrowUpOutlined />}
                                                disabled={chapterIndex === 0}
                                                onClick={() => {
                                                  const next = [...selectedRoute.chapters];
                                                  const current = next[chapterIndex];
                                                  const previous =
                                                    next[chapterIndex - 1];
                                                  if (
                                                    current === undefined ||
                                                    previous === undefined
                                                  ) {
                                                    return;
                                                  }
                                                  next[chapterIndex - 1] = current;
                                                  next[chapterIndex] = previous;
                                                  void onReorderStoryRouteChapters(
                                                    selectedRoute.id,
                                                    next,
                                                  );
                                                }}
                                              />,
                                              <Button
                                                key="down"
                                                size="small"
                                                icon={<ArrowDownOutlined />}
                                                disabled={
                                                  chapterIndex >=
                                                  selectedRoute.chapters.length - 1
                                                }
                                                onClick={() => {
                                                  const next = [...selectedRoute.chapters];
                                                  const current = next[chapterIndex];
                                                  const following =
                                                    next[chapterIndex + 1];
                                                  if (
                                                    current === undefined ||
                                                    following === undefined
                                                  ) {
                                                    return;
                                                  }
                                                  next[chapterIndex] = following;
                                                  next[chapterIndex + 1] = current;
                                                  void onReorderStoryRouteChapters(
                                                    selectedRoute.id,
                                                    next,
                                                  );
                                                }}
                                              />,
                                            ]}
                                          >
                                            {chapter ? formatChapterLabel(chapter) : `章节 ${chapterId}`}
                                          </List.Item>
                                        );
                                      }}
                                    />
                                  </Space>
                                ) : (
                                  <Empty description="点击画布中的路线卡片查看详情" />
                                )}
                              </Card>
                            </Col>
                          </Row>
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
                      onFinish={(values) => void onWorkspaceConfigSave(values)}
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
                          <Form.Item name="defaultImportFormat" label="默认导入格式">
                            <Select options={IMPORT_FORMAT_OPTIONS} />
                          </Form.Item>
                        </Col>
                        <Col span={6}>
                          <Form.Item name="defaultExportFormat" label="默认导出格式">
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
                      <Card title="导出项目" extra={<ExportOutlined />}>
                        <Space direction="vertical" style={{ width: '100%' }}>
                          <Button
                            icon={<DownloadOutlined />}
                            type="primary"
                            onClick={() => void onDownloadExport('plain_text')}
                          >
                            下载纯文本导出 ZIP
                          </Button>
                          <Button
                            icon={<EyeOutlined />}
                            disabled={chapters.length === 0}
                            onClick={() => setPreviewOpen(true)}
                          >
                            网页内预览译文
                          </Button>
                          <Button onClick={() => void onDownloadExport('naturedialog')}>
                            下载 Nature Dialog 导出 ZIP
                          </Button>
                          <Button onClick={() => void onDownloadExport('m3t')}>
                            下载 M3T 导出 ZIP
                          </Button>
                          <Button
                            onClick={() => void onDownloadExport('galtransl_json')}
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
                              void onResetProject(
                                { clearAllTranslations: true },
                                '已清空所有译文',
                              )
                            }
                          >
                            清空全部译文
                          </Button>
                          <Button
                            danger
                            onClick={() =>
                              void onResetProject(
                                { clearGlossary: true },
                                '已清空术语表',
                              )
                            }
                          >
                            清空术语表
                          </Button>
                          <Button
                            danger
                            onClick={() =>
                              void onResetProject(
                                { clearGlossaryTranslations: true },
                                '已清空术语表译文',
                              )
                            }
                          >
                            清空术语表译文
                          </Button>
                          <Button
                            danger
                            onClick={() =>
                              void onResetProject(
                                { clearPlotSummaries: true },
                                '已清空情节大纲',
                              )
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
                    <Tabs
                      size="small"
                      defaultActiveKey="runtime-logs"
                      items={[
                    {
                      key: 'runtime-logs',
                      label: '运行日志',
                      children: (
                        <LogsPanel
                          logs={logs}
                          onClearLogs={onClearLogs}
                          onRefreshProjectData={onRefreshProjectData}
                        />
                      ),
                    },
                    {
                      key: 'llm-history',
                      label: 'LLM 请求历史',
                      children: (
                        <LlmHistoryPanel
                          history={history}
                          onRefreshHistory={onRefreshHistory}
                        />
                      ),
                    },
                  ]}
                />
              ),
            },
          ]}
      />
      <TranslationPreviewModal
        open={previewOpen}
        chapters={chapters}
        onCancel={() => setPreviewOpen(false)}
      />
      <Modal
        open={branchDraft !== null}
        title="创建分支"
        onCancel={() => {
          setBranchDraft(null);
          setBranchName('');
          setBranchChapterIds([]);
        }}
        onOk={() => {
          if (!branchDraft) {
            return;
          }
          const payload = {
            name: branchName.trim() || branchDraft.initialName,
            parentRouteId: branchDraft.parentRouteId,
            forkAfterChapterId: branchDraft.forkAfterChapterId,
            chapterIds: branchChapterIds,
          };
          void onCreateStoryBranch(payload);
          setSelectedRouteId(branchDraft.parentRouteId);
          setBranchDraft(null);
          setBranchName('');
          setBranchChapterIds([]);
        }}
      >
        {branchDraft ? (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <Input
              value={branchName}
              onChange={(event) => setBranchName(event.target.value)}
              placeholder="请输入分支名称"
            />
            <Typography.Text type="secondary">
              {`从路线 ${branchDraft.parentRouteId} 的章节 ${branchDraft.forkAfterChapterId} 之后分叉`}
            </Typography.Text>
            <Select
              mode="multiple"
              value={branchChapterIds}
              onChange={(value) => setBranchChapterIds(value)}
              style={{ width: '100%' }}
              placeholder="选择要分配到新分支的章节"
              options={branchDraft.eligibleChapterIds.map((chapterId) => {
                const chapter = chapterMap.get(chapterId);
                return {
                  label: chapter ? formatChapterLabel(chapter) : `章节 ${chapterId}`,
                  value: chapterId,
                };
              })}
            />
          </Space>
        ) : null}
      </Modal>
      <Modal
        open={routeEditorDraft !== null}
        title="编辑路线"
        onCancel={() => {
          setRouteEditorDraft(null);
          setRouteEditorName('');
          setRouteEditorForkAfterChapterId(undefined);
        }}
        onOk={() => {
          if (!routeEditorDraft) {
            return;
          }
          const payload: UpdateStoryRoutePayload = {
            name: routeEditorName.trim() || routeEditorDraft.name,
          };
          if (routeEditorForkAfterChapterId !== undefined) {
            payload.forkAfterChapterId = routeEditorForkAfterChapterId;
          }
          void onUpdateStoryRoute(routeEditorDraft.routeId, payload);
          setRouteEditorDraft(null);
          setRouteEditorName('');
          setRouteEditorForkAfterChapterId(undefined);
        }}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Input
            value={routeEditorName}
            onChange={(event) => setRouteEditorName(event.target.value)}
            placeholder="路线名称"
          />
          {routeEditorDraft?.forkAfterChapterId !== undefined ? (
            <Select
              value={routeEditorForkAfterChapterId}
              onChange={(value) => setRouteEditorForkAfterChapterId(value)}
              style={{ width: '100%' }}
              placeholder="选择分叉点章节"
              options={selectedRouteForkOptions}
            />
          ) : null}
        </Space>
      </Modal>
    </div>
  );
}

function formatChapterLabel(chapter: WorkspaceChapterDescriptor): string {
  return `#${chapter.id} ${chapter.filePath}`;
}

export type TaskActivityKind = 'scan' | 'plot';

function LogsPanel({
  logs,
  onClearLogs,
  onRefreshProjectData,
}: {
  logs: LogEntry[];
  onClearLogs: () => void | Promise<void>;
  onRefreshProjectData: () => void;
}) {
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);

  return (
    <>
      <Card
        title="事件日志"
        extra={
          <Space>
            <Button onClick={() => void onClearLogs()}>清空</Button>
            <Button onClick={onRefreshProjectData}>刷新</Button>
          </Space>
        }
      >
        {logs.length === 0 ? (
          <Empty description="暂无日志" />
        ) : (
          <List
            dataSource={[...logs].reverse()}
            renderItem={(item) => (
              <List.Item
                key={item.id}
                actions={[
                  <Button key="detail" type="link" onClick={() => setSelectedLog(item)}>
                    详情
                  </Button>,
                ]}
              >
                <Space wrap size={[8, 8]}>
                  <Tag color={logColor(item.level)}>{item.level.toUpperCase()}</Tag>
                  <Typography.Text type="secondary">
                    {new Date(item.timestamp).toLocaleString()}
                  </Typography.Text>
                  <Typography.Text
                    ellipsis={{ tooltip: item.message }}
                    style={{ maxWidth: 520 }}
                  >
                    {item.message}
                  </Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        )}
      </Card>
      <Modal
        open={selectedLog !== null}
        title="日志详情"
        footer={
          <Button onClick={() => setSelectedLog(null)}>
            关闭
          </Button>
        }
        onCancel={() => setSelectedLog(null)}
      >
        {selectedLog ? (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="级别">
                <Tag color={logColor(selectedLog.level)}>{selectedLog.level.toUpperCase()}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="时间">
                {new Date(selectedLog.timestamp).toLocaleString()}
              </Descriptions.Item>
              <Descriptions.Item label="ID">{selectedLog.id}</Descriptions.Item>
            </Descriptions>
            <DetailSection title="消息" content={selectedLog.message} />
          </Space>
        ) : null}
      </Modal>
    </>
  );
}

function LlmHistoryPanel({
  history,
  onRefreshHistory,
}: {
  history: LlmRequestHistoryEntry[];
  onRefreshHistory: () => void | Promise<void>;
}) {
  const [selectedEntry, setSelectedEntry] = useState<LlmRequestHistoryEntry | null>(null);

  return (
    <>
      <Card
        title="LLM 请求历史"
        extra={<Button onClick={() => void onRefreshHistory()}>刷新</Button>}
      >
        {history.length === 0 ? (
          <Empty description="暂无请求历史" />
        ) : (
          <List
            dataSource={history}
            renderItem={(entry) => (
              <List.Item
                key={`${entry.source ?? 'llm'}-${entry.requestId}-${entry.timestamp}`}
                actions={[
                  <Button
                    key="detail"
                    type="link"
                    onClick={() => setSelectedEntry(entry)}
                  >
                    详情
                  </Button>,
                ]}
              >
                <Space wrap size={[8, 8]}>
                  <Tag color={entry.type === 'error' ? 'error' : 'success'}>
                    {entry.type === 'error' ? 'ERROR' : 'COMPLETION'}
                  </Tag>
                  {entry.meta?.label ? <Tag color="purple">{entry.meta.label}</Tag> : null}
                  {entry.source ? <Tag>{entry.source}</Tag> : null}
                  {entry.meta?.stage ? <Tag>{`stage ${entry.meta.stage}`}</Tag> : null}
                  {entry.modelName ? <Tag color="blue">{entry.modelName}</Tag> : null}
                  <Tag>{`requestId ${entry.requestId}`}</Tag>
                  {entry.durationSeconds != null ? (
                    <Tag>{`${entry.durationSeconds.toFixed(3)}s`}</Tag>
                  ) : null}
                  {entry.statistics ? (
                    <Tag>{`tokens ${entry.statistics.totalTokens}`}</Tag>
                  ) : null}
                  <Typography.Text type="secondary">
                    {new Date(entry.timestamp).toLocaleString()}
                  </Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        )}
      </Card>
      <Modal
        open={selectedEntry !== null}
        title="LLM 请求详情"
        width={960}
        footer={
          <Button onClick={() => setSelectedEntry(null)}>
            关闭
          </Button>
        }
        onCancel={() => setSelectedEntry(null)}
      >
        {selectedEntry ? (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="状态">
                <Tag color={selectedEntry.type === 'error' ? 'error' : 'success'}>
                  {selectedEntry.type === 'error' ? 'ERROR' : 'COMPLETION'}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="时间">
                {new Date(selectedEntry.timestamp).toLocaleString()}
              </Descriptions.Item>
              <Descriptions.Item label="请求 ID">
                {selectedEntry.requestId}
              </Descriptions.Item>
              <Descriptions.Item label="来源">
                {selectedEntry.source ?? '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Meta">
                {selectedEntry.meta?.label ?? '-'}
              </Descriptions.Item>
              <Descriptions.Item label="模型">
                {selectedEntry.modelName ?? '-'}
              </Descriptions.Item>
              <Descriptions.Item label="时长">
                {selectedEntry.durationSeconds != null
                  ? `${selectedEntry.durationSeconds.toFixed(3)}s`
                  : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Token">
                {selectedEntry.statistics?.totalTokens ?? '-'}
              </Descriptions.Item>
            </Descriptions>
            {selectedEntry.meta ? (
              <DetailSection
                title="Meta"
                content={JSON.stringify(selectedEntry.meta, null, 2)}
              />
            ) : null}
            {selectedEntry.requestConfig?.systemPrompt ? (
              <DetailSection
                title="System Prompt"
                content={selectedEntry.requestConfig.systemPrompt}
              />
            ) : null}
            <DetailSection title="User Prompt" content={selectedEntry.prompt} />
            {selectedEntry.response ? (
              <DetailSection title="Response" content={selectedEntry.response} />
            ) : null}
            {selectedEntry.reasoning ? (
              <DetailSection title="Reasoning" content={selectedEntry.reasoning} />
            ) : null}
            {selectedEntry.errorMessage ? (
              <DetailSection title="Error" content={selectedEntry.errorMessage} />
            ) : null}
            {selectedEntry.responseBody ? (
              <DetailSection title="Response Body" content={selectedEntry.responseBody} />
            ) : null}
            {selectedEntry.requestConfig ? (
              <DetailSection
                title="Request Config"
                content={JSON.stringify(selectedEntry.requestConfig, null, 2)}
              />
            ) : null}
          </Space>
        ) : null}
      </Modal>
    </>
  );
}

function DetailSection({ title, content }: { title: string; content: string }) {
  return (
    <div>
      <Typography.Text strong>{title}</Typography.Text>
      <div className="mono-block" style={{ marginTop: 8 }}>
        {content}
      </div>
    </div>
  );
}

function TaskActivityPanels({
  projectStatus,
  tasks = ['scan', 'plot'],
  onDismissTaskActivity,
}: {
  projectStatus: ProjectStatus | null;
  tasks?: TaskActivityKind[];
  onDismissTaskActivity: (task: TaskActivityKind) => void | Promise<void>;
}) {
  const visibleTasks: Array<{
    key: TaskActivityKind;
    title: string;
    progress:
      | NonNullable<ProjectStatus['scanDictionaryProgress']>
      | NonNullable<ProjectStatus['plotSummaryProgress']>;
    details: ReactNode;
  }> = [];

  for (const task of tasks) {
    if (task === 'scan' && projectStatus?.scanDictionaryProgress) {
      visibleTasks.push({
        key: 'scan',
        title: '术语扫描',
        progress: projectStatus.scanDictionaryProgress,
        details: (
          <Space wrap>
            <Tag>{`批次 ${projectStatus.scanDictionaryProgress.completedBatches}/${projectStatus.scanDictionaryProgress.totalBatches}`}</Tag>
            <Tag>{`总行数 ${projectStatus.scanDictionaryProgress.totalLines}`}</Tag>
          </Space>
        ),
      });
      continue;
    }

    if (task === 'plot' && projectStatus?.plotSummaryProgress) {
      const plotProgress = projectStatus.plotSummaryProgress;
      visibleTasks.push({
        key: 'plot',
        title: '情节大纲',
        progress: plotProgress,
        details: (
          <Space direction="vertical" style={{ width: '100%' }} size={8}>
            <Progress
              percent={toPercent(
                plotProgress.completedChapters,
                plotProgress.totalChapters,
                plotProgress.status,
              )}
              status={toProgressStatus(plotProgress.status)}
              format={() =>
                `${plotProgress.completedChapters}/${plotProgress.totalChapters} 章节`
              }
            />
            <Space wrap>
              <Tag>{`批次 ${plotProgress.completedBatches}/${plotProgress.totalBatches}`}</Tag>
              {plotProgress.currentChapterId != null ? (
                <Tag color="processing">
                  {`当前章节 ${plotProgress.currentChapterId}`}
                </Tag>
              ) : null}
            </Space>
          </Space>
        ),
      });
    }
  }

  if (visibleTasks.length === 0) {
    return null;
  }

  const colSpan = visibleTasks.length === 1 ? 24 : 12;

  return (
    <Row gutter={[16, 16]}>
      {visibleTasks.map((task) => (
        <Col key={task.key} span={colSpan}>
          <TaskActivityCard
            task={task.key}
            title={task.title}
            progress={task.progress}
            details={task.details}
            onDismiss={() => void onDismissTaskActivity(task.key)}
          />
        </Col>
      ))}
    </Row>
  );
}

function TaskActivityCard({
  task,
  title,
  progress,
  details,
  onDismiss,
}: {
  task: TaskActivityKind;
  title: string;
  progress:
    | NonNullable<ProjectStatus['scanDictionaryProgress']>
    | NonNullable<ProjectStatus['plotSummaryProgress']>;
  details: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <Card
      size="small"
      title={title}
      extra={
        <Space size="small">
          <Tag color={toTaskStatusColor(progress.status)}>
            {toTaskStatusLabel(progress.status)}
          </Tag>
          {progress.status !== 'running' ? (
            <Button
              type="text"
              size="small"
              icon={<CloseOutlined />}
              onClick={onDismiss}
              aria-label={`关闭${task}进度卡片`}
            />
          ) : null}
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Progress
          percent={toPercent(
            progress.completedBatches,
            progress.totalBatches,
            progress.status,
          )}
          status={toProgressStatus(progress.status)}
          format={() => `${progress.completedBatches}/${progress.totalBatches} 批`}
        />
        {details}
        {progress.errorMessage ? (
          <Alert type="error" showIcon message={progress.errorMessage} />
        ) : null}
      </Space>
    </Card>
  );
}

function toPercent(
  completed: number,
  total: number,
  status: 'running' | 'done' | 'error',
): number {
  if (total <= 0) {
    return status === 'done' ? 100 : 0;
  }
  return Number(((completed / total) * 100).toFixed(1));
}

function toProgressStatus(status: 'running' | 'done' | 'error'): 'active' | 'success' | 'exception' {
  switch (status) {
    case 'done':
      return 'success';
    case 'error':
      return 'exception';
    default:
      return 'active';
  }
}

function toTaskStatusColor(status: 'running' | 'done' | 'error'): string {
  switch (status) {
    case 'done':
      return 'success';
    case 'error':
      return 'error';
    default:
      return 'processing';
  }
}

function toTaskStatusLabel(status: 'running' | 'done' | 'error'): string {
  switch (status) {
    case 'done':
      return '已完成';
    case 'error':
      return '失败';
    default:
      return '进行中';
  }
}
