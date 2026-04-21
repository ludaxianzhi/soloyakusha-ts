import { useCallback, useRef } from 'react';
import { Button, Card, Empty, Popconfirm, Space, Spin, Tag, Typography } from 'antd';
import {
  DownloadOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import type { ManagedWorkspace } from '../app/types.ts';

interface RecentWorkspacesViewProps {
  workspaces: ManagedWorkspace[];
  onRefreshBootData: () => void;
  onOpenWorkspace: (workspace: ManagedWorkspace) => void | Promise<void>;
  onDeleteWorkspace: (workspace: ManagedWorkspace) => void | Promise<void>;
  onImportWorkspaceArchive: (file: File) => void | Promise<void>;
  onExportWorkspaceArchive: (workspace: ManagedWorkspace) => void | Promise<void>;
  importingArchive?: boolean;
  exportingArchiveDir?: string;
  openingWorkspaceDir?: string | null;
}

export function RecentWorkspacesView({
  workspaces,
  onRefreshBootData,
  onOpenWorkspace,
  onDeleteWorkspace,
  onImportWorkspaceArchive,
  onExportWorkspaceArchive,
  importingArchive,
  exportingArchiveDir,
  openingWorkspaceDir,
}: RecentWorkspacesViewProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleOpenImportDialog = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleImportFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) {
        return;
      }
      void onImportWorkspaceArchive(file);
    },
    [onImportWorkspaceArchive],
  );
  const isOpeningWorkspace = Boolean(openingWorkspaceDir);

  return (
    <Card
      size="small"
      title={
        <>
          <FolderOpenOutlined style={{ marginRight: 8 }} />
          最近工作区
        </>
      }
      extra={
        <Space>
          <Button
            icon={<UploadOutlined />}
            onClick={handleOpenImportDialog}
            loading={importingArchive}
          >
            导入工作区
          </Button>
          <Button icon={<ReloadOutlined />} onClick={onRefreshBootData}>
            刷新
          </Button>
        </Space>
      }
    >
      <input
        ref={inputRef}
        type="file"
        accept=".zip"
        style={{ display: 'none' }}
        onChange={handleImportFileChange}
      />
      {workspaces.length === 0 ? (
        <Empty description="暂无工作区" />
      ) : (
        <Space direction="vertical" style={{ width: '100%' }}>
          {workspaces.map((workspace) => (
            <Spin
              key={workspace.dir}
              spinning={openingWorkspaceDir === workspace.dir}
              tip="正在打开工作区..."
            >
              <div className="recent-workspace-card">
                <div className="recent-workspace-card-header">
                  <div>
                    <Space>
                      <span>{workspace.name}</span>
                      {workspace.managed && <Tag color="green">托管</Tag>}
                      {workspace.deprecated && <Tag color="red">旧版</Tag>}
                    </Space>
                    <div>{workspace.dir}</div>
                    {workspace.deprecated && workspace.deprecationMessage ? (
                      <div>
                        <Typography.Text type="danger">
                          {workspace.deprecationMessage}
                        </Typography.Text>
                      </div>
                    ) : null}
                    <div>
                      <Typography.Text type="secondary">
                        最近打开：{new Date(workspace.lastOpenedAt).toLocaleString()}
                      </Typography.Text>
                    </div>
                  </div>
                  <Space>
                    <Button
                      type="link"
                      icon={<DownloadOutlined />}
                      loading={exportingArchiveDir === workspace.dir}
                      disabled={workspace.deprecated || isOpeningWorkspace}
                      onClick={() => void onExportWorkspaceArchive(workspace)}
                    >
                      导出
                    </Button>
                    <Button
                      type="link"
                      disabled={workspace.deprecated || isOpeningWorkspace}
                      loading={openingWorkspaceDir === workspace.dir}
                      onClick={() => void onOpenWorkspace(workspace)}
                    >
                      打开
                    </Button>
                    <Popconfirm
                      title={workspace.deprecated ? "确认删除该旧版工作区？" : "确认删除该工作区？"}
                      onConfirm={() => void onDeleteWorkspace(workspace)}
                    >
                      <Button type="link" danger disabled={isOpeningWorkspace}>
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                </div>
              </div>
            </Spin>
          ))}
        </Space>
      )}
    </Card>
  );
}
