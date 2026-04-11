import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { UploadFile } from 'antd';
import { useNavigate } from 'react-router-dom';
import type {
  CreateStoryBranchPayload,
  ImportArchiveResult,
  StoryTopologyDescriptor,
  UpdateStoryRoutePayload,
  WorkspaceChapterDescriptor,
} from '../../app/types.ts';
import {
  DEFAULT_ARCHIVE_IMPORT_PATTERN,
  IMPORT_FORMAT_OPTIONS,
} from '../../app/ui-helpers.ts';
import { usePollingTask } from '../../app/usePollingTask.ts';
import { ChapterKanbanBoard } from '../topology/ChapterKanbanBoard.tsx';
import {
  buildChapterImportGroups,
  formatChapterLabel,
  type ChapterImportGroupDescriptor,
} from './utils.ts';

interface WorkspaceChaptersTabProps {
  active: boolean;
  chapters: WorkspaceChapterDescriptor[];
  topology: StoryTopologyDescriptor | null;
  defaultImportFormat?: string;
  onRefreshChapters: () => void | Promise<void>;
  onRefreshTopology: () => void | Promise<void>;
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
}

type RouteAttachCandidate = {
  id: string;
  name: string;
  chapters: number[];
};

type AttachGroupBranchFormValues = {
  name: string;
  parentRouteId: string;
  forkAfterChapterId: number;
};

type ImportArchiveFormValues = {
  importFormat?: string;
  importPattern?: string;
  importTranslation?: boolean;
};

export function WorkspaceChaptersTab({
  active,
  chapters,
  topology,
  defaultImportFormat,
  onRefreshChapters,
  onRefreshTopology,
  onClearChapterTranslations,
  onRemoveChapters,
  onCreateStoryBranch,
  onUpdateStoryRoute,
  onReorderStoryRouteChapters,
  onMoveChapterToRoute,
  onRemoveStoryRoute,
  onImportChapterArchive,
}: WorkspaceChaptersTabProps) {
  const [activeTabKey, setActiveTabKey] = useState('arrange');

  useEffect(() => {
    if (!active) {
      return;
    }

    void onRefreshChapters();
  }, [active, onRefreshChapters]);

  useEffect(() => {
    if (!active) {
      return;
    }
    void onRefreshTopology();
  }, [active, onRefreshTopology]);

  usePollingTask({
    enabled: active,
    intervalMs: 5_000,
    task: async () => {
      await onRefreshChapters();
    },
  });

  const routeCount = topology?.routes.length ?? 0;
  const branchCount = routeCount > 1 ? routeCount - 1 : 0;

  return (
    <Card
      title="章节管理"
      extra={
        <Space size={8}>
          {branchCount > 0 ? (
            <Tag color="processing">{branchCount} 个分支路线</Tag>
          ) : null}
          <Tag>{chapters.length} 章节</Tag>
        </Space>
      }
    >
      <Tabs
        size="small"
        activeKey={activeTabKey}
        onChange={setActiveTabKey}
        items={[
          {
            key: 'arrange',
            label: '编排',
            children: (
              <ChapterKanbanBoard
                topology={topology}
                chapters={chapters}
                onReorderRouteChapters={onReorderStoryRouteChapters}
                onMoveChapterToRoute={onMoveChapterToRoute}
                onCreateBranch={onCreateStoryBranch}
                onClearChapterTranslations={onClearChapterTranslations}
                onRemoveChapters={onRemoveChapters}
                onRemoveRoute={onRemoveStoryRoute}
                onUpdateRoute={onUpdateStoryRoute}
              />
            ),
          },
          {
            key: 'list',
            label: '列表',
            children: (
              <ChapterInfoTable
                chapters={chapters}
                topology={topology}
                defaultImportFormat={defaultImportFormat}
                onClearChapterTranslations={onClearChapterTranslations}
                onRemoveChapters={onRemoveChapters}
                onCreateStoryBranch={onCreateStoryBranch}
                onImportChapterArchive={onImportChapterArchive}
              />
            ),
          },
        ]}
      />
    </Card>
  );
}

