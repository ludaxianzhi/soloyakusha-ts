import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOutlined,
  DownloadOutlined,
  SaveOutlined,
  SearchOutlined,
  SortAscendingOutlined,
  SortDescendingOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App as AntdApp,
  Badge,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
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

const CATEGORY_FILTER_OPTIONS = [
  { label: '人名', value: 'personName' },
  { label: '地名', value: 'placeName' },
  { label: '专有名词', value: 'properNoun' },
  { label: '人物称呼', value: 'personTitle' },
  { label: '口癖', value: 'catchphrase' },
  { label: '称呼模式', value: 'addressTerm' },
];

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
  onSaveDictionaryTerms: (
    terms: Array<{ term: string; from?: string; translation: string; description?: string }>,
  ) => void | Promise<void>;
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
  onSaveDictionaryTerms,
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
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
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

  const [searchText, setSearchText] = useState('');
  const [searchMode, setSearchMode] = useState<'termTranslation' | 'description'>('termTranslation');
  const [categoryFilter, setCategoryFilter] = useState<string | undefined>(undefined);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc' | null>(null);
  const [draftDictionary, setDraftDictionary] = useState<Record<string, { translation: string; description: string }>>({});
  const [saving, setSaving] = useState(false);

  const deferredSearchText = useDeferredValue(searchText);

  const getRowKey = (record: GlossaryTerm) => record.term + '\x00' + (record.from ?? '');

  useEffect(() => {
    const availableKeys = new Set(dictionary.map(getRowKey));
    setDraftDictionary((prev) => {
      const keys = Object.keys(prev);
      if (keys.every((key) => availableKeys.has(key))) return prev;
      const next: Record<string, { translation: string; description: string }> = {};
      for (const key of keys) {
        if (availableKeys.has(key)) next[key] = prev[key]!;
      }
      return next;
    });
  }, [dictionary]);

  const filteredAndSortedDictionary = useMemo(() => {
    let result = [...dictionary];

    if (deferredSearchText.trim()) {
      const normalizedSearch = deferredSearchText.trim().toLowerCase();
      if (searchMode === 'description') {
        result = result.filter((r) =>
          (r.description ?? '').toLowerCase().includes(normalizedSearch),
        );
      } else {
        result = result.filter(
          (r) =>
            r.term.toLowerCase().includes(normalizedSearch) ||
            (r.translation ?? '').toLowerCase().includes(normalizedSearch),
        );
      }
    }

    if (categoryFilter) {
      result = result.filter((r) => r.category === categoryFilter);
    }

    if (sortOrder) {
      result.sort((a, b) => {
        const diff =
          (a.textBlockOccurrenceCount ?? 0) - (b.textBlockOccurrenceCount ?? 0);
        return sortOrder === 'asc' ? diff : -diff;
      });
    }

    return result;
  }, [dictionary, deferredSearchText, searchMode, categoryFilter, sortOrder]);

  const dirtyTerms = useMemo(() => {
    const dirty: Array<{
      term: string;
      from?: string;
      translation: string;
      description?: string;
    }> = [];
    for (const record of dictionary) {
      const key = getRowKey(record);
      const draft = draftDictionary[key];
      if (!draft) continue;
      if (
        draft.translation !== (record.translation ?? '') ||
        draft.description !== (record.description ?? '')
      ) {
        dirty.push({
          term: record.term,
          from: record.from ?? undefined,
          translation: draft.translation,
          description: draft.description || undefined,
        });
      }
    }
    return dirty;
  }, [dictionary, draftDictionary]);

  const handleSaveAllChanges = useCallback(async () => {
    if (dirtyTerms.length === 0 || saving) return;
    setSaving(true);
    try {
      await onSaveDictionaryTerms(dirtyTerms);
      setDraftDictionary({});
      message.success(`已保存 ${dirtyTerms.length} 个术语变更`);
    } finally {
      setSaving(false);
    }
  }, [dirtyTerms, saving, onSaveDictionaryTerms, message]);

  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (dirtyTerms.length > 0 && !saving) {
          void handleSaveAllChanges();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, dirtyTerms.length, saving, handleSaveAllChanges]);

  const readDraftTranslation = useCallback(
    (record: GlossaryTerm) => {
      const key = getRowKey(record);
      return draftDictionary[key]?.translation ?? record.translation ?? '';
    },
    [draftDictionary],
  );

  const readDraftDescription = useCallback(
    (record: GlossaryTerm) => {
      const key = getRowKey(record);
      return draftDictionary[key]?.description ?? record.description ?? '';
    },
    [draftDictionary],
  );

  const updateDraftTranslation = useCallback(
    (record: GlossaryTerm, value: string) => {
      const key = getRowKey(record);
      setDraftDictionary((prev) => ({
        ...prev,
        [key]: {
          translation: value,
          description: prev[key]?.description ?? record.description ?? '',
        },
      }));
    },
    [],
  );

  const updateDraftDescription = useCallback(
    (record: GlossaryTerm, value: string) => {
      const key = getRowKey(record);
      setDraftDictionary((prev) => ({
        ...prev,
        [key]: {
          translation: prev[key]?.translation ?? record.translation ?? '',
          description: value,
        },
      }));
    },
    [],
  );

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

  const handleDeleteTerms = async (keys: string[]) => {
    if (keys.length === 0) {
      return;
    }

    await onDeleteDictionary(keys);
    setSelectedKeys((current) => current.filter((key) => !keys.includes(key)));
  };

  const toggleSelectionMode = () => {
    setSelectionMode((current) => {
      if (current) {
        setSelectedKeys([]);
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
    const availableKeys = new Set(dictionary.map(getRowKey));
    setSelectedKeys((current) => current.filter((key) => availableKeys.has(key)));
  }, [dictionary]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(filteredAndSortedDictionary.length / dictionaryPageSize));
    setDictionaryPage((current) => Math.min(current, totalPages));
  }, [filteredAndSortedDictionary.length, dictionaryPageSize]);

  usePollingTask({
    enabled: active,
    intervalMs: 5_000,
    task: async () => {
      await onRefreshDictionary();
    },
  });

  const searchPending = searchText !== deferredSearchText;

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
            {dirtyTerms.length > 0 ? (
              <Badge count={dirtyTerms.length} overflowCount={99}>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  loading={saving}
                  onClick={() => void handleSaveAllChanges()}
                >
                  保存变更
                </Button>
              </Badge>
            ) : (
              <Button
                icon={<SaveOutlined />}
                disabled
              >
                保存变更
              </Button>
            )}
            <Button onClick={toggleSelectionMode}>
              {selectionMode ? '退出多选' : '多选删除'}
            </Button>
            {selectionMode ? (
              <Button
                danger
                disabled={selectedKeys.length === 0}
                onClick={() => void handleDeleteTerms(selectedKeys)}
              >
                删除选中（{selectedKeys.length}）
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
        <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Input
            prefix={<SearchOutlined />}
            placeholder="搜索术语..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            style={{ width: 220 }}
            allowClear
            suffix={searchPending ? <span style={{ color: '#999', fontSize: 12 }}>...</span> : undefined}
          />
          <Radio.Group
            size="small"
            value={searchMode}
            onChange={(e) => setSearchMode(e.target.value)}
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button value="termTranslation">术语 / 译文</Radio.Button>
            <Radio.Button value="description">描述</Radio.Button>
          </Radio.Group>
          <Select
            allowClear
            placeholder="类别筛选"
            value={categoryFilter}
            onChange={(value) => setCategoryFilter(value)}
            style={{ width: 130 }}
            options={CATEGORY_FILTER_OPTIONS}
          />
          <Tooltip title={sortOrder === 'asc' ? '按出现次数升序' : sortOrder === 'desc' ? '按出现次数降序' : '按出现次数排序'}>
            <Button
              size="small"
              icon={
                sortOrder === 'asc' ? <SortAscendingOutlined /> :
                sortOrder === 'desc' ? <SortDescendingOutlined /> :
                <SortAscendingOutlined />
              }
              onClick={() =>
                setSortOrder((prev) =>
                  prev === null ? 'asc' : prev === 'asc' ? 'desc' : null,
                )
              }
              type={sortOrder ? 'primary' : 'default'}
            >
              {sortOrder ? `次数${sortOrder === 'asc' ? '↑' : '↓'}` : '次数'}
            </Button>
          </Tooltip>
        </div>
        <Table
          rowKey={getRowKey}
          dataSource={filteredAndSortedDictionary}
          pagination={{
            current: dictionaryPage,
            pageSize: dictionaryPageSize,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50, 100],
            showTotal: (total, range) => `${range[0]}-${range[1]} / ${total}`,
            onChange: (page, pageSize) => {
              setDictionaryPage(page);
              setDictionaryPageSize(pageSize);
            },
          }}
          rowSelection={
            selectionMode
              ? {
                  selectedRowKeys: selectedKeys,
                  onChange: (selectedRowKeys) => {
                    setSelectedKeys(selectedRowKeys.map((key) => String(key)));
                  },
                }
              : undefined
          }
          columns={[
            { title: '术语', dataIndex: 'term', width: 140 },
            {
              title: '译文',
              dataIndex: 'translation',
              width: 180,
              render: (_: unknown, record: GlossaryTerm) => (
                <TextArea
                  autoSize={{ minRows: 1, maxRows: 2 }}
                  value={readDraftTranslation(record)}
                  onChange={(e) => updateDraftTranslation(record, e.target.value)}
                  placeholder="输入译文"
                />
              ),
            },
            {
              title: '出自',
              dataIndex: 'from',
              width: 100,
              render: (value: string | undefined) => value ?? '-',
            },
            {
              title: '类别',
              dataIndex: 'category',
              width: 110,
              render: (value: string | undefined) => (value ? <Tag>{value}</Tag> : '-'),
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 90,
              render: (value: string | undefined) =>
                value ? (
                  <Tag color={value === 'translated' ? 'green' : 'gold'}>{value}</Tag>
                ) : (
                  '-'
                ),
            },
            {
              title: '出现次数',
              width: 100,
              render: (_, record: GlossaryTerm) =>
                `${record.totalOccurrenceCount ?? 0} / ${record.textBlockOccurrenceCount ?? 0}`,
            },
            {
              title: '描述',
              dataIndex: 'description',
              width: 200,
              render: (_: unknown, record: GlossaryTerm) => (
                <TextArea
                  autoSize={{ minRows: 1, maxRows: 2 }}
                  value={readDraftDescription(record)}
                  onChange={(e) => updateDraftDescription(record, e.target.value)}
                  placeholder="输入描述"
                />
              ),
            },
            {
              title: '操作',
              width: 140,
              render: (_, record: GlossaryTerm) => (
                <Space>
                  <Button type="link" onClick={() => onOpenDictionaryEditor(record)}>
                    编辑
                  </Button>
                  <Button
                    type="link"
                    danger
                    onClick={() => void handleDeleteTerms([getRowKey(record)])}
                  >
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
            message="支持 term / translation / from / description / category 五列"
            description="from 为可选列（用于角色说出某人称时的特定翻译），category 和 description 可留空；导入后会按当前项目文本自动重算出现次数统计。"
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
            placeholder="term,translation,description,category"
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
