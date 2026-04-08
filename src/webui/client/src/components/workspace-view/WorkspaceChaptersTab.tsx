import { useMemo, useState } from 'react';
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Input,
  List,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
} from 'antd';
import type {
  CreateStoryBranchPayload,
  StoryTopologyDescriptor,
  UpdateStoryRoutePayload,
  WorkspaceChapterDescriptor,
} from '../../app/types.ts';
import { StoryTopologyEditor } from '../topology/StoryTopologyEditor.tsx';
import { formatChapterLabel } from './utils.ts';

interface WorkspaceChaptersTabProps {
  chapters: WorkspaceChapterDescriptor[];
  topology: StoryTopologyDescriptor | null;
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
}

interface BranchDraft {
  parentRouteId: string;
  forkAfterChapterId: number;
  initialName: string;
  eligibleChapterIds: number[];
}

interface RouteEditorDraft {
  routeId: string;
  name: string;
  forkAfterChapterId?: number;
}

export function WorkspaceChaptersTab({
  chapters,
  topology,
  onMoveChapter,
  onClearChapterTranslations,
  onRemoveChapter,
  onCreateStoryBranch,
  onUpdateStoryRoute,
  onReorderStoryRouteChapters,
  onRemoveStoryRoute,
}: WorkspaceChaptersTabProps) {
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [branchDraft, setBranchDraft] = useState<BranchDraft | null>(null);
  const [branchName, setBranchName] = useState('');
  const [branchChapterIds, setBranchChapterIds] = useState<number[]>([]);
  const [routeEditorDraft, setRouteEditorDraft] = useState<RouteEditorDraft | null>(null);
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
  const selectedRouteForkOptions =
    selectedRouteParent?.chapters.map((chapterId) => {
      const chapter = chapterMap.get(chapterId);
      return {
        label: chapter ? formatChapterLabel(chapter) : `章节 ${chapterId}`,
        value: chapterId,
      };
    }) ?? [];

  return (
    <>
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
                              <Tag color="gold">{`${record.childBranchCount} 个子分支`}</Tag>
                            ) : (
                              <Tag>线性节点</Tag>
                            )}
                          </Space>
                        ),
                      },
                      {
                        title: '操作',
                        width: 360,
                        render: (
                          _,
                          record: WorkspaceChapterDescriptor,
                          index: number,
                        ) => (
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
                              onConfirm={() => void onClearChapterTranslations([record.id])}
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
                        <Space direction="vertical" size={12} style={{ width: '100%' }}>
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
                                onConfirm={() => void onRemoveStoryRoute(selectedRoute.id)}
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
                                        const previous = next[chapterIndex - 1];
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
                                        chapterIndex >= selectedRoute.chapters.length - 1
                                      }
                                      onClick={() => {
                                        const next = [...selectedRoute.chapters];
                                        const current = next[chapterIndex];
                                        const following = next[chapterIndex + 1];
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
                                  {chapter
                                    ? formatChapterLabel(chapter)
                                    : `章节 ${chapterId}`}
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
            <span style={{ color: 'rgba(0, 0, 0, 0.45)' }}>
              {`从路线 ${branchDraft.parentRouteId} 的章节 ${branchDraft.forkAfterChapterId} 之后分叉`}
            </span>
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
    </>
  );
}
