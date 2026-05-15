import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  BranchesOutlined,
  CaretDownOutlined,
  CaretUpOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  HolderOutlined,
  LockOutlined,
  MoreOutlined,
  PlusOutlined,
  VerticalAlignBottomOutlined,
  VerticalAlignTopOutlined,
} from '@ant-design/icons';
import { Button, Checkbox, Dropdown, Empty, Input, Modal, Popconfirm, Space, Tag, Tooltip, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import type {
  CreateStoryBranchPayload,
  StoryTopologyDescriptor,
  StoryTopologyRouteDescriptor,
  UpdateStoryRoutePayload,
  WorkspaceChapterDescriptor,
} from '../../app/types.ts';

// ─── Types ──────────────────────────────────────────

interface ChapterKanbanBoardProps {
  topology: StoryTopologyDescriptor | null;
  chapters: WorkspaceChapterDescriptor[];
  onCreateBranch: (payload: CreateStoryBranchPayload) => void | Promise<void>;
  onClearChapterTranslations: (chapterIds: number[]) => void | Promise<void>;
  onRemoveChapters: (
    chapterIds: number[],
    options?: { cascadeBranches?: boolean },
  ) => void | Promise<void>;
  onRemoveRoute: (routeId: string) => void | Promise<void>;
  onUpdateRoute: (routeId: string, payload: UpdateStoryRoutePayload) => void | Promise<void>;
  onDownloadChapters: (chapterIds: number[], format: string, params?: Record<string, unknown>) => void | Promise<void>;
  onBatchSaveTopology: (routes: { id: string; chapters: number[] }[]) => void | Promise<void>;
}

type ColumnItems = Record<string, number[]>;

// ─── Main Component ─────────────────────────────────

export function ChapterKanbanBoard({
  topology,
  chapters,
  onCreateBranch,
  onClearChapterTranslations,
  onRemoveChapters,
  onRemoveRoute,
  onUpdateRoute,
  onDownloadChapters,
  onBatchSaveTopology,
}: ChapterKanbanBoardProps) {
  const chapterMap = useMemo(
    () => new Map(chapters.map((c) => [c.id, c] as const)),
    [chapters],
  );

  const forkPointIds = useMemo(() => {
    if (!topology) return new Set<number>();
    const ids = new Set<number>();
    for (const route of topology.routes) {
      if (route.forkAfterChapterId !== null) {
        ids.add(route.forkAfterChapterId);
      }
    }
    return ids;
  }, [topology]);

  const forkPointBranchCount = useMemo(() => {
    if (!topology) return new Map<number, number>();
    const counts = new Map<number, number>();
    for (const route of topology.routes) {
      if (route.forkAfterChapterId !== null) {
        counts.set(
          route.forkAfterChapterId,
          (counts.get(route.forkAfterChapterId) ?? 0) + 1,
        );
      }
    }
    return counts;
  }, [topology]);

  const topologyItems = useMemo<ColumnItems>(() => {
    if (!topology) return {};
    const items: ColumnItems = {};
    for (const route of topology.routes) {
      items[route.id] = [...route.chapters];
    }
    return items;
  }, [topology]);

  const routes = topology?.routes ?? [];

  // ─── Draft state ──────────────────────────────

  const [draftItems, setDraftItems] = useState<ColumnItems | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [exportParams, setExportParams] = useState<Record<string, unknown>>({});
  const dragSourceRef = useRef<{ routeId: string; index: number } | null>(null);

  const items = draftItems ?? topologyItems;
  const hasUnsavedChanges = draftItems !== null;

  // Sync when topology changes externally (e.g. branch created)
  useEffect(() => {
    setDraftItems(null);
    setActiveId(null);
  }, [topologyItems]);

  // Ref of topologyItems for use in setState callbacks
  const topologyItemsRef = useRef<ColumnItems>(topologyItems);
  topologyItemsRef.current = topologyItems;

  // ─── Modals ───────────────────────────────────

  const [branchModal, setBranchModal] = useState<{
    parentRouteId: string;
    forkAfterChapterId: number;
  } | null>(null);
  const [branchName, setBranchName] = useState('');

  const [editRouteModal, setEditRouteModal] = useState<{
    routeId: string;
    name: string;
  } | null>(null);
  const [editRouteName, setEditRouteName] = useState('');

  // ─── Sensors ──────────────────────────────────

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  // ─── Helpers ──────────────────────────────────

  const findContainer = useCallback(
    (id: UniqueIdentifier): string | undefined => {
      // Check if id is a column (route) ID directly
      if (typeof id === 'string' && items[id]) {
        return id;
      }
      const numId = Number(id);
      for (const [routeId, chapterIds] of Object.entries(items)) {
        if (chapterIds.includes(numId)) return routeId;
      }
      return undefined;
    },
    [items],
  );

  // ─── DnD Handlers ────────────────────────────

  const ensureDraft = useCallback(() => {
    setDraftItems((prev) => {
      if (prev) return prev;
      const copy: ColumnItems = {};
      for (const [routeId, chapterIds] of Object.entries(topologyItemsRef.current)) {
        copy[routeId] = [...chapterIds];
      }
      return copy;
    });
  }, []);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const id = Number(event.active.id);
      if (forkPointIds.has(id)) return;
      setActiveId(id);

      // Ensure draft exists before drag
      ensureDraft();

      // Record source position
      const currentItems = draftItems ?? topologyItemsRef.current;
      for (const [routeId, chapterIds] of Object.entries(currentItems)) {
        const idx = chapterIds.indexOf(id);
        if (idx !== -1) {
          dragSourceRef.current = { routeId, index: idx };
          break;
        }
      }
    },
    [forkPointIds, draftItems, ensureDraft],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { active, over } = event;
      if (!over || !draftItems) return;

      const activeContainer = findContainer(active.id);
      let overContainer = findContainer(over.id);

      if (!overContainer && typeof over.id === 'string' && draftItems[over.id] !== undefined) {
        overContainer = over.id;
      }

      if (!activeContainer || !overContainer || activeContainer === overContainer) return;

      setDraftItems((prev) => {
        if (!prev) return prev;
        const activeItems = [...prev[activeContainer]!];
        const overItems = [...prev[overContainer]!];

        const activeIndex = activeItems.indexOf(Number(active.id));
        if (activeIndex === -1) return prev;

        activeItems.splice(activeIndex, 1);

        const overIndex = typeof over.id === 'number' || !isNaN(Number(over.id))
          ? overItems.indexOf(Number(over.id))
          : -1;
        const insertIndex = overIndex === -1 ? overItems.length : overIndex;

        overItems.splice(insertIndex, 0, Number(active.id));

        return {
          ...prev,
          [activeContainer]: activeItems,
          [overContainer]: overItems,
        };
      });
    },
    [draftItems, findContainer],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      const source = dragSourceRef.current;

      if (!over || !source || !draftItems) {
        setActiveId(null);
        dragSourceRef.current = null;
        return;
      }

      const chapterId = Number(active.id);
      const targetContainer = findContainer(active.id);

      if (!targetContainer) {
        setActiveId(null);
        dragSourceRef.current = null;
        return;
      }

      // Draft already updated via handleDragOver — just clear active drag state
      setActiveId(null);
      dragSourceRef.current = null;
    },
    [draftItems, findContainer],
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    dragSourceRef.current = null;
    // Don't discard draft — user may want to keep changes
  }, []);

  // ─── Branch creation ──────────────────────────

  const handleCreateBranch = useCallback(
    (parentRouteId: string, forkAfterChapterId: number) => {
      const chapter = chapterMap.get(forkAfterChapterId);
      const defaultName = chapter
        ? `分支-${chapter.displayName ?? forkAfterChapterId}`
        : `分支-${forkAfterChapterId}`;
      setBranchModal({ parentRouteId, forkAfterChapterId });
      setBranchName(defaultName);
    },
    [chapterMap],
  );

  const confirmCreateBranch = useCallback(() => {
    if (!branchModal) return;
    const payload: CreateStoryBranchPayload = {
      name: branchName.trim() || `分支-${branchModal.forkAfterChapterId}`,
      parentRouteId: branchModal.parentRouteId,
      forkAfterChapterId: branchModal.forkAfterChapterId,
    };
    void onCreateBranch(payload);
    setBranchModal(null);
    setBranchName('');
  }, [branchModal, branchName, onCreateBranch]);

  // ─── Route editing ────────────────────────────

  const handleEditRoute = useCallback((route: StoryTopologyRouteDescriptor) => {
    setEditRouteModal({ routeId: route.id, name: route.name });
    setEditRouteName(route.name);
  }, []);

  const confirmEditRoute = useCallback(() => {
    if (!editRouteModal) return;
    const payload: UpdateStoryRoutePayload = {
      name: editRouteName.trim() || editRouteModal.name,
    };
    void onUpdateRoute(editRouteModal.routeId, payload);
    setEditRouteModal(null);
    setEditRouteName('');
  }, [editRouteModal, editRouteName, onUpdateRoute]);

  // ─── Save / Discard ─────────────────────────

  const handleSave = useCallback(() => {
    if (!draftItems) return;
    const routesSnapshot = Object.entries(draftItems).map(([id, chapters]) => ({
      id,
      chapters: [...chapters],
    }));
    void onBatchSaveTopology(routesSnapshot);
    setDraftItems(null);
    setActiveId(null);
  }, [draftItems, onBatchSaveTopology]);

  const handleDiscard = useCallback(() => {
    setDraftItems(null);
    setActiveId(null);
  }, []);

  // ─── Move chapter within route ──────────────

  const moveChapter = useCallback(
    (routeId: string, chapterId: number, direction: 'up' | 'down' | 'top' | 'bottom') => {
      setDraftItems((prev) => {
        const base = prev ?? {};
        const source = prev ? undefined : topologyItemsRef.current;
        const currentRouteChapters = prev ? prev[routeId] : source?.[routeId];
        if (!currentRouteChapters) return prev ?? null;

        const index = currentRouteChapters.indexOf(chapterId);
        if (index === -1) return prev ?? null;

        const newChapters = [...currentRouteChapters];
        switch (direction) {
          case 'up':
            if (index === 0) return prev ?? null;
            [newChapters[index - 1]!, newChapters[index]!] = [newChapters[index]!, newChapters[index - 1]!];
            break;
          case 'down':
            if (index === newChapters.length - 1) return prev ?? null;
            [newChapters[index]!, newChapters[index + 1]!] = [newChapters[index + 1]!, newChapters[index]!];
            break;
          case 'top':
            newChapters.splice(index, 1);
            newChapters.unshift(chapterId);
            break;
          case 'bottom':
            newChapters.splice(index, 1);
            newChapters.push(chapterId);
            break;
        }

        // Initialize draft from topology if not yet started
        if (!prev) {
          const copy: ColumnItems = {};
          for (const [rid, cids] of Object.entries(topologyItemsRef.current)) {
            copy[rid] = [...cids];
          }
          copy[routeId] = newChapters;
          return copy;
        }

        return { ...prev, [routeId]: newChapters };
      });
    },
    [],
  );

  // ─── Render ───────────────────────────────────

  if (!topology || routes.length === 0) {
    return <Empty description="当前没有章节数据" />;
  }

  const activeChapter = activeId !== null ? chapterMap.get(activeId) : undefined;

  return (
    <>
      <div style={{ padding: '0 16px 8px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <Checkbox
          checked={Boolean(exportParams.keepSourceName)}
          onChange={(e) => setExportParams({ ...exportParams, keepSourceName: e.target.checked })}
        >
          保持名称
        </Checkbox>
        {hasUnsavedChanges ? (
          <>
            <Tag color="warning">有未保存的更改</Tag>
            <Button size="small" type="primary" onClick={handleSave}>
              保存草稿
            </Button>
            <Button size="small" onClick={handleDiscard}>
              放弃改动
            </Button>
          </>
        ) : null}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="kanban-board">
          {routes.map((route) => (
            <KanbanColumn
              key={route.id}
              route={route}
              chapterIds={items[route.id] ?? []}
              chapterMap={chapterMap}
              forkPointIds={forkPointIds}
              forkPointBranchCount={forkPointBranchCount}
              activeId={activeId}
              onCreateBranch={handleCreateBranch}
              onClearChapterTranslations={onClearChapterTranslations}
              onRemoveChapters={onRemoveChapters}
              onEditRoute={handleEditRoute}
              onRemoveRoute={onRemoveRoute}
              onDownloadChapters={onDownloadChapters}
              onMoveChapter={moveChapter}
              params={exportParams}
            />
          ))}
        </div>

        <DragOverlay dropAnimation={null}>
          {activeChapter ? (
            <div className="kanban-card kanban-card-overlay">
              <KanbanCardContent chapter={activeChapter} isForkPoint={false} branchCount={0} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Create Branch Modal */}
      <Modal
        open={branchModal !== null}
        title="创建分支路线"
        okText="创建"
        cancelText="取消"
        onCancel={() => {
          setBranchModal(null);
          setBranchName('');
        }}
        onOk={confirmCreateBranch}
      >
        {branchModal ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Typography.Text type="secondary">
              {`从章节 #${branchModal.forkAfterChapterId} 之后分叉`}
            </Typography.Text>
            <Input
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              placeholder="分支名称"
              onPressEnter={confirmCreateBranch}
              autoFocus
            />
          </Space>
        ) : null}
      </Modal>

      {/* Edit Route Modal */}
      <Modal
        open={editRouteModal !== null}
        title="编辑路线名称"
        okText="保存"
        cancelText="取消"
        onCancel={() => {
          setEditRouteModal(null);
          setEditRouteName('');
        }}
        onOk={confirmEditRoute}
      >
        <Input
          value={editRouteName}
          onChange={(e) => setEditRouteName(e.target.value)}
          placeholder="路线名称"
          onPressEnter={confirmEditRoute}
          autoFocus
        />
      </Modal>
    </>
  );
}

// ─── KanbanColumn ───────────────────────────────────

interface KanbanColumnProps {
  route: StoryTopologyRouteDescriptor;
  chapterIds: number[];
  chapterMap: Map<number, WorkspaceChapterDescriptor>;
  forkPointIds: Set<number>;
  forkPointBranchCount: Map<number, number>;
  activeId: number | null;
  onCreateBranch: (parentRouteId: string, forkAfterChapterId: number) => void;
  onClearChapterTranslations: (chapterIds: number[]) => void | Promise<void>;
  onRemoveChapters: (
    chapterIds: number[],
    options?: { cascadeBranches?: boolean },
  ) => void | Promise<void>;
  onEditRoute: (route: StoryTopologyRouteDescriptor) => void;
  onRemoveRoute: (routeId: string) => void | Promise<void>;
  onDownloadChapters: (chapterIds: number[], format: string, params?: Record<string, unknown>) => void | Promise<void>;
  onMoveChapter: (routeId: string, chapterId: number, direction: 'up' | 'down' | 'top' | 'bottom') => void;
  params?: Record<string, unknown>;
}

function KanbanColumn({
  route,
  chapterIds,
  chapterMap,
  forkPointIds,
  forkPointBranchCount,
  activeId,
  onCreateBranch,
  onClearChapterTranslations,
  onRemoveChapters,
  onEditRoute,
  onRemoveRoute,
  onDownloadChapters,
  onMoveChapter,
  params,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: route.id });

  const hasChildRoutes = route.childRouteIds.length > 0;
  const canDelete = !route.isMain && !hasChildRoutes;

  return (
    <div
      className={`kanban-column ${isOver ? 'kanban-column-over' : ''}`}
    >
      {/* Column header */}
      <div className="kanban-column-header">
        <div className="kanban-column-title">
          <Tag
            color={route.isMain ? 'blue' : 'purple'}
            style={{ marginRight: 4 }}
          >
            {route.isMain ? '主线' : '分支'}
          </Tag>
          <Typography.Text strong ellipsis style={{ maxWidth: 140 }}>
            {route.name}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ marginLeft: 4, fontSize: 12 }}>
            {chapterIds.length}
          </Typography.Text>
        </div>
        <Space size={2}>
          <Tooltip title="重命名路线">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={() => onEditRoute(route)}
            />
          </Tooltip>
          {canDelete ? (
            <Popconfirm
              title="删除此路线？"
              description={
                chapterIds.length > 0
                  ? `路线内 ${chapterIds.length} 个章节将回归父路线。`
                  : undefined
              }
              okText="删除"
              cancelText="取消"
              onConfirm={() => void onRemoveRoute(route.id)}
            >
              <Button type="text" size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          ) : null}
        </Space>
      </div>

      {/* Fork info for branch routes */}
      {route.parentRouteId ? (
        <div className="kanban-column-fork-info">
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {`分叉自 ${route.forkAfterChapterId !== null ? `#${route.forkAfterChapterId}` : '—'}`}
          </Typography.Text>
        </div>
      ) : null}

      {/* Chapter cards */}
      <div ref={setNodeRef} className="kanban-column-body">
        <SortableContext
          items={chapterIds}
          strategy={verticalListSortingStrategy}
        >
          {chapterIds.length === 0 ? (
            <div className="kanban-column-empty">
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                拖放章节到此路线
              </Typography.Text>
            </div>
          ) : (
            chapterIds.map((chapterId) => {
              const chapter = chapterMap.get(chapterId);
              const isForkPoint = forkPointIds.has(chapterId);
              const branchCount = forkPointBranchCount.get(chapterId) ?? 0;
              return (
                <KanbanCard
                  key={chapterId}
                  chapterId={chapterId}
                  chapter={chapter}
                  isForkPoint={isForkPoint}
                  branchCount={branchCount}
                  isDragging={activeId === chapterId}
                  routeId={route.id}
                  onCreateBranch={onCreateBranch}
                  onClearChapterTranslations={onClearChapterTranslations}
                  onRemoveChapters={onRemoveChapters}
                  onDownloadChapters={onDownloadChapters}
                  onMoveChapter={onMoveChapter}
                  params={params}
                />
              );
            })
          )}
        </SortableContext>
      </div>
    </div>
  );
}

