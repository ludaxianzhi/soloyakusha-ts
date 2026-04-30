import { useEffect, useMemo, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
} from 'antd';
import {
  DeleteOutlined,
  ImportOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { api } from '../app/api.ts';
import { IMPORT_FORMAT_OPTIONS, toErrorMessage } from '../app/ui-helpers.ts';
import type {
  CreateStyleLibraryInput,
  StyleLibraryCatalog,
  StyleLibraryQueryResult,
  StyleLibrarySummary,
} from '../app/types.ts';

const { Paragraph, Text, Title } = Typography;
const { TextArea } = Input;

export function StyleLibraryView() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<CreateStyleLibraryFormValues>();
  const [catalog, setCatalog] = useState<StyleLibraryCatalog>({ libraries: [], discoveryErrors: {} });
  const [vectorStoreNames, setVectorStoreNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [querying, setQuerying] = useState(false);
  
  // Modals state
  const [isCreateModalVisible, setIsCreateModalVisible] = useState(false);
  const [importTarget, setImportTarget] = useState<StyleLibrarySummary | null>(null);
  const [searchTarget, setSearchTarget] = useState<StyleLibrarySummary | null>(null);

  // Import state
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importFormatName, setImportFormatName] = useState<string>('');

  // Search state
  const [queryText, setQueryText] = useState('');
  const [queryResult, setQueryResult] = useState<StyleLibraryQueryResult | null>(null);

  const registeredLibraries = useMemo(
    () => catalog.libraries.filter((library) => library.source === 'registered'),
    [catalog.libraries],
  );
  const discoveredLibraries = useMemo(
    () => catalog.libraries.filter((library) => library.source === 'discovered'),
    [catalog.libraries],
  );

  useEffect(() => {
    void refreshData();
  }, []);

  const refreshData = async () => {
    setLoading(true);
    try {
      const [libraries, vectorStores] = await Promise.all([
        api.getStyleLibraries(),
        api.getStyleLibraryVectorStores(),
      ]);
      setCatalog(libraries);
      setVectorStoreNames(vectorStores.names);
      form.setFieldValue('vectorStoreName', form.getFieldValue('vectorStoreName') ?? vectorStores.names[0]);
    } catch (error) {
      message.error(toErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  const handleCreateLibrary = async (values: CreateStyleLibraryFormValues) => {
    const name = values.name.trim();
    if (!name) {
      message.error('样式库名称不能为空');
      return;
    }

    const payload: CreateStyleLibraryInput = {
      displayName: optionalTrim(values.displayName),
      vectorStoreName: values.vectorStoreName,
      collectionName: optionalTrim(values.collectionName),
      targetLanguage: values.targetLanguage,
      chunkLength: Number(values.chunkLength),
      managedByApp: true,
    };

    setSaving(true);
    try {
      await api.saveStyleLibrary(name, payload);
      message.success('样式库已保存');
      setIsCreateModalVisible(false);
      form.resetFields();
      await refreshData();
    } catch (error) {
      message.error(toErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const handleImport = async () => {
    if (!importTarget || !importFile) {
      message.error('请先选择要导入的文件');
      return;
    }

    setImporting(true);
    try {
      const result = await api.importStyleLibrary(importTarget.name, {
        file: importFile,
        formatName: importFormatName || undefined,
      });
      message.success(`已导入 ${result.chunkCount} 个风格块`);
      setImportFile(null);
      setImportFormatName('');
      setImportTarget(null);
      await refreshData();
    } catch (error) {
      message.error(toErrorMessage(error));
    } finally {
      setImporting(false);
    }
  };

  const handleQuery = async () => {
    if (!searchTarget || !queryText.trim()) {
      message.error('请输入查询文本');
      return;
    }

    setQuerying(true);
    try {
      setQueryResult(await api.queryStyleLibrary(searchTarget.name, queryText));
    } catch (error) {
      message.error(toErrorMessage(error));
    } finally {
      setQuerying(false);
    }
  };

  const handleDeleteRegistered = async (library: StyleLibrarySummary) => {
    try {
      await api.deleteStyleLibrary(library.name, true);
      message.success('样式库已删除');
      if (searchTarget?.name === library.name) {
        setSearchTarget(null);
        setQueryResult(null);
      }
      await refreshData();
    } catch (error) {
      message.error(toErrorMessage(error));
    }
  };

  const handleDeleteDiscovered = async (library: StyleLibrarySummary) => {
    try {
      await api.deleteExternalStyleLibrary({
        vectorStoreName: library.vectorStoreName,
        collectionName: library.collectionName,
      });
      message.success('外部风格库集合已删除');
      await refreshData();
    } catch (error) {
      message.error(toErrorMessage(error));
    }
  };

  const registeredColumns = [
    {
      title: '名称',
      key: 'name',
      render: (_: unknown, record: StyleLibrarySummary) => (
        <Space direction="vertical" size={2}>
          <Text strong>{record.displayName || record.name}</Text>
          {record.displayName && <Text type="secondary" style={{ fontSize: '12px' }}>{record.name}</Text>}
        </Space>
      ),
    },
    {
      title: '向量库 / 集合',
      key: 'vectorStore',
      render: (_: unknown, record: StyleLibrarySummary) => (
        <Space direction="vertical" size={2}>
          <Text>{record.vectorStoreName}</Text>
          <Text type="secondary" style={{ fontSize: '12px' }}>{record.collectionName}</Text>
          {!record.existsInVectorStore && <Tag color="warning">集合未发现</Tag>}
        </Space>
      ),
    },
    {
      title: '切分配置',
      key: 'config',
      render: (_: unknown, record: StyleLibrarySummary) => (
        <Space direction="vertical" size={2}>
          <Text>{record.targetLanguage ?? '未知语言'}</Text>
          <Text type="secondary" style={{ fontSize: '12px' }}>长度: {record.chunkLength ?? '-'}</Text>
        </Space>
      ),
    },
    {
      title: '数据量',
      key: 'stats',
      render: (_: unknown, record: StyleLibrarySummary) => {
        if (!record.sourceSummary) return <Text type="secondary">暂无数据</Text>;
        return (
          <Space direction="vertical" size={2}>
            <Text>{record.sourceSummary.chunkCount ?? 0} 个切片</Text>
            <Text type="secondary" style={{ fontSize: '12px' }}>{record.sourceSummary.fileCount ?? 0} 个来源</Text>
          </Space>
        );
      },
    },
    {
      title: '状态',
      key: 'status',
      render: (_: unknown, record: StyleLibrarySummary) => (
        <Space direction="vertical" size={2}>
          {renderEmbeddingTag(record)}
          {record.invalidationReason && (
            <Text type="danger" style={{ fontSize: '12px' }}>{record.invalidationReason}</Text>
          )}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: unknown, record: StyleLibrarySummary) => (
        <Space>
          <Button
            type="text"
            icon={<ImportOutlined />}
            onClick={() => setImportTarget(record)}
            disabled={record.embeddingState === 'invalid'}
          >
            导入
          </Button>
          <Button
            type="text"
            icon={<SearchOutlined />}
            onClick={() => {
              setSearchTarget(record);
              setQueryText('');
              setQueryResult(null);
            }}
            disabled={record.embeddingState === 'invalid'}
          >
            查询
          </Button>
          <Popconfirm
            title="删除样式库"
            description="将同时删除注册表项和对应的向量集合，确认删除？"
            onConfirm={() => void handleDeleteRegistered(record)}
          >
            <Button type="text" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const discoveredColumns = [
    {
      title: '名称',
      key: 'name',
      render: (_: unknown, record: StyleLibrarySummary) => <Text strong>{record.name}</Text>,
    },
    {
      title: '向量库 / 集合',
      key: 'vectorStore',
      render: (_: unknown, record: StyleLibrarySummary) => (
        <Space direction="vertical" size={2}>
          <Text>{record.vectorStoreName}</Text>
          <Text type="secondary" style={{ fontSize: '12px' }}>{record.collectionName}</Text>
        </Space>
      ),
    },
    {
      title: '状态',
      key: 'status',
      render: (_: unknown, record: StyleLibrarySummary) => (
        <Space direction="vertical" size={2}>
          {renderEmbeddingTag(record)}
          {record.invalidationReason && (
            <Text type="danger" style={{ fontSize: '12px' }}>{record.invalidationReason}</Text>
          )}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: unknown, record: StyleLibrarySummary) => (
        <Popconfirm
          title="删除外部集合"
          description="此操作只删除向量数据库中的 collection，不会删除任何注册表项。"
          onConfirm={() => void handleDeleteDiscovered(record)}
        >
          <Button type="text" danger icon={<DeleteOutlined />}>删除</Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* Header */}
      <Card bodyStyle={{ padding: '16px 24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <Title level={4} style={{ margin: 0 }}>风格库</Title>
            <Paragraph type="secondary" style={{ margin: '4px 0 0 0' }}>
              管理全局风格库、导入文本或压缩包，并在接入翻译流程前预览风格检索结果。
            </Paragraph>
          </div>
          <Space>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                form.setFieldValue('vectorStoreName', vectorStoreNames[0]);
                setIsCreateModalVisible(true);
              }}
            >
              新建样式库
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => void refreshData()} loading={loading}>
              刷新
            </Button>
          </Space>
        </div>
      </Card>

      {/* Main Content */}
      <Card bodyStyle={{ paddingTop: 0 }}>
        <Tabs
          items={[
            {
              key: 'registered',
              label: `已注册样式库 (${registeredLibraries.length})`,
              children: (
                <Table
                  dataSource={registeredLibraries}
                  columns={registeredColumns}
                  rowKey="name"
                  loading={loading}
                  pagination={{ pageSize: 10 }}
                  locale={{ emptyText: <Empty description="还没有已注册的样式库，请点击上方新建" /> }}
                />
              ),
            },
            {
              key: 'discovered',
              label: `已发现外部集合 (${discoveredLibraries.length})`,
              children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {Object.keys(catalog.discoveryErrors).length > 0 && (
                    <Space direction="vertical" size={4} style={{ marginBottom: 12 }}>
                      {Object.entries(catalog.discoveryErrors).map(([storeName, error]) => (
                        <Text key={storeName} type="danger">{storeName}: {error}</Text>
                      ))}
                    </Space>
                  )}
                  <Table
                    dataSource={discoveredLibraries}
                    columns={discoveredColumns}
                    rowKey={(record) => `${record.vectorStoreName}:${record.collectionName}`}
                    loading={loading}
                    pagination={{ pageSize: 10 }}
                    locale={{ emptyText: <Empty description="当前没有发现未注册的外部样式库集合" /> }}
                  />
                </Space>
              ),
            },
          ]}
        />
      </Card>

      {/* Create Modal */}
      <Modal
        title="新建样式库"
        open={isCreateModalVisible}
        onOk={() => form.submit()}
        onCancel={() => {
          setIsCreateModalVisible(false);
          form.resetFields();
        }}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            targetLanguage: 'zh-CN',
            chunkLength: 400,
          }}
          onFinish={(values) => void handleCreateLibrary(values)}
          style={{ marginTop: 16 }}
        >
          <Form.Item name="name" label="样式库名称" rules={[{ required: true, message: '请输入样式库名称' }]}>
            <Input placeholder="例如：campus-style" />
          </Form.Item>
          <Form.Item name="displayName" label="显示名称">
            <Input placeholder="例如：校园叙事风格" />
          </Form.Item>
          <Form.Item name="vectorStoreName" label="向量数据库" rules={[{ required: true, message: '请选择向量数据库' }]}>
            <Select
              options={vectorStoreNames.map((name) => ({ label: name, value: name }))}
              placeholder={vectorStoreNames.length === 0 ? '请先在系统设置中配置向量数据库' : '请选择向量数据库'}
            />
          </Form.Item>
          <Form.Item name="collectionName" label="Collection 名称" tooltip="留空时按规则自动生成">
            <Input placeholder="建议留空，自动生成 stylelib__ 前缀名称" />
          </Form.Item>
          <div style={{ display: 'flex', gap: '16px' }}>
            <Form.Item name="targetLanguage" label="目标语言" rules={[{ required: true, message: '请输入目标语言' }]} style={{ flex: 1 }}>
              <Input placeholder="zh-CN" />
            </Form.Item>
            <Form.Item name="chunkLength" label="切分长度" rules={[{ required: true, message: '请输入切分长度' }]} style={{ flex: 1 }}>
              <Input type="number" min={1} />
            </Form.Item>
          </div>
        </Form>
      </Modal>

      {/* Import Modal */}
      <Modal
        title={`导入语料 - ${importTarget?.displayName || importTarget?.name}`}
        open={!!importTarget}
        onCancel={() => {
          setImportTarget(null);
          setImportFile(null);
          setImportFormatName('');
        }}
        onOk={() => void handleImport()}
        confirmLoading={importing}
        okText="开始导入"
        okButtonProps={{ disabled: !importFile }}
        destroyOnClose
      >
        <Space direction="vertical" size={16} style={{ width: '100%', marginTop: 16 }}>
          <div>
            <Text strong>选择文件：</Text>
            <div style={{ marginTop: 8 }}>
              <Upload
                beforeUpload={(file) => {
                  setImportFile(file);
                  return false;
                }}
                maxCount={1}
                fileList={importFile ? [importFile as any] : []}
                onRemove={() => setImportFile(null)}
              >
                <Button icon={<UploadOutlined />}>选择单文件或 ZIP 压缩包</Button>
              </Upload>
            </div>
          </div>
          <div>
            <Text strong>解析格式：</Text>
            <div style={{ marginTop: 8 }}>
              <Select
                style={{ width: '100%' }}
                value={importFormatName}
                onChange={setImportFormatName}
                options={IMPORT_FORMAT_OPTIONS}
                placeholder="默认自动识别"
                allowClear
              />
            </div>
          </div>
          {importTarget?.sourceSummary ? (
            <Text type="secondary">
              注意：该样式库当前已有 {importTarget.sourceSummary.chunkCount ?? 0} 个切片。导入新文件会增加其切片数量。
            </Text>
          ) : null}
        </Space>
      </Modal>

      {/* Search Drawer */}
      <Drawer
        title={
          <Space>
            <span>预览查询</span>
            <Tag color="blue">{searchTarget?.displayName || searchTarget?.name}</Tag>
          </Space>
        }
        placement="right"
        width={700}
        onClose={() => setSearchTarget(null)}
        open={!!searchTarget}
        destroyOnClose
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Text strong>请输入查询片段</Text>
            <TextArea
              rows={4}
              value={queryText}
              onChange={(event) => setQueryText(event.target.value)}
              placeholder={`输入待检索文本。文本会按该样式库设置的 ${searchTarget?.chunkLength || 400} 字符长度自动切分，并为每段返回匹配结果。`}
            />
            <Button
              type="primary"
              icon={<SearchOutlined />}
              loading={querying}
              onClick={() => void handleQuery()}
              style={{ alignSelf: 'flex-start' }}
            >
              检索
            </Button>
          </Space>

          {queryResult ? (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text strong>检索结果</Text>
                <Tag color="cyan">共 {queryResult.matches.length} 条命中记录</Tag>
              </div>
              <Table
                size="middle"
                pagination={false}
                bordered
                rowKey={(record) => `${record.chunkIndex}:${record.text}`}
                dataSource={queryResult.chunks}
                columns={[
                  {
                    title: '查询切分',
                    dataIndex: 'text',
                    width: '40%',
                    render: (value: string, record) => (
                      <Space direction="vertical" size={4}>
                        <Text type="secondary" style={{ fontSize: 12 }}>分片 #{record.chunkIndex + 1} ({record.charCount} 字符)</Text>
                        <Text>{value}</Text>
                      </Space>
                    ),
                  },
                  {
                    title: '最匹配风格示例',
                    dataIndex: 'matches',
                    render: (matches: StyleLibraryQueryResult['chunks'][number]['matches']) => {
                      const topMatch = matches[0];
                      if (!topMatch) {
                        return <Text type="secondary">无命中</Text>;
                      }
                      return (
                        <Space direction="vertical" size={4}>
                          <Tag bordered={false} color="success">相关度: {topMatch.score.toFixed(4)}</Tag>
                          <Text>{topMatch.document ?? '-'}</Text>
                        </Space>
                      );
                    },
                  },
                ]}
              />
            </Space>
          ) : (
            <Empty description="请输入文本后点击检索" style={{ marginTop: 40 }} />
          )}
        </Space>
      </Drawer>
    </Space>
  );
}

type CreateStyleLibraryFormValues = {
  name: string;
  displayName?: string;
  vectorStoreName: string;
  collectionName?: string;
  targetLanguage: string;
  chunkLength: number;
};

function optionalTrim(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function renderEmbeddingTag(library: StyleLibrarySummary) {
  if (library.embeddingState === 'compatible') {
    return <Tag color="success">配置有效</Tag>;
  }
  if (library.embeddingState === 'invalid') {
    return <Tag color="error">配置错误</Tag>;
  }
  return <Tag color="warning">状态未知</Tag>;
}