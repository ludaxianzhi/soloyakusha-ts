import { useEffect } from 'react';
import { BookOutlined } from '@ant-design/icons';
import { Button, Card, Popconfirm, Space, Table, Tag } from 'antd';
import type { GlossaryTerm, ProjectStatus } from '../../app/types.ts';
import { TaskActivityPanels } from './TaskActivityPanels.tsx';
import type { ProjectCommand, TaskActivityKind } from './types.ts';

interface WorkspaceDictionaryTabProps {
  active: boolean;
  dictionary: GlossaryTerm[];
  projectStatus: ProjectStatus | null;
  onRefreshProjectStatus: () => void | Promise<void>;
  onRefreshDictionary: () => void | Promise<void>;
  onProjectCommand: (command: ProjectCommand) => void | Promise<void>;
  onOpenDictionaryEditor: (record?: GlossaryTerm) => void;
  onDeleteDictionary: (term: string) => void | Promise<void>;
  onDismissTaskActivity: (task: TaskActivityKind) => void | Promise<void>;
}

export function WorkspaceDictionaryTab({
  active,
  dictionary,
  projectStatus,
  onRefreshProjectStatus,
  onRefreshDictionary,
  onProjectCommand,
  onOpenDictionaryEditor,
  onDeleteDictionary,
  onDismissTaskActivity,
}: WorkspaceDictionaryTabProps) {
  useEffect(() => {
    if (!active) {
      return;
    }

    void Promise.all([onRefreshProjectStatus(), onRefreshDictionary()]);
  }, [active, onRefreshDictionary, onRefreshProjectStatus]);

  return (
    <Card
      title={
        <Space>
          <BookOutlined />
          术语表
        </Space>
      }
      extra={
        <Space>
          <Button onClick={() => void onProjectCommand('scan')}>重新扫描</Button>
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
            render: (value: string | undefined) => (value ? <Tag>{value}</Tag> : '-'),
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 120,
            render: (value: string | undefined) =>
              value ? (
                <Tag color={value === 'translated' ? 'green' : 'gold'}>{value}</Tag>
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
                <Button type="link" onClick={() => onOpenDictionaryEditor(record)}>
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
  );
}
