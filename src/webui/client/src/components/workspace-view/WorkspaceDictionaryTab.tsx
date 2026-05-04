import { useEffect, useState } from 'react';
import { BookOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import type {
  DictionaryImportResult,
  GlossaryTerm,
  ProjectStatus,
} from '../../app/types.ts';
import { usePollingTask } from '../../app/usePollingTask.ts';
import { TaskActivityPanels } from './TaskActivityPanels.tsx';
import type { ProjectCommand, TaskActivityKind } from './types.ts';

const { TextArea } = Input;

interface WorkspaceDictionaryTabProps {
  active: boolean;
  dictionary: GlossaryTerm[];
  projectStatus: ProjectStatus | null;
  onRefreshProjectStatus: () => void | Promise<void>;
  onRefreshDictionary: () => void | Promise<void>;
  onProjectCommand: (command: ProjectCommand) => void | Promise<void>;
  onOpenDictionaryEditor: (record?: GlossaryTerm) => void;
  onDeleteDictionary: (term: string) => void | Promise<void>;
  onImportDictionaryFromContent: (
    content: string,
    format: 'csv' | 'tsv',
  ) => Promise<DictionaryImportResult>;
  onAbortTaskActivity: (task: TaskActivityKind) => void | Promise<void>;
  onForceAbortTaskActivity: (task: TaskActivityKind) => void | Promise<void>;
  onRemoveTaskActivity: (task: TaskActivityKind) => void | Promise<void>;
  onResumeTaskActivity: (task: TaskActivityKind) => void | Promise<void>;
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
  onImportDictionaryFromContent,
  onAbortTaskActivity,
  onForceAbortTaskActivity,
  onRemoveTaskActivity,
  onResumeTaskActivity,
  onDismissTaskActivity,
}: WorkspaceDictionaryTabProps) {
  const { message } = AntdApp.useApp();
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importFormat, setImportFormat] = useState<'csv' | 'tsv'>('csv');
  const [importContent, setImportContent] = useState('');
  const [importResult, setImportResult] = useState<DictionaryImportResult | null>(null);

  const openImportModal = () => {
    setImportModalOpen(true);
    setImportResult(null);
  };

  const closeImportModal = () => {
    if (importing) {
      return;
    }
    setImportModalOpen(false);
  };

  const handleImport = async () => {
    if (!importContent.trim()) {
      message.error('请先粘贴 CSV/TSV 内容');
      return;
    }
    setImporting(true);
    try {
      const result = await onImportDictionaryFromContent(importContent, importFormat);
      setImportResult(result);
    } catch {
      // error message handled by parent callback
    } finally {
      setImporting(false);
    }
  };

  useEffect(() => {
    if (!active) {
      return;
    }

    void Promise.all([onRefreshProjectStatus(), onRefreshDictionary()]);
  }, [active, onRefreshDictionary, onRefreshProjectStatus]);

  usePollingTask({
    enabled: active,
    intervalMs: 5_000,
    task: async () => {
      await onRefreshDictionary();
    },
  });

  return (
    <>
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
            <Button onClick={() => void onProjectCommand('transcribe')}>解释翻译</Button>
            <Button onClick={openImportModal}>粘贴导入</Button>
            <Button type="primary" onClick={() => onOpenDictionaryEditor()}>
              新建条目
            </Button>
          </Space>
        }
      >
        <TaskActivityPanels
          projectStatus={projectStatus}
          tasks={['scan', 'transcribe']}
          onAbortTaskActivity={onAbortTaskActivity}
          onForceAbortTaskActivity={onForceAbortTaskActivity}
          onRemoveTaskActivity={onRemoveTaskActivity}
          onResumeTaskActivity={onResumeTaskActivity}
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

      <Modal
        open={importModalOpen}
        title="粘贴批量导入术语"
        okText="导入"
        cancelText="取消"
        confirmLoading={importing}
        onCancel={closeImportModal}
        onOk={() => void handleImport()}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="仅支持 term / translation / description 三列"
            description="出现次数字段会在术语扫描时按需重算，不从粘贴内容导入。"
          />
          <Select<'csv' | 'tsv'>
            value={importFormat}
            options={[
              { label: 'CSV', value: 'csv' },
              { label: 'TSV', value: 'tsv' },
            ]}
            onChange={(value) => setImportFormat(value)}
          />
          <TextArea
            rows={12}
            value={importContent}
            onChange={(event) => setImportContent(event.target.value)}
            placeholder="term,translation,description"
          />
          {importResult ? (
            <Alert
              type="success"
              showIcon
              message={`导入完成：${importResult.termCount} 项`}
              description={`新增 ${importResult.newTermCount}，更新 ${importResult.updatedTermCount}`}
            />
          ) : null}
        </Space>
      </Modal>
    </>
  );
}
