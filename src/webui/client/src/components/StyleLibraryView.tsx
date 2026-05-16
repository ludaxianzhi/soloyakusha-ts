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
  const [catalog, setCatalog] = useState<StyleLibraryCatalog>({ libraries: [] });
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

  useEffect(() => {
    void refreshData();
  }, []);

  const refreshData = async () => {
    setLoading(true);
    try {
      const libraries = await api.getStyleLibraries();
      setCatalog(libraries);
    } catch (error) {
      message.error(toErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  const handleCreateLibrary = async (values: CreateStyleLibraryFormValues) => {
    const name = values.name.trim();
    if (!name) {
      message.error('风格库名称不能为空');
      return;
    }

    const payload: CreateStyleLibraryInput = {
      displayName: optionalTrim(values.displayName),
      targetLanguage: values.targetLanguage,
      chunkLength: Number(values.chunkLength),
      managedByApp: true,
    };

    setSaving(true);
    try {
      await api.saveStyleLibrary(name, payload);
      message.success('风格库已保存');
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

  const handleDelete = async (library: StyleLibrarySummary) => {
    try {
      await api.deleteStyleLibrary(library.name);
      message.success('风格库已删除');
      if (searchTarget?.name === library.name) {
        setSearchTarget(null);
        setQueryResult(null);
      }
      await refreshData();
    } catch (error) {
      message.error(toErrorMessage(error));
    }
  };

  const columns = [
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
      title: '语言',
      key: 'language',
      render: (_: unknown, record: StyleLibrarySummary) => (
        <Text>{record.targetLanguage ?? '未知'}</Text>
      ),
    },
    {
      title: '切分长度',
      key: 'chunkLength',
      render: (_: unknown, record: StyleLibrarySummary) => (
        <Text>{record.chunkLength ?? '-'}</Text>
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
            title="删除风格库"
            description="将同时删除对应的向量集合，确认删除？"
            onConfirm={() => void handleDelete(record)}
          >
            <Button type="text" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
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
              onClick={() => setIsCreateModalVisible(true)}
            >
              新建风格库
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => void refreshData()} loading={loading}>
              刷新
            </Button>
          </Space>
        </div>
      </Card>

      {/* Library Table */}
      <Card bodyStyle={{ paddingTop: 0 }}>
        <Table
          dataSource={catalog.libraries}
          columns={columns}
          rowKey="name"
          loading={loading}
          pagination={{ pageSize: 10 }}
          locale={{ emptyText: <Empty description="还没有风格库，请点击上方新建" /> }}
        />
      </Card>

      {/* Create Modal */}
      <Modal
        title="新建风格库"
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
          <Form.Item name="name" label="风格库名称" rules={[{ required: true, message: '请输入风格库名称' }]}>
            <Input placeholder="例如：campus-style" />
          </Form.Item>
          <Form.Item name="displayName" label="显示名称">
            <Input placeholder="例如：校园叙事风格" />
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
              注意：该风格库当前已有 {importTarget.sourceSummary.chunkCount ?? 0} 个切片。导入新文件会增加其切片数量。
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
              placeholder={`输入待检索文本。文本会按该风格库设置的 ${searchTarget?.chunkLength || 400} 字符长度自动切分，并为每段返回匹配结果。`}
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
