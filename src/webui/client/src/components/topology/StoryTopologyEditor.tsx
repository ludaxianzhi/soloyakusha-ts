import { useMemo, type ReactNode } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type NodeMouseHandler,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Card, Empty, Space, Tag, Typography } from 'antd';
import type {
  StoryTopologyDescriptor,
  StoryTopologyRouteDescriptor,
  WorkspaceChapterDescriptor,
} from '../../app/types.ts';

interface StoryTopologyEditorProps {
  topology: StoryTopologyDescriptor | null;
  chapters: WorkspaceChapterDescriptor[];
  selectedRouteId?: string | null;
  onSelectRoute?: (routeId: string) => void;
}

export function StoryTopologyEditor({
  topology,
  chapters,
  selectedRouteId,
  onSelectRoute,
}: StoryTopologyEditorProps) {
  const handleNodeClick: NodeMouseHandler = (_, node) => {
    onSelectRoute?.(node.id);
  };

  const chapterById = useMemo(
    () => new Map(chapters.map((chapter) => [chapter.id, chapter] as const)),
    [chapters],
  );

  const { nodes, edges } = useMemo(() => {
    if (!topology) {
      return { nodes: [] as Node[], edges: [] as Edge[] };
    }

    const routeIndexByDepth = new Map<number, number>();
    const nodes: Node[] = topology.routes.map((route) => {
      const depthIndex = routeIndexByDepth.get(route.depth) ?? 0;
      routeIndexByDepth.set(route.depth, depthIndex + 1);

      return {
        id: route.id,
        position: {
          x: route.depth * 320,
          y: depthIndex * 220,
        },
        data: {
          label: (
            <RouteNodeLabel
              route={route}
              chapters={route.chapters
                .map((chapterId) => chapterById.get(chapterId))
                .filter((chapter): chapter is WorkspaceChapterDescriptor => Boolean(chapter))}
            />
          ),
        },
        style: {
          width: 260,
          borderRadius: 12,
          border:
            selectedRouteId === route.id ? '2px solid #1677ff' : '1px solid rgba(5, 5, 5, 0.12)',
          boxShadow:
            selectedRouteId === route.id
              ? '0 0 0 4px rgba(22, 119, 255, 0.12)'
              : '0 6px 18px rgba(5, 5, 5, 0.08)',
          background: '#fff',
          padding: 0,
        },
      };
    });

    const edges: Edge[] = topology.routes
      .filter((route) => route.parentRouteId)
      .map((route) => ({
        id: `${route.parentRouteId}-${route.id}`,
        source: route.parentRouteId!,
        target: route.id,
        label:
          route.forkAfterChapterId === null ? 'fork' : `fork after ${route.forkAfterChapterId}`,
        type: 'smoothstep',
        animated: selectedRouteId === route.id,
      }));

    return { nodes, edges };
  }, [chapterById, selectedRouteId, topology]);

  if (!topology) {
    return <Empty description="当前没有可展示的章节拓扑" />;
  }

  return (
    <div style={{ height: 520, borderRadius: 12, overflow: 'hidden', border: '1px solid #f0f0f0' }}>
      <ReactFlow
        fitView
        nodes={nodes}
        edges={edges}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onNodeClick={handleNodeClick}
      >
        <Background gap={18} size={1} />
        <MiniMap zoomable pannable />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function RouteNodeLabel({
  route,
  chapters,
}: {
  route: StoryTopologyRouteDescriptor;
  chapters: WorkspaceChapterDescriptor[];
}) {
  const previewChapters = chapters.slice(0, 4);
  const hiddenCount = Math.max(0, chapters.length - previewChapters.length);

  return (
    <Card
      size="small"
      bordered={false}
      styles={{ body: { padding: 12 } }}
      title={
        <Space size={8}>
          <Typography.Text strong>{route.name}</Typography.Text>
          {route.isMain ? <Tag color="blue">主线</Tag> : <Tag color="purple">分支</Tag>}
        </Space>
      }
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          {route.parentRouteId
            ? `父路线 ${route.parentRouteId} · 分叉点 ${route.forkAfterChapterId ?? '-'}`
            : '根路线'}
        </Typography.Text>
        <Space wrap size={[4, 4]}>
          {previewChapters.length === 0 ? (
            <Tag>空路线</Tag>
          ) : (
            previewChapters.map((chapter) => (
              <Tag key={chapter.id}>{formatChapterLabel(chapter)}</Tag>
            ))
          )}
          {hiddenCount > 0 ? <Tag>{`+${hiddenCount}`}</Tag> : null}
        </Space>
      </Space>
    </Card>
  );
}

function formatChapterLabel(chapter: WorkspaceChapterDescriptor): ReactNode {
  return `#${chapter.id} ${chapter.filePath}`;
}
