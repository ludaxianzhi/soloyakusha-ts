import { useEffect, useRef, useState } from 'react';
import { BookOutlined, DownloadOutlined, UploadOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
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
import type {
  DictionaryScanStartOptions,
  DictionaryFileFormat,
  ProjectCommand,
  TaskActivityKind,
  DictionaryTranscribeStartOptions,
} from './types.ts';

const { TextArea } = Input;

interface WorkspaceDictionaryTabProps {
  active: boolean;
  dictionary: GlossaryTerm[];
  projectStatus: ProjectStatus | null;
  onRefreshProjectStatus: () => void | Promise<void>;
  onRefreshDictionary: () => void | Promise<void>;
  onProjectCommand: (command: ProjectCommand) => void | Promise<void>;
  onStartDictionaryScan: (options: DictionaryScanStartOptions) => void | Promise<void>;
  onStartDictionaryTranscribe: (options: DictionaryTranscribeStartOptions) => void | Promise<void>;
  onOpenDictionaryEditor: (record?: GlossaryTerm) => void;
  onDeleteDictionary: (terms: string[]) => void | Promise<void>;
  dictionaryScanDefaults?: DictionaryScanStartOptions;
  dictionaryTranscribeDefaults?: DictionaryTranscribeStartOptions;
  onImportDictionaryFile: (file: File) => void | Promise<void>;
  onImportDictionaryFromContent: (
    content: string,
    format: 'csv' | 'tsv',
  ) => Promise<DictionaryImportResult>;
  onDownloadDictionaryExport: (format: DictionaryFileFormat) => void | Promise<void>;
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
  onStartDictionaryScan,
  onStartDictionaryTranscribe,
  onOpenDictionaryEditor,
  onDeleteDictionary,
  dictionaryScanDefaults,
  dictionaryTranscribeDefaults,
  onImportDictionaryFile,
  onImportDictionaryFromContent,
  onDownloadDictionaryExport,
  onAbortTaskActivity,
  onForceAbortTaskActivity,
  onRemoveTaskActivity,
  onResumeTaskActivity,
  onDismissTaskActivity,
}: WorkspaceDictionaryTabProps) {
  const { message } = AntdApp.useApp();
  const [dictionaryPage, setDictionaryPage] = useState(1);
  const [dictionaryPageSize, setDictionaryPageSize] = useState(10);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedTerms, setSelectedTerms] = useState<string[]>([]);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importFormat, setImportFormat] = useState<'csv' | 'tsv'>('csv');
  const [importContent, setImportContent] = useState('');
  const [importResult, setImportResult] = useState<DictionaryImportResult | null>(null);
  const [exportFormat, setExportFormat] = useState<DictionaryFileFormat>('json');
  const [scanModalOpen, setScanModalOpen] = useState(false);
  const [scanSubmitting, setScanSubmitting] = useState(false);
  const [transcribeModalOpen, setTranscribeModalOpen] = useState(false);
  const [transcribeSubmitting, setTranscribeSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [scanForm] = Form.useForm<DictionaryScanStartOptions>();
  const [transcribeForm] = Form.useForm<DictionaryTranscribeStartOptions>();

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

  const openScanModal = () => {
    scanForm.setFieldsValue({
      maxCharsPerBatch: dictionaryScanDefaults?.maxCharsPerBatch,
      occurrenceTopK: dictionaryScanDefaults?.occurrenceTopK,
      occurrenceTopP: dictionaryScanDefaults?.occurrenceTopP,
    });
    setScanModalOpen(true);
  };

  const closeScanModal = () => {
    if (scanSubmitting) {
      return;
    }
    setScanModalOpen(false);
  };

  const openTranscribeModal = () => {
    transcribeForm.setFieldsValue({
      maxCharsPerBatch: dictionaryTranscribeDefaults?.maxCharsPerBatch,
      maxTermsPerRequest: dictionaryTranscribeDefaults?.maxTermsPerRequest ?? 10,
    });
    setTranscribeModalOpen(true);
  };

  const closeTranscribeModal = () => {
    if (transcribeSubmitting) {
      return;
    }
    setTranscribeModalOpen(false);
  };

  const handleStartScan = async () => {
    const values = await scanForm.validateFields();
    setScanSubmitting(true);
    try {
      await onStartDictionaryScan(values);
      setScanModalOpen(false);
    } finally {
      setScanSubmitting(false);
    }
  };

  const handleStartTranscribe = async () => {
    const values = await transcribeForm.validateFields();
    setTranscribeSubmitting(true);
    try {
      await onStartDictionaryTranscribe(values);
      setTranscribeModalOpen(false);
    } finally {
      setTranscribeSubmitting(false);
    }
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

  const handleFileSelection = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }

    await onImportDictionaryFile(file);
  };

  const handleDeleteTerms = async (terms: string[]) => {
    if (terms.length === 0) {
      return;
    }

    await onDeleteDictionary(terms);
    setSelectedTerms((current) => current.filter((term) => !terms.includes(term)));
  };

  const toggleSelectionMode = () => {
    setSelectionMode((current) => {
      if (current) {
        setSelectedTerms([]);
      }
      return !current;
    });
  };

  useEffect(() => {
    if (!active) {
      return;
    }

    void Promise.all([onRefreshProjectStatus(), onRefreshDictionary()]);
  }, [active, onRefreshDictionary, onRefreshProjectStatus]);

  useEffect(() => {
    const availableTerms = new Set(dictionary.map((item) => item.term));
    setSelectedTerms((current) => current.filter((term) => availableTerms.has(term)));
  }, [dictionary]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(dictionary.length / dictionaryPageSize));
    setDictionaryPage((current) => Math.min(current, totalPages));
  }, [dictionary.length, dictionaryPageSize]);

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
            <Button onClick={openScanModal}>重新扫描</Button>
            <Button onClick={openTranscribeModal}>解释翻译</Button>
            <Button onClick={toggleSelectionMode}>
              {selectionMode ? '退出多选' : '多选删除'}
            </Button>
            {selectionMode ? (
              <Button
                danger
                disabled={selectedTerms.length === 0}
                onClick={() => void handleDeleteTerms(selectedTerms)}
              >
                删除选中（{selectedTerms.length}）
              </Button>
            ) : null}
            <Button
              icon={<UploadOutlined />}
              onClick={() => fileInputRef.current?.click()}
            >
              文件导入
            </Button>
            <Button onClick={openImportModal}>粘贴导入</Button>
            <Space.Compact>
              <Select<DictionaryFileFormat>
                value={exportFormat}
                style={{ width: 110 }}
                options={[
                  { label: 'JSON', value: 'json' },
                  { label: 'CSV', value: 'csv' },
                  { label: 'TSV', value: 'tsv' },
                  { label: 'YAML', value: 'yaml' },
                  { label: 'YML', value: 'yml' },
                  { label: 'XML', value: 'xml' },
                ]}
                onChange={(value) => setExportFormat(value)}
              />
              <Button
                icon={<DownloadOutlined />}
                onClick={() => void onDownloadDictionaryExport(exportFormat)}
              >
                导出文件
              </Button>
            </Space.Compact>
            <Button type="primary" onClick={() => onOpenDictionaryEditor()}>
              新建条目
            </Button>
          </Space>
        }
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.csv,.tsv,.yaml,.yml,.xml"
          style={{ display: 'none' }}
          onChange={(event) => void handleFileSelection(event)}
        />
        <TaskActivityPanels
          projectStatus={projectStatus}
          tasks={['scan', 'transcribe']}
          onAbortTaskActivity={onAbortTaskActivity}
          onForceAbortTaskActivity={onForceAbortTaskActivity}
          onRemoveTaskActivity={onRemoveTaskActivity}
          onResumeTaskActivity={onResumeTaskActivity}
          onDismissTaskActivity={onDismissTaskActivity}
        />
        {projectStatus?.transcribeDictionaryProgress?.status === 'running' ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message={
              projectStatus.transcribeDictionaryProgress.currentChunkIndex != null &&
              projectStatus.transcribeDictionaryProgress.totalChunksInBatch != null
                ? `当前正在处理本批次的第 ${projectStatus.transcribeDictionaryProgress.currentChunkIndex}/${projectStatus.transcribeDictionaryProgress.totalChunksInBatch} 个术语子批次`
                : '当前正在处理术语解释翻译'
            }
            description={
              projectStatus.transcribeDictionaryProgress.currentChunkTermCount != null
                ? `本次提交 ${projectStatus.transcribeDictionaryProgress.currentChunkTermCount} 个术语，单次上限 ${projectStatus.transcribeDictionaryProgress.maxTermsPerRequest ?? '-'}。`
                : `单次上限 ${projectStatus.transcribeDictionaryProgress.maxTermsPerRequest ?? '-'} 个术语。`
            }
          />
        ) : null}
        <Table
          rowKey="term"
          dataSource={dictionary}
          pagination={{
            current: dictionaryPage,
            pageSize: dictionaryPageSize,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50, 100],
            onChange: (page, pageSize) => {
              setDictionaryPage(page);
              setDictionaryPageSize(pageSize);
            },
          }}
          rowSelection={
            selectionMode
              ? {
                  selectedRowKeys: selectedTerms,
                  onChange: (selectedRowKeys) => {
                    setSelectedTerms(selectedRowKeys.map((key) => String(key)));
                  },
                }
              : undefined
          }
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
                  <Button type="link" danger onClick={() => void handleDeleteTerms([record.term])}>
                    删除
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        open={scanModalOpen}
        title="术语扫描配置"
        okText="开始扫描"
        cancelText="取消"
        confirmLoading={scanSubmitting}
        onOk={() => void handleStartScan()}
        onCancel={closeScanModal}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="扫描结果会在全部批次完成并应用 TopK/TopP 过滤后一次性写回术语表。"
        />
        <Form form={scanForm} layout="vertical" className="compact-form">
          <Form.Item name="maxCharsPerBatch" label="每批最长字符数">
            <InputNumber min={1} style={{ width: '100%' }} placeholder="留空使用默认值" />
          </Form.Item>
          <Form.Item name="occurrenceTopK" label="Top K">
            <InputNumber min={1} style={{ width: '100%' }} placeholder="留空表示不过滤" />
          </Form.Item>
          <Form.Item name="occurrenceTopP" label="Top P">
            <InputNumber min={0} max={1} step={0.01} style={{ width: '100%' }} placeholder="0 - 1" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={transcribeModalOpen}
        title="术语解释翻译配置"
        okText="开始解释翻译"
        cancelText="取消"
        confirmLoading={transcribeSubmitting}
        onOk={() => void handleStartTranscribe()}
        onCancel={closeTranscribeModal}
      >
        <Form form={transcribeForm} layout="vertical" className="compact-form">
          <Form.Item name="maxCharsPerBatch" label="每批最长字符数">
            <InputNumber min={1} style={{ width: '100%' }} placeholder="留空使用设置页默认值" />
          </Form.Item>
          <Form.Item name="maxTermsPerRequest" label="每次解释翻译术语数">
            <InputNumber min={1} style={{ width: '100%' }} placeholder="默认 10" />
          </Form.Item>
        </Form>
      </Modal>

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
            description="文件导入支持 JSON / CSV / TSV / YAML / YML / XML 全字段；粘贴导入仍只解析 term / translation / description 三列。"
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
