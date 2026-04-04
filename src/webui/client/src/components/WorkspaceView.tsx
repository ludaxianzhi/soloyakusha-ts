import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
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
  Upload,
} from 'antd';
import type { FormInstance, UploadFile } from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  BookOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  DownloadOutlined,
  ExportOutlined,
  FileZipOutlined,
  FolderOpenOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RobotOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { IMPORT_FORMAT_OPTIONS, logColor, statusColor } from '../app/ui-helpers.ts';
import type {
  GlossaryTerm,
  LogEntry,
  ManagedWorkspace,
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
  workspaces: ManagedWorkspace[];
  snapshot: TranslationProjectSnapshot | null;
  projectStatus: ProjectStatus | null;
  dictionary: GlossaryTerm[];
  chapters: WorkspaceChapterDescriptor[];
  logs: LogEntry[];
  history: string;
  uploadForm: FormInstance<Record<string, unknown>>;
  workspaceForm: FormInstance<Record<string, unknown>>;
  uploadFiles: UploadFile[];
  translatorOptions: Array<{ label: string; value: string }>;
  onUploadFilesChange: (files: UploadFile[]) => void;
  onUploadSubmit: (values: Record<string, unknown>) => void | Promise<void>;
  onRefreshBootData: () => void;
  onRefreshProjectData: () => void;
  onOpenWorkspace: (workspace: ManagedWorkspace) => void | Promise<void>;
  onDeleteWorkspace: (workspace: ManagedWorkspace) => void | Promise<void>;
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
}

export function WorkspaceView({
  workspaces,
  snapshot,
  projectStatus,
  dictionary,
  chapters,
  logs,
  history,
  uploadForm,
  workspaceForm,
  uploadFiles,
  translatorOptions,
  onUploadFilesChange,
  onUploadSubmit,
  onRefreshBootData,
  onRefreshProjectData,
  onOpenWorkspace,
  onDeleteWorkspace,
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
}: WorkspaceViewProps) {
  return (
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
            extra={<Tag color="blue">远程友好</Tag>}
          >
            <Form
              form={uploadForm}
              layout="vertical"
              className="compact-form"
              initialValues={{ projectName: '新建项目' }}
              onFinish={(values) => void onUploadSubmit(values)}
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
                  onChange={({ fileList }) => onUploadFilesChange(fileList.slice(-1))}
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
              <Button icon={<ReloadOutlined />} onClick={onRefreshBootData}>
                刷新
              </Button>
            }
          >
            {workspaces.length === 0 ? (
              <Empty description="暂无工作区" />
            ) : (
              <Space direction="vertical" style={{ width: '100%' }}>
                {workspaces.map((workspace) => (
                  <div
                    key={workspace.dir}
                    style={{
                      padding: 12,
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: 8,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                      <div>
                        <Space>
                          <span>{workspace.name}</span>
                          {workspace.managed && <Tag color="green">托管</Tag>}
                        </Space>
                        <div>{workspace.dir}</div>
                        <div>
                          <Typography.Text type="secondary">
                            最近打开：{new Date(workspace.lastOpenedAt).toLocaleString()}
                          </Typography.Text>
                        </div>
                      </div>
                      <Space>
                        <Button type="link" onClick={() => void onOpenWorkspace(workspace)}>
                          打开
                        </Button>
                        <Popconfirm
                          title="确认删除该工作区？"
                          onConfirm={() => void onDeleteWorkspace(workspace)}
                        >
                          <Button type="link" danger>
                            删除
                          </Button>
                        </Popconfirm>
                      </Space>
                    </div>
                  </div>
                ))}
              </Space>
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

                  <ProgressAlerts projectStatus={projectStatus} />

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
                          <Button onClick={onRefreshBootData}>刷新</Button>
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
}

function ProgressAlerts({ projectStatus }: { projectStatus: ProjectStatus | null }) {
  return (
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
}
