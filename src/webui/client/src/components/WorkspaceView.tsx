import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
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
import type { ReactNode } from 'react';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  BookOutlined,
  CloseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  ExportOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  RobotOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { IMPORT_FORMAT_OPTIONS, logColor, statusColor } from '../app/ui-helpers.ts';
import type {
  GlossaryTerm,
  LlmRequestHistoryEntry,
  LogEntry,
  ProjectStatus,
  TranslationProjectSnapshot,
  WorkspaceChapterDescriptor,
} from '../app/types.ts';

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
  onDownloadExport,
  onResetProject,
  onClearLogs,
  onRefreshHistory,
  onDismissTaskActivity,
}: WorkspaceViewProps) {
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
                        render: (_, record: WorkspaceChapterDescriptor, index: number) => (
                          <Space>
                            <Button
                              icon={<ArrowUpOutlined />}
                              onClick={() => void onMoveChapter(index, -1)}
                            />
                            <Button
                              icon={<ArrowDownOutlined />}
                              onClick={() => void onMoveChapter(index, 1)}
                            />
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
                <Row gutter={16}>
                  <Col span={12}>
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
                        <div className="log-list">
                          <Space direction="vertical" style={{ width: '100%' }}>
                            {[...logs].reverse().map((item) => (
                              <div
                                key={item.id}
                                style={{
                                  padding: '8px 0',
                                  borderBottom: '1px solid rgba(255,255,255,0.08)',
                                }}
                              >
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
                              </div>
                            ))}
                          </Space>
                        </div>
                      )}
                    </Card>
                  </Col>
                  <Col span={12}>
                    <Card
                      title="LLM 请求历史"
                      extra={<Button onClick={() => void onRefreshHistory()}>刷新</Button>}
                    >
                      {history.length > 0 ? (
                        <div className="log-list">
                          <Space direction="vertical" style={{ width: '100%' }}>
                            {history.map((entry) => (
                              <Card
                                key={`${entry.source ?? 'llm'}-${entry.requestId}-${entry.timestamp}`}
                                size="small"
                                title={
                                  <Space wrap>
                                    <Tag color={entry.type === 'error' ? 'error' : 'success'}>
                                      {entry.type === 'error' ? 'ERROR' : 'COMPLETION'}
                                    </Tag>
                                    {entry.source ? <Tag>{entry.source}</Tag> : null}
                                    {entry.meta?.label ? (
                                      <Tag color="purple">{entry.meta.label}</Tag>
                                    ) : null}
                                    {entry.modelName ? <Tag color="blue">{entry.modelName}</Tag> : null}
                                    <Typography.Text type="secondary">
                                      {new Date(entry.timestamp).toLocaleString()}
                                    </Typography.Text>
                                  </Space>
                                }
                              >
                                <Space direction="vertical" style={{ width: '100%' }} size="middle">
                                  <Space wrap>
                                    <Tag>{`requestId ${entry.requestId}`}</Tag>
                                    {entry.durationSeconds != null ? (
                                      <Tag>{`${entry.durationSeconds.toFixed(3)}s`}</Tag>
                                    ) : null}
                                    {entry.statistics ? (
                                      <Tag>{`tokens ${entry.statistics.totalTokens}`}</Tag>
                                    ) : null}
                                    {entry.meta?.stage ? <Tag>{`stage ${entry.meta.stage}`}</Tag> : null}
                                  </Space>
                                  {entry.meta ? (
                                    <HistorySection
                                      title="Meta"
                                      content={JSON.stringify(entry.meta, null, 2)}
                                    />
                                  ) : null}
                                  {entry.requestConfig?.systemPrompt ? (
                                    <HistorySection
                                      title="System Prompt"
                                      content={entry.requestConfig.systemPrompt}
                                    />
                                  ) : null}
                                  <HistorySection title="User Prompt" content={entry.prompt} />
                                  {entry.response ? (
                                    <HistorySection title="Response" content={entry.response} />
                                  ) : null}
                                  {entry.reasoning ? (
                                    <HistorySection title="Reasoning" content={entry.reasoning} />
                                  ) : null}
                                  {entry.errorMessage ? (
                                    <HistorySection title="Error" content={entry.errorMessage} />
                                  ) : null}
                                  {entry.responseBody ? (
                                    <HistorySection
                                      title="Response Body"
                                      content={entry.responseBody}
                                    />
                                  ) : null}
                                  {entry.requestConfig ? (
                                    <HistorySection
                                      title="Request Config"
                                      content={JSON.stringify(entry.requestConfig, null, 2)}
                                    />
                                  ) : null}
                                </Space>
                              </Card>
                            ))}
                          </Space>
                        </div>
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
    </div>
  );
}

export type TaskActivityKind = 'scan' | 'plot';

function HistorySection({ title, content }: { title: string; content: string }) {
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