function selectDefaultAttachRoute(
  routeCandidates: RouteAttachCandidate[],
  groupChapterIds: number[],
): RouteAttachCandidate | undefined {
  if (routeCandidates.length === 0) {
    return undefined;
  }

  const groupChapterSet = new Set(groupChapterIds);
  let bestRoute = routeCandidates[0];
  let bestOverlap = -1;
  for (const route of routeCandidates) {
    const overlap = route.chapters.reduce(
      (count, chapterId) => count + (groupChapterSet.has(chapterId) ? 1 : 0),
      0,
    );
    if (overlap > bestOverlap) {
      bestRoute = route;
      bestOverlap = overlap;
    }
  }
  return bestRoute;
}

function selectDefaultForkAfterChapterId(
  routeChapterIds: number[],
  groupChapterIds: number[],
): number | undefined {
  if (routeChapterIds.length === 0) {
    return undefined;
  }

  const groupChapterSet = new Set(groupChapterIds);
  let bestForkIndex = -1;
  let bestMovableCount = -1;
  for (let forkIndex = 0; forkIndex < routeChapterIds.length; forkIndex += 1) {
    let movableCount = 0;
    for (let chapterIndex = forkIndex + 1; chapterIndex < routeChapterIds.length; chapterIndex += 1) {
      if (groupChapterSet.has(routeChapterIds[chapterIndex]!)) {
        movableCount += 1;
      }
    }
    if (movableCount > bestMovableCount) {
      bestMovableCount = movableCount;
      bestForkIndex = forkIndex;
    }
  }

  if (bestForkIndex === -1) {
    return undefined;
  }
  return routeChapterIds[bestForkIndex];
}

function resolveAttachableChapterIds(
  routeChapterIds: number[],
  groupChapterIds: number[],
  forkAfterChapterId: number,
): number[] {
  const forkIndex = routeChapterIds.indexOf(forkAfterChapterId);
  if (forkIndex === -1) {
    return [];
  }
  const groupChapterSet = new Set(groupChapterIds);
  return routeChapterIds.filter(
    (chapterId, chapterIndex) =>
      chapterIndex > forkIndex && groupChapterSet.has(chapterId),
  );
}