// ─── KanbanCard ─────────────────────────────────────

interface KanbanCardProps {
  chapterId: number;
  chapter?: WorkspaceChapterDescriptor;
  isForkPoint: boolean;
  branchCount: number;
  isDragging: boolean;
  routeId: string;
  onCreateBranch: (parentRouteId: string, forkAfterChapterId: number) => void;
  onClearChapterTranslations: (chapterIds: number[]) => void | Promise<void>;
  onRemoveChapters: (
    chapterIds: number[],
    options?: { cascadeBranches?: boolean },
  ) => void | Promise<void>;
  onDownloadChapters: (chapterIds: number[], format: string, params?: Record<string, unknown>) => void | Promise<void>;
  onMoveChapter: (routeId: string, chapterId: number, direction: 'up' | 'down' | 'top' | 'bottom') => void;
  params?: Record<string, unknown>;
}

function KanbanCard({
  chapterId,
  chapter,
  isForkPoint,
  branchCount,
  isDragging,
  routeId,
  onCreateBranch,
  onClearChapterTranslations,
  onRemoveChapters,
  onDownloadChapters,
  onMoveChapter,
  params,
}: KanbanCardProps) {
  const navigate = useNavigate();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: chapterId,
    disabled: isForkPoint,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const menuItems = [
    {
      key: 'edit',
      label: '在线编辑',
      onClick: () => navigate(`/workspace/editor/${chapterId}`),
    },
    {
      key: 'download',
      icon: <DownloadOutlined />,
      label: '下载章节',
      children: [
        { key: 'download-plain_text', label: '纯文本', onClick: () => onDownloadChapters([chapterId], 'plain_text', params) },
        { key: 'download-naturedialog', label: 'Nature Dialog', onClick: () => onDownloadChapters([chapterId], 'naturedialog', params) },
        { key: 'download-m3t', label: 'M3T', onClick: () => onDownloadChapters([chapterId], 'm3t', params) },
        { key: 'download-galtransl_json', label: 'GalTransl JSON', onClick: () => onDownloadChapters([chapterId], 'galtransl_json', params) },
        { key: 'download-dbl_tp1', label: 'DBL TP1', onClick: () => onDownloadChapters([chapterId], 'dbl_tp1', params) },
        { key: 'download-nd_with_meta', label: 'ND With Meta', onClick: () => onDownloadChapters([chapterId], 'nd_with_meta', params) },
      ],
    },
    {
      key: 'clear',
      label: '清空译文',
      onClick: () => {
        Modal.confirm({
          title: '确认清空该章节的译文？',
          okText: '清空',
          cancelText: '取消',
          onOk: () => onClearChapterTranslations([chapterId]),
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
          onOk: () => onRemoveChapters([chapterId], { cascadeBranches: false }),
        });
      },
    },
  ];

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={[
        'kanban-card',
        isForkPoint ? 'fork-point' : '',
        isDragging ? 'dragging' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="kanban-card-header">
        {isForkPoint ? (
          <LockOutlined className="kanban-card-grip fork-icon" />
        ) : (
          <HolderOutlined
            className="kanban-card-grip"
            {...attributes}
            {...listeners}
          />
        )}
        <KanbanCardContent
          chapter={chapter ?? { id: chapterId, filePath: `章节 ${chapterId}`, displayName: `章节 ${chapterId}`, sourceLineCount: 0, translatedLineCount: 0 }}
          isForkPoint={isForkPoint}
          branchCount={branchCount}
        />
      </div>

      {/* Progress bar */}
      {chapter && chapter.sourceLineCount > 0 ? (
        <div className="kanban-card-progress">
          <div
            className={`kanban-card-progress-fill${chapter.translatedLineCount >= chapter.sourceLineCount ? ' complete' : ''}`}
            style={{
              width: `${Math.min(100, Math.round((chapter.translatedLineCount / chapter.sourceLineCount) * 100))}%`,
            }}
          />
        </div>
      ) : null}

      {/* Actions row */}
      <div className="kanban-card-actions">
        {!isForkPoint ? (
          <>
            <Tooltip title="置顶">
              <Button type="text" size="small" icon={<VerticalAlignTopOutlined />} onClick={() => onMoveChapter(routeId, chapterId, 'top')} />
            </Tooltip>
            <Tooltip title="上移">
              <Button type="text" size="small" icon={<CaretUpOutlined />} onClick={() => onMoveChapter(routeId, chapterId, 'up')} />
            </Tooltip>
            <Tooltip title="下移">
              <Button type="text" size="small" icon={<CaretDownOutlined />} onClick={() => onMoveChapter(routeId, chapterId, 'down')} />
            </Tooltip>
            <Tooltip title="置底">
              <Button type="text" size="small" icon={<VerticalAlignBottomOutlined />} onClick={() => onMoveChapter(routeId, chapterId, 'bottom')} />
            </Tooltip>
          </>
        ) : null}
        <Tooltip title="从此章节创建分支路线">
          <Button
            type="text"
            size="small"
            icon={<BranchesOutlined />}
            onClick={() => onCreateBranch(routeId, chapterId)}
          >
            分支
          </Button>
        </Tooltip>
        <Dropdown
          trigger={['click']}
          menu={{ items: menuItems }}
        >
          <Button type="text" size="small" icon={<MoreOutlined />} />
        </Dropdown>
      </div>
    </div>
  );
}

// ─── Shared card content (used in both card and overlay) ─

function KanbanCardContent({
  chapter,
  isForkPoint,
  branchCount,
}: {
  chapter: Pick<WorkspaceChapterDescriptor, 'id' | 'filePath' | 'displayName' | 'sourceLineCount' | 'translatedLineCount'>;
  isForkPoint: boolean;
  branchCount: number;
}) {
  const progress =
    chapter.sourceLineCount > 0
      ? Math.round((chapter.translatedLineCount / chapter.sourceLineCount) * 100)
      : 0;

  return (
    <div className="kanban-card-body">
      <div className="kanban-card-title-row">
        <Typography.Text strong style={{ fontSize: 12 }}>
          #{chapter.id}
        </Typography.Text>
        <Typography.Text
          ellipsis
          style={{ fontSize: 12, flex: 1, marginLeft: 4, color: 'var(--text-secondary)' }}
          title={chapter.filePath}
        >
          {chapter.displayName}
        </Typography.Text>
        {isForkPoint ? (
          <Tag
            color="gold"
            style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0 }}
          >
            ⑂{branchCount}
          </Tag>
        ) : null}
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        {chapter.translatedLineCount}/{chapter.sourceLineCount} 行 · {progress}%
      </Typography.Text>
    </div>
  );
}
