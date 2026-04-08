import { Button, Card, Popconfirm, Space, Table, Tabs, Tag } from 'antd';
import type {
  CreateStoryBranchPayload,
  StoryTopologyDescriptor,
  UpdateStoryRoutePayload,
  WorkspaceChapterDescriptor,
} from '../../app/types.ts';
import { ChapterKanbanBoard } from '../topology/ChapterKanbanBoard.tsx';

interface WorkspaceChaptersTabProps {
  chapters: WorkspaceChapterDescriptor[];
  topology: StoryTopologyDescriptor | null;
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
  onMoveChapterToRoute: (
    chapterId: number,
    targetRouteId: string,
    targetIndex: number,
  ) => void | Promise<void>;
  onRemoveStoryRoute: (routeId: string) => void | Promise<void>;
}

export function WorkspaceChaptersTab({
  chapters,
  topology,
  onClearChapterTranslations,
  onRemoveChapter,
  onCreateStoryBranch,
  onUpdateStoryRoute,
  onReorderStoryRouteChapters,
  onMoveChapterToRoute,
  onRemoveStoryRoute,
}: WorkspaceChaptersTabProps) {
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
        defaultActiveKey="arrange"
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
                onClearChapterTranslations={onClearChapterTranslations}
                onRemoveChapter={onRemoveChapter}
              />
            ),
          },
        ]}
      />
    </Card>
  );
}

// ─── Read-only chapter info table ───────────────────

function ChapterInfoTable({
  chapters,
  onClearChapterTranslations,
  onRemoveChapter,
}: {
  chapters: WorkspaceChapterDescriptor[];
  onClearChapterTranslations: (chapterIds: number[]) => void | Promise<void>;
  onRemoveChapter: (chapterId: number) => void | Promise<void>;
}) {
  return (
    <Table
      rowKey="id"
      dataSource={chapters}
      pagination={false}
      size="small"
      columns={[
        { title: 'ID', dataIndex: 'id', width: 60 },
        { title: '文件路径', dataIndex: 'filePath', ellipsis: true },
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
          width: 180,
          render: (_, record: WorkspaceChapterDescriptor) => (
            <Space>
              <Popconfirm
                title="确认清空该章节的译文？"
                onConfirm={() => void onClearChapterTranslations([record.id])}
              >
                <Button size="small">清空译文</Button>
              </Popconfirm>
              <Popconfirm
                title="确认移除该章节？"
                onConfirm={() => void onRemoveChapter(record.id)}
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
  );
}