function ChapterInfoTable({
  chapters,
  topology,
  defaultImportFormat,
  onClearChapterTranslations,
  onRemoveChapters,
  onCreateStoryBranch,
  onImportChapterArchive,
}: {
  chapters: WorkspaceChapterDescriptor[];
  topology: StoryTopologyDescriptor | null;
  defaultImportFormat?: string;
  onClearChapterTranslations: (chapterIds: number[]) => void | Promise<void>;
  onRemoveChapters: (
    chapterIds: number[],
    options?: { cascadeBranches?: boolean },
  ) => void | Promise<void>;
  onCreateStoryBranch: (payload: CreateStoryBranchPayload) => void | Promise<void>;
  onImportChapterArchive: (payload: {
    file: File;
    importFormat?: string;
    importPattern?: string;
    importTranslation?: boolean;
  }) => Promise<ImportArchiveResult>;
}) {
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const [selectedChapterIds, setSelectedChapterIds] = useState<number[]>([]);
  const [attachGroup, setAttachGroup] = useState<ChapterImportGroupDescriptor | null>(null);
  const [attachForm] = Form.useForm<AttachGroupBranchFormValues>();
  const [importArchiveOpen, setImportArchiveOpen] = useState(false);
  const [importArchiveSubmitting, setImportArchiveSubmitting] = useState(false);
  const [importArchiveFiles, setImportArchiveFiles] = useState<UploadFile[]>([]);
  const [importArchiveResult, setImportArchiveResult] = useState<ImportArchiveResult | null>(null);
  const [importArchiveForm] = Form.useForm<ImportArchiveFormValues>();
  const selectedParentRouteId = Form.useWatch('parentRouteId', attachForm);
  const selectedForkAfterChapterId = Form.useWatch('forkAfterChapterId', attachForm);

  const chapterIdSet = useMemo(
    () => new Set(chapters.map((chapter) => chapter.id)),
    [chapters],
  );
  const chapterById = useMemo(
    () => new Map(chapters.map((chapter) => [chapter.id, chapter] as const)),
    [chapters],
  );
  const chapterGroups = useMemo(() => buildChapterImportGroups(chapters), [chapters]);
  const routeCandidates = useMemo<RouteAttachCandidate[]>(() => {
    if (topology && topology.routes.length > 0) {
      return topology.routes.map((route) => ({
        id: route.id,
        name: route.name,
        chapters: route.chapters,
      }));
    }
    return [
      {
        id: 'main',
        name: '主线',
        chapters: chapters.map((chapter) => chapter.id),
      },
    ];
  }, [chapters, topology]);

  const selectedRouteCandidate = useMemo(
    () => routeCandidates.find((route) => route.id === selectedParentRouteId) ?? routeCandidates[0],
    [routeCandidates, selectedParentRouteId],
  );

  const attachableChapterIds = useMemo(() => {
    if (!attachGroup || !selectedRouteCandidate) {
      return [] as number[];
    }
    if (typeof selectedForkAfterChapterId !== 'number') {
      return [] as number[];
    }
    return resolveAttachableChapterIds(
      selectedRouteCandidate.chapters,
      attachGroup.chapterIds,
      selectedForkAfterChapterId,
    );
  }, [attachGroup, selectedForkAfterChapterId, selectedRouteCandidate]);

  const forkChapterCandidates = useMemo(() => {
    if (!selectedRouteCandidate) {
      return [] as WorkspaceChapterDescriptor[];
    }
    return selectedRouteCandidate.chapters
      .map((chapterId) => chapterById.get(chapterId))
      .filter((chapter): chapter is WorkspaceChapterDescriptor => Boolean(chapter));
  }, [chapterById, selectedRouteCandidate]);

  useEffect(() => {
    setSelectedChapterIds((previous) =>
      previous.filter((chapterId) => chapterIdSet.has(chapterId)),
    );
  }, [chapterIdSet]);

  useEffect(() => {
    const currentForkAfterChapterId = attachForm.getFieldValue('forkAfterChapterId');
    if (
      typeof currentForkAfterChapterId === 'number' &&
      forkChapterCandidates.some((chapter) => chapter.id === currentForkAfterChapterId)
    ) {
      return;
    }
    attachForm.setFieldValue('forkAfterChapterId', forkChapterCandidates[0]?.id);
  }, [attachForm, forkChapterCandidates]);

  const openAttachGroupModal = (group: ChapterImportGroupDescriptor) => {
    const defaultRoute = selectDefaultAttachRoute(routeCandidates, group.chapterIds);
    const defaultForkAfterChapterId = defaultRoute
      ? selectDefaultForkAfterChapterId(defaultRoute.chapters, group.chapterIds)
      : undefined;
    setAttachGroup(group);
    attachForm.setFieldsValue({
      name: `分支-${group.name === '根目录文件' ? 'root' : group.name}`,
      parentRouteId: defaultRoute?.id ?? 'main',
      forkAfterChapterId: defaultForkAfterChapterId,
    });
  };

  const closeAttachGroupModal = () => {
    setAttachGroup(null);
    attachForm.resetFields();
  };

  const handleAttachGroupAsBranch = async () => {
    if (!attachGroup) {
      return;
    }
    const values = await attachForm.validateFields();
    const parentRoute = routeCandidates.find((route) => route.id === values.parentRouteId);
    const chapterIds = parentRoute
      ? resolveAttachableChapterIds(
          parentRoute.chapters,
          attachGroup.chapterIds,
          values.forkAfterChapterId,
        )
      : [];
    if (chapterIds.length === 0) {
      attachForm.setFields([
        {
          name: 'forkAfterChapterId',
          errors: ['当前父路线与分叉点下没有可挂接章节，请调整后重试'],
        },
      ]);
      return;
    }
    try {
      await onCreateStoryBranch({
        name: values.name.trim() || `分支-${attachGroup.name}`,
        parentRouteId: values.parentRouteId,
        forkAfterChapterId: values.forkAfterChapterId,
        chapterIds,
      });
      closeAttachGroupModal();
    } catch {
      // keep modal open so user can adjust parameters
    }
  };

  const handleSelectGroupChapters = (group: ChapterImportGroupDescriptor) => {
    setSelectedChapterIds(group.chapterIds.filter((chapterId) => chapterIdSet.has(chapterId)));
  };

  const handleBatchClearTranslations = async () => {
    if (selectedChapterIds.length === 0) {
      return;
    }
    await onClearChapterTranslations(selectedChapterIds);
    setSelectedChapterIds([]);
  };

  const handleBatchRemoveChapters = async () => {
    if (selectedChapterIds.length === 0) {
      return;
    }
    await onRemoveChapters(selectedChapterIds, { cascadeBranches: true });
    setSelectedChapterIds([]);
  };

  const openImportArchiveModal = () => {
    setImportArchiveResult(null);
    setImportArchiveFiles([]);
    importArchiveForm.setFieldsValue({
      importFormat: defaultImportFormat ?? '',
      importPattern: DEFAULT_ARCHIVE_IMPORT_PATTERN,
      importTranslation: false,
    });
    setImportArchiveOpen(true);
  };

  const closeImportArchiveModal = () => {
    if (importArchiveSubmitting) {
      return;
    }
    setImportArchiveOpen(false);
    setImportArchiveFiles([]);
    setImportArchiveResult(null);
    importArchiveForm.resetFields();
  };

  const handleImportArchiveSubmit = async () => {
    const file = importArchiveFiles[0]?.originFileObj;
    if (!file) {
      message.error('请先选择 ZIP / 7Z 压缩包');
      return;
    }

    const values = await importArchiveForm.validateFields();
    setImportArchiveSubmitting(true);
    try {
      const result = await onImportChapterArchive({
        file,
        importFormat: values.importFormat,
        importPattern: values.importPattern,
        importTranslation: values.importTranslation,
      });
      setImportArchiveResult(result);
      if (result.addedCount > 0) {
        message.success(
          result.failedCount > 0
            ? `追加完成：新增 ${result.addedCount} 章节，失败 ${result.failedCount} 文件`
            : `追加完成：新增 ${result.addedCount} 章节`,
        );
      } else {
        message.warning(
          result.failedCount > 0
            ? `追加未成功：${result.failedCount} 个文件处理失败`
            : '追加未成功：没有新增章节',
        );
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setImportArchiveSubmitting(false);
    }
  };

  return (
    <>
      <Card size="small" title="导入分组" style={{ marginBottom: 12 }}>
        {chapterGroups.length === 0 ? (
          <Typography.Text type="secondary">当前没有可用的目录分组。</Typography.Text>
        ) : (
          <div className="chapter-import-group-list">
            {chapterGroups.map((group) => (
              <div
                key={group.id}
                className="chapter-import-group-item"
                style={{ paddingLeft: group.depth * 16 }}
              >
                <Space wrap size={[8, 8]}>
                  <Typography.Text strong>{group.name}</Typography.Text>
                  <Typography.Text type="secondary">
                    {group.path === '.' ? '(根目录)' : group.path}
                  </Typography.Text>
                  <Tag>{group.chapterIds.length} 章节</Tag>
                  <Button size="small" onClick={() => handleSelectGroupChapters(group)}>
                    选中章节
                  </Button>
                  <Button
                    size="small"
                    type="dashed"
                    onClick={() => openAttachGroupModal(group)}
                    disabled={group.chapterIds.length === 0}
                  >
                    挂接为分支
                  </Button>
                </Space>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="chapter-batch-toolbar">
        <Space wrap size={[8, 8]}>
          <Button type="primary" size="small" onClick={openImportArchiveModal}>
            追加压缩包
          </Button>
          <Tag color={selectedChapterIds.length > 0 ? 'processing' : undefined}>
            已选 {selectedChapterIds.length} 章节
          </Tag>
          <Button size="small" onClick={() => setSelectedChapterIds([])}>
            清空选择
          </Button>
          <Popconfirm
            title={`确认清空选中的 ${selectedChapterIds.length} 个章节译文？`}
            onConfirm={() => void handleBatchClearTranslations()}
            disabled={selectedChapterIds.length === 0}
          >
            <Button size="small" disabled={selectedChapterIds.length === 0}>
              清空选中译文
            </Button>
          </Popconfirm>
          <Popconfirm
            title={`确认删除选中的 ${selectedChapterIds.length} 个章节？`}
            description="若命中分叉点，将级联删除其对应分支及后代分支章节。"
            onConfirm={() => void handleBatchRemoveChapters()}
            disabled={selectedChapterIds.length === 0}
          >
            <Button size="small" danger disabled={selectedChapterIds.length === 0}>
              删除选中章节
            </Button>
          </Popconfirm>
        </Space>
      </div>

      <Table
        rowKey="id"
        dataSource={chapters}
        pagination={false}
        size="small"
        rowSelection={{
          selectedRowKeys: selectedChapterIds,
          onChange: (selectedRowKeys) => {
            const ids = selectedRowKeys
              .map((key) => Number(key))
              .filter((chapterId) => Number.isFinite(chapterId));
            setSelectedChapterIds(ids);
          },
        }}
        columns={[
          { title: 'ID', dataIndex: 'id', width: 60 },
          { title: '文件路径', dataIndex: 'filePath', width: 260, ellipsis: true },
          {
            title: '路线',
            width: 100,
            render: (_, record: WorkspaceChapterDescriptor) => (
              <Tag
                color={record.routeId === 'main' ? 'blue' : 'purple'}
                style={{ margin: 0 }}
              >
                {record.routeName ?? '主线'}
              </Tag>
            ),
          },
          { title: '片段', dataIndex: 'fragmentCount', width: 60, align: 'right' as const },
          {
            title: '翻译进度',
            width: 160,
            render: (_, record: WorkspaceChapterDescriptor) => {
              const total = record.sourceLineCount;
              const done = record.translatedLineCount;
              const pct = total > 0 ? Math.round((done / total) * 100) : 0;
              const isComplete = done >= total && total > 0;
              return (
                <div className="chapter-info-progress">
                  <div className="chapter-info-bar">
                    <div
                      className={`chapter-info-bar-fill${isComplete ? ' complete' : ''}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>
                    {done}/{total}
                  </span>
                </div>
              );
            },
          },
          {
            title: '拓扑',
            width: 120,
            render: (_, record: WorkspaceChapterDescriptor) => (
              <Space wrap size={[4, 4]}>
                {record.isForkPoint ? (
                  <Tag color="gold" style={{ margin: 0 }}>
                    ⑂ 分叉点
                  </Tag>
                ) : null}
              </Space>
            ),
          },
          {
            title: '操作',
            width: 260,
            render: (_, record: WorkspaceChapterDescriptor) => (
              <Space wrap size={[8, 8]}>
                <Button
                  size="small"
                  type="primary"
                  ghost
                  onClick={() => navigate(`/workspace/editor/${record.id}`)}
                >
                  在线编辑
                </Button>
                <Popconfirm
                  title="确认清空该章节的译文？"
                  onConfirm={() => void onClearChapterTranslations([record.id])}
                >
                  <Button size="small">清空译文</Button>
                </Popconfirm>
                <Popconfirm
                  title="确认移除该章节？"
                  onConfirm={() =>
                    void onRemoveChapters([record.id], { cascadeBranches: false })
                  }
                >
                  <Button size="small" danger>
                    移除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title="追加压缩包为新章节"
        open={importArchiveOpen}
        okText="开始追加"
        cancelText="关闭"
        confirmLoading={importArchiveSubmitting}
        onCancel={closeImportArchiveModal}
        onOk={() => void handleImportArchiveSubmit()}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Form
            form={importArchiveForm}
            layout="vertical"
            initialValues={{
              importFormat: defaultImportFormat ?? '',
              importPattern: DEFAULT_ARCHIVE_IMPORT_PATTERN,
              importTranslation: false,
            }}
          >
            <Form.Item
              label="压缩包文件"
              required
              help={
                importArchiveFiles[0]
                  ? `当前文件：${importArchiveFiles[0].name}`
                  : '请选择一个 ZIP / 7Z 压缩包'
              }
            >
              <Upload.Dragger
                accept=".zip,.7z"
                beforeUpload={() => false}
                maxCount={1}
                disabled={importArchiveSubmitting}
                fileList={importArchiveFiles}
                onChange={({ fileList }) => setImportArchiveFiles(fileList.slice(-1))}
              >
                <p>拖入或点击上传 ZIP / 7Z</p>
              </Upload.Dragger>
            </Form.Item>
            <Form.Item label="导入格式" name="importFormat">
              <Select options={IMPORT_FORMAT_OPTIONS} />
            </Form.Item>
            <Form.Item
              label="压缩包内 Pattern"
              name="importPattern"
              rules={[{ required: true, message: '请输入压缩包内 Pattern' }]}
            >
              <Input placeholder={DEFAULT_ARCHIVE_IMPORT_PATTERN} />
            </Form.Item>
            <Form.Item
              label="导入译文"
              name="importTranslation"
              valuePropName="checked"
              extra="开启后会尽量导入文件内已有译文；关闭则只导入原文。"
            >
              <Switch />
            </Form.Item>
          </Form>

          {importArchiveResult ? (
            <Alert
              type={importArchiveResult.ok ? 'success' : 'warning'}
              showIcon
              message={`新增 ${importArchiveResult.addedCount} 章节，失败 ${importArchiveResult.failedCount} 文件`}
              description={
                importArchiveResult.failedFiles.length > 0
                  ? (
                    <div style={{ whiteSpace: 'pre-wrap' }}>
                      {importArchiveResult.failedFiles
                        .map((entry) => `${entry.filePath}: ${entry.error}`)
                        .join('\n')}
                    </div>
                  )
                  : '全部文件处理成功'
              }
            />
          ) : null}
        </Space>
      </Modal>

      <Modal
        title="挂接分组为分支"
        open={attachGroup !== null}
        okText="创建分支"
        cancelText="取消"
        okButtonProps={{ disabled: attachGroup !== null && attachableChapterIds.length === 0 }}
        onCancel={closeAttachGroupModal}
        onOk={handleAttachGroupAsBranch}
      >
        {attachGroup ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Typography.Text type="secondary">
              {`分组路径：${attachGroup.path === '.' ? '(根目录)' : attachGroup.path}`}
            </Typography.Text>
            <Typography.Text type="secondary">
              {`包含章节：${attachGroup.chapterIds.map((chapterId) => `#${chapterId}`).join(', ')}`}
            </Typography.Text>
            <Typography.Text type="secondary">
              {`当前可挂接章节：${
                attachableChapterIds.length > 0
                  ? attachableChapterIds.map((chapterId) => `#${chapterId}`).join(', ')
                  : '无'
              }`}
            </Typography.Text>
            <Form form={attachForm} layout="vertical">
              <Form.Item
                label="分支名称"
                name="name"
                rules={[{ required: true, message: '请输入分支名称' }]}
              >
                <Input placeholder="分支名称" />
              </Form.Item>
              <Form.Item
                label="父路线"
                name="parentRouteId"
                rules={[{ required: true, message: '请选择父路线' }]}
              >
                <Select
                  options={routeCandidates.map((route) => ({
                    label: `${route.name} (${route.id})`,
                    value: route.id,
                  }))}
                />
              </Form.Item>
              <Form.Item
                label="分叉章节"
                name="forkAfterChapterId"
                rules={[{ required: true, message: '请选择分叉章节' }]}
              >
                <Select
                  options={forkChapterCandidates.map((chapter) => ({
                    label: formatChapterLabel(chapter),
                    value: chapter.id,
                  }))}
                  disabled={forkChapterCandidates.length === 0}
                  placeholder={
                    forkChapterCandidates.length === 0
                      ? '所选父路线没有可用章节'
                      : '选择分叉章节'
                  }
                />
              </Form.Item>
            </Form>
          </Space>
        ) : null}
      </Modal>
    </>
  );
}
