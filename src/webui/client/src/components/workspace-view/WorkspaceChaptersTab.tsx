import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Dropdown,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { MenuProps, UploadFile } from 'antd';
import { DownloadOutlined, MoreOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import type {
  CreateStoryBranchPayload,
  ImportArchiveResult,
  ProofreaderEntry,
  StoryTopologyDescriptor,
  UpdateStoryRoutePayload,
  WorkspaceChapterDescriptor,
} from '../../app/types.ts';
import {
  DEFAULT_ARCHIVE_IMPORT_PATTERN,
  IMPORT_FORMAT_OPTIONS,
} from '../../app/ui-helpers.ts';
import { usePollingTask } from '../../app/usePollingTask.ts';
import { FormatParamFields, useFormatParams } from './FormatParamFields.tsx';
import { TranslationPreviewModal } from '../TranslationPreviewModal.tsx';
import { ChapterKanbanBoard } from '../topology/ChapterKanbanBoard.tsx';
import { ChapterFindReplaceModal } from './ChapterFindReplaceModal.tsx';
import { PostProcessModal } from './PostProcessModal.tsx';
import { formatChapterLabel } from './utils.ts';

interface WorkspaceChaptersTabProps {
  active: boolean;
  mobileMode?: boolean;
  chapters: WorkspaceChapterDescriptor[];
  topology: StoryTopologyDescriptor | null;
  defaultImportFormat?: string;
  proofreaders: Record<string, ProofreaderEntry>;
  defaultProofreaderName?: string;
  onRefreshChapters: () => void | Promise<void>;
  onClearChapterTranslations: (chapterIds: number[]) => void | Promise<void>;
  onStartProofread: (input: {
    chapterIds: number[];
    mode?: 'linear' | 'simultaneous';
    proofreaderName?: string;
  }) => void | Promise<void>;
  onRemoveChapters: (
    chapterIds: number[],
    options?: { cascadeBranches?: boolean },
  ) => void | Promise<void>;
  onCreateStoryBranch: (payload: CreateStoryBranchPayload) => void | Promise<void>;
  onUpdateStoryRoute: (
    routeId: string,
    payload: UpdateStoryRoutePayload,
  ) => void | Promise<void>;
  onRemoveStoryRoute: (routeId: string) => void | Promise<void>;
  onImportChapterArchive: (payload: {
    file: File;
    importFormat?: string;
    importPattern?: string;
    importTranslation?: boolean;
    importParams?: Record<string, unknown>;
  }) => Promise<ImportArchiveResult>;
  onDownloadChapters: (chapterIds: number[], format: string, params?: Record<string, unknown>) => void | Promise<void>;
  onBatchSaveTopology: (routes: { id: string; chapters: number[] }[]) => void | Promise<void>;
}

type RouteAttachCandidate = {
  id: string;
  name: string;
  chapters: number[];
};

type AttachBranchFormValues = {
  name: string;
  parentRouteId: string;
  forkAfterChapterId: number;
};

type AttachBranchCandidate = {
  chapterIds: number[];
};

type ImportArchiveFormValues = {
  importFormat?: string;
  importPattern?: string;
  importTranslation?: boolean;
};

type ImportArchiveParams = Record<string, unknown>;

export function WorkspaceChaptersTab({
  active,
  mobileMode = false,
  chapters,
  topology,
  defaultImportFormat,
  proofreaders,
  defaultProofreaderName,
  onRefreshChapters,
  onClearChapterTranslations,
  onStartProofread,
  onRemoveChapters,
  onCreateStoryBranch,
  onUpdateStoryRoute,
  onRemoveStoryRoute,
  onImportChapterArchive,
  onDownloadChapters,
  onBatchSaveTopology,
}: WorkspaceChaptersTabProps) {
  const [activeTabKey, setActiveTabKey] = useState(mobileMode ? 'list' : 'list');

  useEffect(() => {
    if (mobileMode && activeTabKey !== 'list') {
      setActiveTabKey('list');
    }
  }, [activeTabKey, mobileMode]);

  usePollingTask({
    enabled: active,
    intervalMs: 5_000,
    runImmediately: false,
    task: async () => {
      await onRefreshChapters();
    },
  });

  const routeCount = topology?.routes.length ?? 0;
  const branchCount = routeCount > 1 ? routeCount - 1 : 0;

  return (
    <Card
      title={mobileMode ? '章节预览' : '章节管理'}
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
      styles={{ body: mobileMode ? {} : { display: 'flex', flexDirection: 'column', overflow: 'hidden', flex: 1, minHeight: 0 } }}
      extra={
        <Space size={8}>
          {!mobileMode ? (
            <Tabs
              size="small"
              activeKey={activeTabKey}
              onChange={setActiveTabKey}
              style={{ marginBottom: -14 }}
              items={[
                {
                  key: 'arrange',
                  label: '编排',
                },
                {
                  key: 'list',
                  label: '列表',
                },
              ]}
            />
          ) : null}
          {!mobileMode && branchCount > 0 ? (
            <Tag color="processing">{branchCount} 个分支路线</Tag>
          ) : null}
          <Tag>{chapters.length} 章节</Tag>
        </Space>
      }
    >
      {!mobileMode && activeTabKey === 'arrange' ? (
        <ChapterKanbanBoard
          topology={topology}
          chapters={chapters}
          onCreateBranch={onCreateStoryBranch}
          onClearChapterTranslations={onClearChapterTranslations}
          onRemoveChapters={onRemoveChapters}
          onRemoveRoute={onRemoveStoryRoute}
          onUpdateRoute={onUpdateStoryRoute}
          onDownloadChapters={onDownloadChapters}
          onBatchSaveTopology={onBatchSaveTopology}
        />
      ) : (
        <ChapterInfoTable
          mobileMode={mobileMode}
          chapters={chapters}
          topology={topology}
          defaultImportFormat={defaultImportFormat}
          proofreaders={proofreaders}
          defaultProofreaderName={defaultProofreaderName}
          onClearChapterTranslations={onClearChapterTranslations}
          onStartProofread={onStartProofread}
          onRemoveChapters={onRemoveChapters}
          onCreateStoryBranch={onCreateStoryBranch}
          onImportChapterArchive={onImportChapterArchive}
          onDownloadChapters={onDownloadChapters}
          onRefreshChapters={onRefreshChapters}
        />
      )}
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

function resolveChapterSelectionRange(
  chapters: WorkspaceChapterDescriptor[],
  startChapterId: number,
  endChapterId: number,
): number[] {
  const startIndex = chapters.findIndex((chapter) => chapter.id === startChapterId);
  const endIndex = chapters.findIndex((chapter) => chapter.id === endChapterId);
  if (startIndex === -1 || endIndex === -1) {
    return [];
  }

  const [fromIndex, toIndex] = startIndex < endIndex
    ? [startIndex, endIndex]
    : [endIndex, startIndex];
  return chapters.slice(fromIndex, toIndex + 1).map((chapter) => chapter.id);
}

function isInteractiveSelectionTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(
    target.closest(
      'button, a, input, textarea, select, label, [role="button"], .ant-btn, .ant-btn-icon-only, .ant-dropdown-trigger, .ant-checkbox-wrapper, .ant-checkbox-input',
    ),
  );
}

const ChapterTableSection = memo(function ChapterTableSection({
  chapters,
  selectedChapterIds,
  setSelectedChapterIds,
  lastSelectedChapterId,
  setLastSelectedChapterId,
  setPreviewChapterId,
  setPreviewOpen,
  onClearChapterTranslations,
  onRemoveChapters,
  onDownloadChapters,
  params,
}: {
  chapters: WorkspaceChapterDescriptor[];
  selectedChapterIds: number[];
  setSelectedChapterIds: React.Dispatch<React.SetStateAction<number[]>>;
  lastSelectedChapterId?: number;
  setLastSelectedChapterId: React.Dispatch<React.SetStateAction<number | undefined>>;
  setPreviewChapterId: React.Dispatch<React.SetStateAction<number | undefined>>;
  setPreviewOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onClearChapterTranslations: (chapterIds: number[]) => void | Promise<void>;
  onRemoveChapters: (
    chapterIds: number[],
    options?: { cascadeBranches?: boolean },
  ) => void | Promise<void>;
  onDownloadChapters: (chapterIds: number[], format: string, params?: Record<string, unknown>) => void | Promise<void>;
  params?: Record<string, unknown>;
}) {
  const navigate = useNavigate();

  return (
    <Table
      rowKey="id"
      dataSource={chapters}
      pagination={false}
      size="small"
      scroll={{ x: 1100 }}
      rowSelection={{
        selectedRowKeys: selectedChapterIds,
        onSelect: (record) => {
          setLastSelectedChapterId(record.id);
        },
        onChange: (selectedRowKeys) => {
          const ids = selectedRowKeys
            .map((key) => Number(key))
            .filter((chapterId) => Number.isFinite(chapterId));
          setSelectedChapterIds(ids);
        },
      }}
      onRow={(record) => ({
        onClick: (event) => {
          if (isInteractiveSelectionTarget(event.target)) {
            return;
          }

          if (event.shiftKey && typeof lastSelectedChapterId === 'number') {
            const rangeIds = resolveChapterSelectionRange(
              chapters,
              lastSelectedChapterId,
              record.id,
            );
            if (rangeIds.length > 0) {
              setSelectedChapterIds((previous) =>
                Array.from(new Set([...previous, ...rangeIds])),
              );
              setLastSelectedChapterId(record.id);
              return;
            }
          }

          setSelectedChapterIds((previous) => {
            if (previous.includes(record.id)) {
              return previous.filter((chapterId) => chapterId !== record.id);
            }
            return [...previous, record.id];
          });
          setLastSelectedChapterId(record.id);
        },
      })}
      columns={[
        { title: 'ID', dataIndex: 'id', width: 60 },
        {
          title: '章节名',
          width: 280,
          render: (_, record: WorkspaceChapterDescriptor) => (
            <div>
              <Typography.Text strong ellipsis={{ tooltip: record.displayName }}>
                {record.displayName}
              </Typography.Text>
              <br />
              <Typography.Text
                type="secondary"
                style={{ fontSize: 12 }}
                ellipsis={{ tooltip: record.filePath }}
              >
                {record.filePath}
              </Typography.Text>
            </div>
          ),
        },
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
          width: 320,
          render: (_, record: WorkspaceChapterDescriptor) => (
            <Space wrap size={[8, 8]}>
              <Button
                size="small"
                onClick={() => {
                  setPreviewChapterId(record.id);
                  setPreviewOpen(true);
                }}
              >
                预览
              </Button>
              <Button
                size="small"
                type="primary"
                ghost
                onClick={() => navigate(`/workspace/editor/${record.id}`)}
              >
                在线编辑
              </Button>
              <Dropdown
                menu={{
                  items: [
                    {
                      key: 'download',
                      icon: <DownloadOutlined />,
                      label: '下载章节',
                      children: [
                        { key: 'download-plain_text', label: '纯文本', onClick: () => onDownloadChapters([record.id], 'plain_text', params) },
                        { key: 'download-naturedialog', label: 'Nature Dialog', onClick: () => onDownloadChapters([record.id], 'naturedialog', params) },
                        { key: 'download-m3t', label: 'M3T', onClick: () => onDownloadChapters([record.id], 'm3t', params) },
                        { key: 'download-galtransl_json', label: 'GalTransl JSON', onClick: () => onDownloadChapters([record.id], 'galtransl_json', params) },
                        { key: 'download-dbl_tp1', label: 'DBL TP1', onClick: () => onDownloadChapters([record.id], 'dbl_tp1', params) },
                        { key: 'download-nd_with_meta', label: 'ND With Meta', onClick: () => onDownloadChapters([record.id], 'nd_with_meta', params) },
                        { key: 'download-dbl_tp2', label: 'DBL TP2', onClick: () => onDownloadChapters([record.id], 'dbl_tp2', params) },
                      ],
                    },
                    { type: 'divider' as const },
                    {
                      key: 'clear',
                      label: '清空译文',
                      onClick: () => {
                        Modal.confirm({
                          title: '确认清空该章节的译文？',
                          okText: '清空',
                          cancelText: '取消',
                          onOk: () => onClearChapterTranslations([record.id]),
                        });
                      },
                    },
                    {
                      key: 'remove',
                      label: <span style={{ color: '#ff7875' }}>移除</span>,
                      onClick: () => {
                        Modal.confirm({
                          title: '确认移除该章节？',
                          okText: '移除',
                          cancelText: '取消',
                          okButtonProps: { danger: true },
                          onOk: () => onRemoveChapters([record.id], { cascadeBranches: false }),
                        });
                      },
                    },
                  ],
                }}
                trigger={['click']}
              >
                <Button size="small" icon={<MoreOutlined />} />
              </Dropdown>
            </Space>
          ),
        },
      ]}
    />
  );
});

function ChapterInfoTable({
  mobileMode,
  chapters,
  topology,
  defaultImportFormat,
  proofreaders,
  defaultProofreaderName,
  onClearChapterTranslations,
  onStartProofread,
  onRemoveChapters,
  onCreateStoryBranch,
  onImportChapterArchive,
  onDownloadChapters,
  onRefreshChapters,
}: {
  mobileMode?: boolean;
  chapters: WorkspaceChapterDescriptor[];
  topology: StoryTopologyDescriptor | null;
  defaultImportFormat?: string;
  proofreaders: Record<string, ProofreaderEntry>;
  defaultProofreaderName?: string;
  onClearChapterTranslations: (chapterIds: number[]) => void | Promise<void>;
  onStartProofread: (input: {
    chapterIds: number[];
    mode?: 'linear' | 'simultaneous';
    proofreaderName?: string;
  }) => void | Promise<void>;
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
    importParams?: Record<string, unknown>;
  }) => Promise<ImportArchiveResult>;
  onDownloadChapters: (chapterIds: number[], format: string, params?: Record<string, unknown>) => void | Promise<void>;
  onRefreshChapters: () => void | Promise<void>;
}) {
  const { message } = AntdApp.useApp();
  const toolbarActionsRef = useRef<HTMLDivElement | null>(null);
  const [exportParams, setExportParams] = useState<Record<string, unknown>>({});
  const [selectedChapterIds, setSelectedChapterIds] = useState<number[]>([]);
  const [lastSelectedChapterId, setLastSelectedChapterId] = useState<number>();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewChapterId, setPreviewChapterId] = useState<number>();
  const [attachBranch, setAttachBranch] = useState<AttachBranchCandidate | null>(null);
  const [attachForm] = Form.useForm<AttachBranchFormValues>();
  const [importArchiveOpen, setImportArchiveOpen] = useState(false);
  const [importArchiveSubmitting, setImportArchiveSubmitting] = useState(false);
  const [proofreadModalOpen, setProofreadModalOpen] = useState(false);
  const [proofreadMode, setProofreadMode] = useState<'linear' | 'simultaneous'>('linear');
  const [proofreaderName, setProofreaderName] = useState<string | undefined>(defaultProofreaderName);
  const [batchDownloadModalOpen, setBatchDownloadModalOpen] = useState(false);
  const [batchDownloadFormat, setBatchDownloadFormat] = useState('plain_text');
  const [importArchiveFiles, setImportArchiveFiles] = useState<UploadFile[]>([]);
  const [importArchiveResult, setImportArchiveResult] = useState<ImportArchiveResult | null>(null);
  const [importArchiveForm] = Form.useForm<ImportArchiveFormValues>();
  const [importArchiveParams, setImportArchiveParams] = useState<ImportArchiveParams>({});
  const archiveImportFormat = Form.useWatch('importFormat', importArchiveForm);
  const { paramDefs: archiveParamDefs } = useFormatParams(archiveImportFormat ?? '', 'import');
  const [postProcessModalOpen, setPostProcessModalOpen] = useState(false);
  const [findReplaceModalOpen, setFindReplaceModalOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searchMode, setSearchMode] = useState<'keyword' | 'regex'>('keyword');
  const [toolbarActionWidth, setToolbarActionWidth] = useState<number>();
  const deferredSearchText = useDeferredValue(searchText);
  const deferredSearchMode = useDeferredValue(searchMode);
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
  const proofreadableChapterIds = useMemo(
    () =>
      selectedChapterIds.filter((chapterId) => {
        const chapter = chapterById.get(chapterId);
        return Boolean(
          chapter &&
            (chapter.sourceLineCount === 0 || chapter.translatedLineCount >= chapter.sourceLineCount),
        );
      }),
    [chapterById, selectedChapterIds],
  );
  const unproofreadableChapterIds = useMemo(
    () => selectedChapterIds.filter((chapterId) => !proofreadableChapterIds.includes(chapterId)),
    [proofreadableChapterIds, selectedChapterIds],
  );
  const proofreaderOptions = useMemo(
    () =>
      Object.entries(proofreaders).map(([name, proofreader]) => ({
        value: name,
        label: proofreader.metadata?.title ?? name,
      })),
    [proofreaders],
  );

  useEffect(() => {
    if (proofreaderName && proofreaders[proofreaderName]) {
      return;
    }
    if (defaultProofreaderName && proofreaders[defaultProofreaderName]) {
      setProofreaderName(defaultProofreaderName);
      return;
    }
    setProofreaderName(Object.keys(proofreaders)[0]);
  }, [defaultProofreaderName, proofreaderName, proofreaders]);
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
    if (!attachBranch || !selectedRouteCandidate) {
      return [] as number[];
    }
    if (typeof selectedForkAfterChapterId !== 'number') {
      return [] as number[];
    }
    return resolveAttachableChapterIds(
      selectedRouteCandidate.chapters,
      attachBranch.chapterIds,
      selectedForkAfterChapterId,
    );
  }, [attachBranch, selectedForkAfterChapterId, selectedRouteCandidate]);

  const forkChapterCandidates = useMemo(() => {
    if (!selectedRouteCandidate) {
      return [] as WorkspaceChapterDescriptor[];
    }
    return selectedRouteCandidate.chapters
      .map((chapterId) => chapterById.get(chapterId))
      .filter((chapter): chapter is WorkspaceChapterDescriptor => Boolean(chapter));
  }, [chapterById, selectedRouteCandidate]);

  const filteredChapters = useMemo(() => {
    if (!deferredSearchText.trim()) return chapters;
    if (deferredSearchMode === 'regex') {
      try {
        const regex = new RegExp(deferredSearchText, 'i');
        return chapters.filter((ch) => regex.test(ch.filePath) || regex.test(ch.displayName));
      } catch {
        return chapters;
      }
    }
    const terms = deferredSearchText.trim().split(/\s+/);
    return chapters.filter((ch) =>
      terms.some((term) => {
        const normalizedTerm = term.toLowerCase();
        return (
          ch.filePath.toLowerCase().includes(normalizedTerm) ||
          ch.displayName.toLowerCase().includes(normalizedTerm)
        );
      }),
    );
  }, [chapters, deferredSearchMode, deferredSearchText]);

  const searchRefreshPending =
    searchText !== deferredSearchText || searchMode !== deferredSearchMode;

  useEffect(() => {
    setSelectedChapterIds((previous) =>
      previous.filter((chapterId) => chapterIdSet.has(chapterId)),
    );
  }, [chapterIdSet]);

  useEffect(() => {
    if (typeof lastSelectedChapterId === 'number' && chapterIdSet.has(lastSelectedChapterId)) {
      return;
    }
    setLastSelectedChapterId(undefined);
  }, [chapterIdSet, lastSelectedChapterId]);

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

  useEffect(() => {
    const target = toolbarActionsRef.current;
    if (!target) {
      return;
    }

    const updateWidth = () => {
      setToolbarActionWidth(target.clientWidth);
    };

    updateWidth();
    const observer = new ResizeObserver(() => updateWidth());
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  const handleOpenAttachBranchModal = () => {
    if (selectedChapterIds.length === 0) {
      return;
    }
    const defaultRoute = selectDefaultAttachRoute(routeCandidates, selectedChapterIds);
    setAttachBranch({ chapterIds: [...selectedChapterIds] });
    attachForm.setFieldsValue({
      name: `分支-${routeCandidates.find((r) => r.id === defaultRoute?.id)?.name ?? 'main'}`,
      parentRouteId: defaultRoute?.id ?? 'main',
      forkAfterChapterId: undefined,
    });
  };

  const closeAttachBranchModal = () => {
    setAttachBranch(null);
    attachForm.resetFields();
  };

  const handleAttachBranchAsBranch = async () => {
    if (!attachBranch) {
      return;
    }
    const values = await attachForm.validateFields();
    const parentRoute = routeCandidates.find((route) => route.id === values.parentRouteId);
    const chapterIds = parentRoute
      ? resolveAttachableChapterIds(
          parentRoute.chapters,
          attachBranch.chapterIds,
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
        name: values.name.trim() || `分支-${values.parentRouteId}`,
        parentRouteId: values.parentRouteId,
        forkAfterChapterId: values.forkAfterChapterId,
        chapterIds,
      });
      closeAttachBranchModal();
    } catch {
      // keep modal open so user can adjust parameters
    }
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

  const handleOpenProofreadModal = () => {
    if (selectedChapterIds.length === 0) {
      message.warning('请先选择章节');
      return;
    }
    if (proofreadableChapterIds.length === 0) {
      message.error('所选章节尚未翻译完成，无法创建校对任务');
      return;
    }
    if (proofreaderOptions.length === 0) {
      message.error('当前没有可用的校对器预设，请先在设置中创建校对器');
      return;
    }
    setProofreadModalOpen(true);
  };

  const handleStartProofread = async () => {
    if (proofreadableChapterIds.length === 0) {
      message.error('没有可用于校对的章节');
      return;
    }
    if (!proofreaderName) {
      message.error('请选择校对预设');
      return;
    }

    await onStartProofread({
      chapterIds: proofreadableChapterIds,
      mode: proofreadMode,
      proofreaderName,
    });
    setProofreadModalOpen(false);
  };

  const handleBatchDownload = () => {
    if (selectedChapterIds.length === 0) {
      message.warning('请先选择章节');
      return;
    }
    setBatchDownloadFormat('plain_text');
    setBatchDownloadModalOpen(true);
  };

  const handleBatchPostProcess = () => {
    if (selectedChapterIds.length === 0) {
      message.warning('请先选择章节');
      return;
    }
    setPostProcessModalOpen(true);
  };

  const handleOpenFindReplaceModal = () => {
    if (selectedChapterIds.length === 0) {
      message.warning('请先选择章节');
      return;
    }
    setFindReplaceModalOpen(true);
  };

  const handleConfirmBatchDownload = () => {
    void onDownloadChapters(selectedChapterIds, batchDownloadFormat, exportParams);
    setBatchDownloadModalOpen(false);
  };

  const openPreview = (chapterId: number) => {
    setPreviewChapterId(chapterId);
    setPreviewOpen(true);
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
        importParams: importArchiveParams,
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

  const toolbarActions = useMemo(
    () => [
      {
        key: 'find-replace',
        label: '查找替换',
        render: () => (
          <Button size="small" onClick={handleOpenFindReplaceModal}>
            查找替换
          </Button>
        ),
        onMenuClick: handleOpenFindReplaceModal,
      },
      {
        key: 'proofread',
        label: '创建校对任务',
        render: () => (
          <Button size="small" type="primary" onClick={handleOpenProofreadModal}>
            创建校对任务
          </Button>
        ),
        onMenuClick: handleOpenProofreadModal,
      },
      {
        key: 'download',
        label: '下载选中章节',
        render: () => (
          <Button size="small" icon={<DownloadOutlined />} onClick={handleBatchDownload}>
            下载选中章节
          </Button>
        ),
        onMenuClick: handleBatchDownload,
      },
      {
        key: 'post-process',
        label: '文本后处理',
        render: () => (
          <Button size="small" onClick={handleBatchPostProcess}>
            文本后处理
          </Button>
        ),
        onMenuClick: handleBatchPostProcess,
      },
      {
        key: 'clear-selection',
        label: '清空选择',
        render: () => (
          <Button size="small" onClick={() => setSelectedChapterIds([])}>
            清空选择
          </Button>
        ),
        onMenuClick: () => setSelectedChapterIds([]),
      },
      {
        key: 'clear-translations',
        label: '清空选中译文',
        render: () => (
          <Button
            size="small"
            disabled={selectedChapterIds.length === 0}
            onClick={() => {
              Modal.confirm({
                title: `确认清空选中的 ${selectedChapterIds.length} 个章节译文？`,
                okText: '清空',
                cancelText: '取消',
                onOk: () => void handleBatchClearTranslations(),
              });
            }}
          >
            清空选中译文
          </Button>
        ),
        onMenuClick: () => {
          if (selectedChapterIds.length === 0) {
            return;
          }
          Modal.confirm({
            title: `确认清空选中的 ${selectedChapterIds.length} 个章节译文？`,
            okText: '清空',
            cancelText: '取消',
            onOk: () => void handleBatchClearTranslations(),
          });
        },
      },
      {
        key: 'delete',
        label: '删除选中章节',
        render: () => (
          <Button
            size="small"
            danger
            disabled={selectedChapterIds.length === 0}
            onClick={() => {
              Modal.confirm({
                title: `确认删除选中的 ${selectedChapterIds.length} 个章节？`,
                content: '若命中分叉点，将级联删除其对应分支及后代分支章节。',
                okText: '删除',
                cancelText: '取消',
                okButtonProps: { danger: true },
                onOk: () => void handleBatchRemoveChapters(),
              });
            }}
          >
            删除选中章节
          </Button>
        ),
        onMenuClick: () => {
          if (selectedChapterIds.length === 0) {
            return;
          }
          Modal.confirm({
            title: `确认删除选中的 ${selectedChapterIds.length} 个章节？`,
            content: '若命中分叉点，将级联删除其对应分支及后代分支章节。',
            okText: '删除',
            cancelText: '取消',
            okButtonProps: { danger: true },
            onOk: () => void handleBatchRemoveChapters(),
          });
        },
      },
      {
        key: 'import-archive',
        label: '追加压缩包',
        render: () => (
          <Button type="primary" size="small" onClick={openImportArchiveModal}>
            追加压缩包
          </Button>
        ),
        onMenuClick: openImportArchiveModal,
      },
      {
        key: 'attach-branch',
        label: '挂接为分支',
        render: () => (
          <Button
            size="small"
            type="dashed"
            disabled={selectedChapterIds.length === 0}
            onClick={handleOpenAttachBranchModal}
          >
            挂接为分支
          </Button>
        ),
        onMenuClick: handleOpenAttachBranchModal,
      },
    ],
    [
      handleBatchClearTranslations,
      handleBatchDownload,
      handleBatchPostProcess,
      handleBatchRemoveChapters,
      handleOpenProofreadModal,
      handleOpenAttachBranchModal,
      openImportArchiveModal,
      selectedChapterIds.length,
    ],
  );

  const visibleActionCount = useMemo(() => {
    if (typeof toolbarActionWidth !== 'number') {
      return toolbarActions.length;
    }
    if (toolbarActionWidth >= 1180) {
      return toolbarActions.length;
    }
    if (toolbarActionWidth >= 980) {
      return 7;
    }
    if (toolbarActionWidth >= 760) {
      return 5;
    }
    if (toolbarActionWidth >= 540) {
      return 3;
    }
    return 1;
  }, [toolbarActionWidth, toolbarActions.length]);

  const visibleToolbarActions = toolbarActions.slice(0, visibleActionCount);
  const overflowToolbarActions = toolbarActions.slice(visibleActionCount);
  const overflowMenuItems = useMemo<MenuProps['items']>(
    () =>
      overflowToolbarActions.map((action) => ({
        key: action.key,
        label:
          action.key === 'delete'
            ? <span style={{ color: '#ff7875' }}>{action.label}</span>
            : action.label,
      })),
    [overflowToolbarActions],
  );

  if (mobileMode) {
    return (
      <>
        {chapters.length === 0 ? (
          <Alert showIcon type="info" message="当前工作区还没有章节" />
        ) : (
          <div className="section-stack">
            {chapters.map((chapter) => {
              const total = chapter.sourceLineCount;
              const done = chapter.translatedLineCount;
              const pct = total > 0 ? Math.round((done / total) * 100) : 0;
              return (
                <Card
                  key={chapter.id}
                  size="small"
                  title={`Ch${chapter.id} · ${chapter.displayName}`}
                  extra={
                    <Tag color={pct >= 100 && total > 0 ? 'success' : 'processing'}>{pct}%</Tag>
                  }
                >
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <div>
                      <Typography.Text strong>{chapter.displayName}</Typography.Text>
                      <br />
                      <Typography.Text type="secondary">{chapter.filePath}</Typography.Text>
                    </div>
                    <Space wrap size={[8, 8]}>
                      <Tag color={chapter.routeId === 'main' ? 'blue' : 'purple'}>
                        {chapter.routeName ?? '主线'}
                      </Tag>
                      <Tag>{`${done}/${total} 行`}</Tag>
                      <Tag>{`${chapter.fragmentCount} 片段`}</Tag>
                      {chapter.isForkPoint ? <Tag color="gold">分叉点</Tag> : null}
                    </Space>
                    <div className="chapter-info-progress">
                      <div className="chapter-info-bar">
                        <div
                          className={`chapter-info-bar-fill${pct >= 100 && total > 0 ? ' complete' : ''}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                    <Button type="primary" onClick={() => openPreview(chapter.id)}>
                      预览章节
                    </Button>
                  </Space>
                </Card>
              );
            })}
          </div>
        )}

        <TranslationPreviewModal
          open={previewOpen}
          chapters={chapters}
          defaultChapterId={previewChapterId}
          onCancel={() => setPreviewOpen(false)}
        />
      </>
    );
  }

  return (
    <>
      <div className="chapter-batch-toolbar">
        <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Input.Search
            placeholder="搜索章节 (空格分隔表示「或」)"
            allowClear
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            style={{ maxWidth: 360 }}
          />
          <Button
            size="small"
            title={searchMode === 'keyword' ? '当前：关键词模式，空格分隔表示「或」' : '当前：正则模式'}
            type={searchMode === 'regex' ? 'primary' : 'default'}
            onClick={() => setSearchMode((prev) => (prev === 'keyword' ? 'regex' : 'keyword'))}
          >
            {searchMode === 'keyword' ? '关键词' : 'Regex'}
          </Button>
        </div>
        <div className="chapter-batch-toolbar-row">
          <Space wrap size={[8, 8]}>
            <Typography.Text type="secondary">Shift + 点击可区间选中</Typography.Text>
            {searchRefreshPending ? <Tag color="processing">筛选更新中</Tag> : null}
            <Tag color={selectedChapterIds.length > 0 ? 'processing' : undefined}>
              已选 {selectedChapterIds.length} 章节
            </Tag>
            <Checkbox
              checked={Boolean(exportParams.keepSourceName)}
              onChange={(e) => setExportParams({ ...exportParams, keepSourceName: e.target.checked })}
            >
              保持名称
            </Checkbox>
          </Space>
          <div ref={toolbarActionsRef} className="chapter-batch-toolbar-actions">
            {visibleToolbarActions.map((action) => (
              <span key={action.key}>{action.render()}</span>
            ))}
            {overflowToolbarActions.length > 0 ? (
              <Dropdown
                trigger={['click']}
                menu={{
                  items: overflowMenuItems,
                  onClick: ({ key }) => {
                    const action = overflowToolbarActions.find((item) => item.key === key);
                    action?.onMenuClick();
                  },
                }}
              >
                <Button size="small" icon={<MoreOutlined />}>
                  更多
                </Button>
              </Dropdown>
            ) : null}
          </div>
        </div>
      </div>

      <div className="chapters-scroll-body" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <ChapterTableSection
          chapters={filteredChapters}
          selectedChapterIds={selectedChapterIds}
          setSelectedChapterIds={setSelectedChapterIds}
          lastSelectedChapterId={lastSelectedChapterId}
          setLastSelectedChapterId={setLastSelectedChapterId}
          setPreviewChapterId={setPreviewChapterId}
          setPreviewOpen={setPreviewOpen}
          onClearChapterTranslations={onClearChapterTranslations}
          onRemoveChapters={onRemoveChapters}
          onDownloadChapters={onDownloadChapters}
          params={exportParams}
        />
      </div>

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
            {archiveParamDefs.length > 0 ? (
              <Form.Item label="格式参数">
                <FormatParamFields
                  paramDefs={archiveParamDefs}
                  values={importArchiveParams}
                  onChange={(key, value) =>
                    setImportArchiveParams((prev) => ({ ...prev, [key]: value }))
                  }
                />
              </Form.Item>
            ) : null}
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
        title="挂接为分支"
        open={attachBranch !== null}
        okText="创建分支"
        cancelText="取消"
        okButtonProps={{ disabled: attachBranch !== null && attachableChapterIds.length === 0 }}
        onCancel={closeAttachBranchModal}
        onOk={handleAttachBranchAsBranch}
      >
        {attachBranch ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Typography.Text type="secondary">
              {`选中章节：${attachBranch.chapterIds.map((chapterId) => `#${chapterId}`).join(', ')}`}
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

      <PostProcessModal
        open={postProcessModalOpen}
        chapterIds={selectedChapterIds}
        onCancel={() => setPostProcessModalOpen(false)}
        onSuccess={() => {
          setPostProcessModalOpen(false);
          (() => {})(); 
        }}
      />

      <ChapterFindReplaceModal
        open={findReplaceModalOpen}
        chapterIds={selectedChapterIds}
        onCancel={() => setFindReplaceModalOpen(false)}
        onSuccess={async () => {
          setFindReplaceModalOpen(false);
          await onRefreshChapters();
        }}
      />

      <TranslationPreviewModal
        open={previewOpen}
        chapters={chapters}
        defaultChapterId={previewChapterId}
        onCancel={() => setPreviewOpen(false)}
      />

      <Modal
        title="创建校对任务"
        open={proofreadModalOpen}
        onOk={() => void handleStartProofread()}
        onCancel={() => setProofreadModalOpen(false)}
        okText="开始校对"
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message={`将对 ${proofreadableChapterIds.length} 个已翻译章节执行覆盖式校对写回`}
          />
          {unproofreadableChapterIds.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              message={`已自动排除未翻译完成章节：${unproofreadableChapterIds.join(', ')}`}
            />
          ) : null}
          <div>
            <Typography.Text strong>校对预设</Typography.Text>
            <Select
              style={{ width: '100%', marginTop: 8 }}
              value={proofreaderName}
              onChange={(value) => setProofreaderName(value)}
              options={proofreaderOptions}
            />
          </div>
          <div>
            <Typography.Text strong>校对模式</Typography.Text>
            <Select
              style={{ width: '100%', marginTop: 8 }}
              value={proofreadMode}
              onChange={(value) => setProofreadMode(value)}
              options={[
                { value: 'linear', label: '线性校对' },
                { value: 'simultaneous', label: '同时校对' },
              ]}
            />
          </div>
        </Space>
      </Modal>

      <Modal
        title="下载选中章节"
        open={batchDownloadModalOpen}
        okText="下载"
        cancelText="取消"
        onCancel={() => setBatchDownloadModalOpen(false)}
        onOk={() => void handleConfirmBatchDownload()}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message={`将下载 ${selectedChapterIds.length} 个选中章节的导出压缩包`}
          />
          <Select
            style={{ width: '100%' }}
            value={batchDownloadFormat}
            onChange={(value) => setBatchDownloadFormat(value)}
            options={[
              { value: 'plain_text', label: '纯文本' },
              { value: 'naturedialog', label: 'Nature Dialog' },
              { value: 'm3t', label: 'M3T' },
              { value: 'galtransl_json', label: 'GalTransl JSON' },
              { value: 'dbl_tp1', label: 'DBL TP1' },
              { value: 'nd_with_meta', label: 'ND With Meta' },
              { value: 'dbl_tp2', label: 'DBL TP2' },
            ]}
          />
          <Checkbox
            checked={Boolean(exportParams.keepSourceName)}
            onChange={(e) => setExportParams((prev) => ({ ...prev, keepSourceName: e.target.checked }))}
          >
            保持名称
          </Checkbox>
        </Space>
      </Modal>
    </>
  );
}








