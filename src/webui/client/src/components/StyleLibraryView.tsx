import { useEffect, useMemo, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  List,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { DeleteOutlined, ReloadOutlined, SearchOutlined, UploadOutlined } from '@ant-design/icons';
import { api, ApiError } from '../app/api.ts';
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
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importFormatName, setImportFormatName] = useState<string>('');
  const [selectedLibraryName, setSelectedLibraryName] = useState<string>();
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
  const selectedLibrary = registeredLibraries.find((library) => library.name === selectedLibraryName);

  useEffect(() => {
    void refreshData();
  }, []);

  useEffect(() => {
    if (!selectedLibraryName && registeredLibraries[0]?.name) {
      setSelectedLibraryName(registeredLibraries[0].name);
    }
  }, [registeredLibraries, selectedLibraryName]);

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
      setSelectedLibraryName(name);
      form.setFieldValue('name', name);
      await refreshData();
    } catch (error) {
      message.error(toErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const handleImport = async () => {
    if (!selectedLibraryName || !importFile) {
      message.error('请先选择样式库并选择要导入的文件');
      return;
    }

    setImporting(true);
    try {
      const result = await api.importStyleLibrary(selectedLibraryName, {
        file: importFile,
        formatName: importFormatName || undefined,
      });
      message.success(`已导入 ${result.chunkCount} 个风格块`);
      setImportFile(null);
      setImportFormatName('');
      await refreshData();
    } catch (error) {
      message.error(toErrorMessage(error));
    } finally {
      setImporting(false);
    }
  };

  const handleQuery = async () => {
    if (!selectedLibraryName || !queryText.trim()) {
      message.error('请选择样式库并输入查询文本');
      return;
    }

    setQuerying(true);
    try {
      setQueryResult(await api.queryStyleLibrary(selectedLibraryName, queryText));
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
      if (selectedLibraryName === library.name) {
        setSelectedLibraryName(undefined);
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

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        loading={loading}
        title={<Title level={4} style={{ margin: 0 }}>风格库</Title>}
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void refreshData()}>
            刷新
          </Button>
        }
      >
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          管理全局风格库、导入文本或压缩包，并在接入翻译流程前预览风格检索结果。
        </Paragraph>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={10}>
          <Card title="创建或更新样式库" loading={loading}>
            <Form
              form={form}
              layout="vertical"
              initialValues={{
                targetLanguage: 'zh-CN',
                chunkLength: 400,
                vectorStoreName: vectorStoreNames[0],
              }}
              onFinish={(values) => void handleCreateLibrary(values)}
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
              <Form.Item name="collectionName" label="Collection 名称">
                <Input placeholder="留空时自动生成 stylelib__ 前缀名称" />
              </Form.Item>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item name="targetLanguage" label="目标语言" rules={[{ required: true, message: '请输入目标语言' }]}>
                    <Input placeholder="zh-CN" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item
                    name="chunkLength"
                    label="切分长度"
                    rules={[{ required: true, message: '请输入切分长度' }]}
                  >
                    <Input type="number" min={1} />
                  </Form.Item>
                </Col>
              </Row>
              <Button type="primary" htmlType="submit" loading={saving} disabled={vectorStoreNames.length === 0}>
                保存样式库
              </Button>
            </Form>
          </Card>
        </Col>

        <Col xs={24} xl={14}>
          <Card title="已注册样式库" loading={loading}>
            {registeredLibraries.length === 0 ? (
              <Empty description="还没有已注册的样式库" />
            ) : (
              <List
                dataSource={registeredLibraries}
                renderItem={(library) => (
                  <List.Item
                    actions={[
                      <Button key="select" type={library.name === selectedLibraryName ? 'primary' : 'default'} onClick={() => setSelectedLibraryName(library.name)}>
                        {library.name === selectedLibraryName ? '当前使用' : '选择'}
                      </Button>,
                      <Popconfirm
                        key="delete"
                        title="删除样式库"
                        description="将同时删除注册表项和对应向量集合。"
                        onConfirm={() => void handleDeleteRegistered(library)}
                      >
                        <Button danger icon={<DeleteOutlined />} />
                      </Popconfirm>,
                    ]}
                  >
                    <List.Item.Meta
                      title={<Space wrap><span>{library.displayName || library.name}</span>{renderEmbeddingTag(library)}</Space>}
                      description={
                        <Space direction="vertical" size={4}>
                          <Text type="secondary">{library.vectorStoreName} / {library.collectionName}</Text>
                          <Space wrap>
                            <Tag>{library.targetLanguage ?? '未设置目标语言'}</Tag>
                            <Tag>chunk {library.chunkLength ?? '-'}</Tag>
                            {!library.existsInVectorStore && <Tag color="warning">集合未发现</Tag>}
                          </Space>
                          {library.invalidationReason ? <Text type="danger">{library.invalidationReason}</Text> : null}
                        </Space>
                      }
                    />
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <Card title="导入语料" extra={selectedLibrary ? <Tag color="blue">{selectedLibrary.name}</Tag> : null}>
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Select
                value={selectedLibraryName}
                onChange={setSelectedLibraryName}
                options={registeredLibraries.map((library) => ({ label: library.displayName || library.name, value: library.name }))}
                placeholder="选择要导入的样式库"
              />
              <Select
                value={importFormatName}
                onChange={setImportFormatName}
                options={IMPORT_FORMAT_OPTIONS}
                placeholder="格式自动识别"
              />
              <Upload
                beforeUpload={(file) => {
                  setImportFile(file);
                  return false;
                }}
                maxCount={1}
                showUploadList={{ showRemoveIcon: true }}
                onRemove={() => {
                  setImportFile(null);
                }}
              >
                <Button icon={<UploadOutlined />}>选择单文件或 ZIP</Button>
              </Upload>
              <Button
                type="primary"
                onClick={() => void handleImport()}
                loading={importing}
                disabled={!selectedLibrary || selectedLibrary.embeddingState === 'invalid'}
              >
                导入到当前样式库
              </Button>
              {selectedLibrary?.sourceSummary ? (
                <Text type="secondary">
                  最近一次导入：{selectedLibrary.sourceSummary.fileCount ?? 0} 个文件，{selectedLibrary.sourceSummary.chunkCount ?? 0} 个块。
                </Text>
              ) : null}
            </Space>
          </Card>
        </Col>

        <Col xs={24} xl={12}>
          <Card title="检索预览" extra={queryResult ? <Tag color="cyan">{queryResult.matches.length} 条命中</Tag> : null}>
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Select
                value={selectedLibraryName}
                onChange={setSelectedLibraryName}
                options={registeredLibraries.map((library) => ({ label: library.displayName || library.name, value: library.name }))}
                placeholder="选择要检索的样式库"
              />
              <TextArea
                rows={6}
                value={queryText}
                onChange={(event) => setQueryText(event.target.value)}
                placeholder="输入待检索文本。文本会按样式库 chunkLength 自动切分，并为每段返回 1 条最近邻结果。"
              />
              <Button
                type="primary"
                icon={<SearchOutlined />}
                loading={querying}
                onClick={() => void handleQuery()}
                disabled={!selectedLibrary || selectedLibrary.embeddingState === 'invalid'}
              >
                预览检索
              </Button>
              {queryResult ? (
                <Table
                  size="small"
                  pagination={false}
                  rowKey={(record) => `${record.chunkIndex}:${record.text}`}
                  dataSource={queryResult.chunks}
                  columns={[
                    {
                      title: '查询块',
                      dataIndex: 'text',
                      render: (value: string, record) => (
                        <Space direction="vertical" size={2}>
                          <Text>{value}</Text>
                          <Text type="secondary">chunk #{record.chunkIndex + 1} / {record.charCount} chars</Text>
                        </Space>
                      ),
                    },
                    {
                      title: '命中风格示例',
                      dataIndex: 'matches',
                      render: (matches: StyleLibraryQueryResult['chunks'][number]['matches']) => {
                        const topMatch = matches[0];
                        if (!topMatch) {
                          return <Text type="secondary">无命中</Text>;
                        }

                        return (
                          <Space direction="vertical" size={2}>
                            <Text>{topMatch.document ?? '-'}</Text>
                            <Text type="secondary">score {topMatch.score.toFixed(4)}</Text>
                          </Space>
                        );
                      },
                    },
                  ]}
                />
              ) : (
                <Empty description="还没有检索结果" />
              )}
            </Space>
          </Card>
        </Col>
      </Row>

      <Card title="已发现的外部样式库集合" loading={loading}>
        {Object.keys(catalog.discoveryErrors).length > 0 ? (
          <Space direction="vertical" size={4} style={{ marginBottom: 12 }}>
            {Object.entries(catalog.discoveryErrors).map(([storeName, error]) => (
              <Text key={storeName} type="danger">{storeName}: {error}</Text>
            ))}
          </Space>
        ) : null}
        {discoveredLibraries.length === 0 ? (
          <Empty description="当前没有发现未注册的外部样式库集合" />
        ) : (
          <List
            dataSource={discoveredLibraries}
            renderItem={(library) => (
              <List.Item
                actions={[
                  <Popconfirm
                    key="delete"
                    title="删除外部集合"
                    description="此操作只删除向量数据库中的 collection，不会删除任何注册表项。"
                    onConfirm={() => void handleDeleteDiscovered(library)}
                  >
                    <Button danger icon={<DeleteOutlined />} />
                  </Popconfirm>,
                ]}
              >
                <List.Item.Meta
                  title={<Space wrap><span>{library.name}</span>{renderEmbeddingTag(library)}</Space>}
                  description={
                    <Space direction="vertical" size={4}>
                      <Text type="secondary">{library.vectorStoreName} / {library.collectionName}</Text>
                      <Space wrap>
                        <Tag>{library.targetLanguage ?? '未知目标语言'}</Tag>
                        <Tag>chunk {library.chunkLength ?? '未知'}</Tag>
                      </Space>
                      {library.invalidationReason ? <Text type="danger">{library.invalidationReason}</Text> : null}
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Card>
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
    return <Tag color="success">嵌入兼容</Tag>;
  }
  if (library.embeddingState === 'invalid') {
    return <Tag color="error">嵌入失效</Tag>;
  }
  return <Tag color="warning">嵌入未知</Tag>;
}