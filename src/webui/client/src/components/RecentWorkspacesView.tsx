import { Button, Card, Empty, Popconfirm, Space, Tag, Typography } from 'antd';
import { FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ManagedWorkspace } from '../app/types.ts';

interface RecentWorkspacesViewProps {
  workspaces: ManagedWorkspace[];
  onRefreshBootData: () => void;
  onOpenWorkspace: (workspace: ManagedWorkspace) => void | Promise<void>;
  onDeleteWorkspace: (workspace: ManagedWorkspace) => void | Promise<void>;
}

export function RecentWorkspacesView({
  workspaces,
  onRefreshBootData,
  onOpenWorkspace,
  onDeleteWorkspace,
}: RecentWorkspacesViewProps) {
  return (
    <Card
      title={
        <>
          <FolderOpenOutlined style={{ marginRight: 8 }} />
          最近工作区
        </>
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
  );
}
