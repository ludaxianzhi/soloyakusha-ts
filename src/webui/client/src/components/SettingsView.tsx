import { Button, Card, Col, Form, Input, Popconfirm, Row, Select, Space, Tabs, Tag } from 'antd';
import type { FormInstance } from 'antd';
import type {
  AlignmentRepairConfig,
  GlossaryExtractorConfig,
  GlossaryUpdaterConfig,
  LlmProfileConfig,
  PlotSummaryConfig,
  TranslatorEntry,
} from '../app/types.ts';

const { TextArea } = Input;

interface SettingsViewProps {
  settingsLoading: boolean;
  llmProfiles: Record<string, LlmProfileConfig>;
  defaultLlmName?: string;
  selectedLlmName?: string;
  selectedTranslatorName?: string;
  translators: Record<string, TranslatorEntry>;
  llmForm: FormInstance<Record<string, unknown>>;
  embeddingForm: FormInstance<Record<string, unknown>>;
  translatorForm: FormInstance<Record<string, unknown>>;
  extractorForm: FormInstance<Record<string, unknown>>;
  updaterForm: FormInstance<Record<string, unknown>>;
  plotForm: FormInstance<Record<string, unknown>>;
  alignmentForm: FormInstance<Record<string, unknown>>;
  onCreateLlmProfile: () => void;
  onSelectLlmProfile: (name: string) => void;
  onSaveLlmProfile: (values: Record<string, unknown>) => void | Promise<void>;
  onSetDefaultLlmProfile: () => void | Promise<void>;
  onDeleteLlmProfile: () => void | Promise<void>;
  onSaveEmbedding: (values: Record<string, unknown>) => void | Promise<void>;
  onCreateTranslator: () => void;
  onSelectTranslator: (name: string) => void;
  onSaveTranslator: (values: Record<string, unknown>) => void | Promise<void>;
  onDeleteTranslator: () => void | Promise<void>;
  onSaveAuxiliaryConfig: (
    kind: 'extractor' | 'updater' | 'plot' | 'alignment',
    values: Record<string, unknown>,
  ) => void | Promise<void>;
}

export function SettingsView({
  settingsLoading,
  llmProfiles,
  defaultLlmName,
  selectedLlmName,
  selectedTranslatorName,
  translators,
  llmForm,
  embeddingForm,
  translatorForm,
  extractorForm,
  updaterForm,
  plotForm,
  alignmentForm,
  onCreateLlmProfile,
  onSelectLlmProfile,
  onSaveLlmProfile,
  onSetDefaultLlmProfile,
  onDeleteLlmProfile,
  onSaveEmbedding,
  onCreateTranslator,
  onSelectTranslator,
  onSaveTranslator,
  onDeleteTranslator,
  onSaveAuxiliaryConfig,
}: SettingsViewProps) {
  const llmNames = Object.keys(llmProfiles);
  const translatorNames = Object.keys(translators);

  return (
    <Tabs
      defaultActiveKey="llm"
      items={[
        {
          key: 'llm',
          label: 'LLM Profiles',
          children: (
            <Row gutter={16}>
              <Col span={7}>
                <Card
                  title="Chat Profiles"
                  loading={settingsLoading}
                  extra={<Button onClick={onCreateLlmProfile}>新建</Button>}
                >
                  <Space direction="vertical" style={{ width: '100%' }}>
                    {llmNames.map((name) => (
                      <div
                        key={name}
                        onClick={() => onSelectLlmProfile(name)}
                        style={{
                          cursor: 'pointer',
                          background:
                            name === selectedLlmName
                              ? 'rgba(108,140,255,.12)'
                              : undefined,
                          padding: 12,
                          border: '1px solid rgba(255,255,255,0.08)',
                          borderRadius: 8,
                        }}
                      >
                        <Space>
                          <span>{name}</span>
                          {name === defaultLlmName && <Tag color="blue">默认</Tag>}
                        </Space>
                        <div>{llmProfiles[name]?.modelName}</div>
                      </div>
                    ))}
                  </Space>
                </Card>
              </Col>
              <Col span={17}>
                <Card title="编辑 Profile" loading={settingsLoading}>
                  <Form
                    form={llmForm}
                    layout="vertical"
                    className="compact-form"
                    onFinish={(values) => void onSaveLlmProfile(values)}
                  >
                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item
                          name="profileName"
                          label="Profile 名称"
                          rules={[{ required: true }]}
                        >
                          <Input />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item
                          name="provider"
                          label="Provider"
                          rules={[{ required: true }]}
                        >
                          <Select
                            options={[
                              { label: 'OpenAI Compatible', value: 'openai' },
                              { label: 'Anthropic', value: 'anthropic' },
                            ]}
                          />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="modelType" label="类型">
                          <Select
                            options={[{ label: 'chat', value: 'chat' }]}
                            disabled
                          />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item
                          name="modelName"
                          label="模型名"
                          rules={[{ required: true }]}
                        >
                          <Input />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item
                          name="endpoint"
                          label="Endpoint"
                          rules={[{ required: true }]}
                        >
                          <Input />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="apiKey" label="API Key">
                          <Input.Password />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="apiKeyEnv" label="API Key 环境变量">
                          <Input placeholder="例如 OPENAI_API_KEY" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item name="qps" label="QPS">
                          <Input type="number" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="maxParallelRequests" label="并发数">
                          <Input type="number" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="retries" label="重试次数">
                          <Input type="number" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Form.Item
                      name="defaultRequestConfigJson"
                      label="默认请求配置（JSON）"
                    >
                      <TextArea rows={5} />
                    </Form.Item>
                    <Space>
                      <Button type="primary" htmlType="submit">
                        保存 Profile
                      </Button>
                      {selectedLlmName && (
                        <>
                          <Button onClick={() => void onSetDefaultLlmProfile()}>
                            设为默认
                          </Button>
                          <Popconfirm
                            title="确认删除该 Profile？"
                            onConfirm={() => void onDeleteLlmProfile()}
                          >
                            <Button danger>删除</Button>
                          </Popconfirm>
                        </>
                      )}
                    </Space>
                  </Form>
                </Card>

                <Card title="Embedding 配置" loading={settingsLoading} className="mt-2">
                  <Form
                    form={embeddingForm}
                    layout="vertical"
                    className="compact-form"
                    onFinish={(values) => void onSaveEmbedding(values)}
                  >
                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item
                          name="provider"
                          label="Provider"
                          rules={[{ required: true }]}
                        >
                          <Select
                            options={[
                              { label: 'OpenAI Compatible', value: 'openai' },
                              { label: 'Anthropic', value: 'anthropic' },
                            ]}
                          />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item
                          name="modelName"
                          label="模型名"
                          rules={[{ required: true }]}
                        >
                          <Input />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item
                          name="endpoint"
                          label="Endpoint"
                          rules={[{ required: true }]}
                        >
                          <Input />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="apiKey" label="API Key">
                          <Input.Password />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="apiKeyEnv" label="API Key 环境变量">
                          <Input />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Button type="primary" htmlType="submit">
                      保存 Embedding
                    </Button>
                  </Form>
                </Card>
              </Col>
            </Row>
          ),
        },
        {
          key: 'translator',
          label: '翻译器',
          children: (
            <Row gutter={16}>
              <Col span={7}>
                <Card
                  title="翻译器列表"
                  loading={settingsLoading}
                  extra={<Button onClick={onCreateTranslator}>新建</Button>}
                >
                  <Space direction="vertical" style={{ width: '100%' }}>
                    {translatorNames.map((name) => (
                      <div
                        key={name}
                        onClick={() => onSelectTranslator(name)}
                        style={{
                          cursor: 'pointer',
                          background:
                            name === selectedTranslatorName
                              ? 'rgba(108,140,255,.12)'
                              : undefined,
                          padding: 12,
                          border: '1px solid rgba(255,255,255,0.08)',
                          borderRadius: 8,
                        }}
                      >
                        <div>{name}</div>
                        <div>{translators[name]?.modelName}</div>
                      </div>
                    ))}
                  </Space>
                </Card>
              </Col>
              <Col span={17}>
                <Card title="编辑翻译器" loading={settingsLoading}>
                  <Form
                    form={translatorForm}
                    layout="vertical"
                    className="compact-form"
                    onFinish={(values) => void onSaveTranslator(values)}
                  >
                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item
                          name="translatorName"
                          label="名称"
                          rules={[{ required: true }]}
                        >
                          <Input />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="type" label="工作流">
                          <Select
                            options={[
                              { label: 'default', value: 'default' },
                              { label: 'multi-stage', value: 'multi-stage' },
                            ]}
                          />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item
                          name="modelName"
                          label="默认模型"
                          rules={[{ required: true }]}
                        >
                          <Select
                            showSearch
                            options={llmNames.map((name) => ({
                              label: name,
                              value: name,
                            }))}
                          />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item name="reviewIterations" label="评审轮数">
                          <Input type="number" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="overlapChars" label="滑窗重叠字符数">
                          <Input type="number" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Form.Item name="requestOptionsJson" label="请求选项（JSON）">
                      <TextArea rows={5} />
                    </Form.Item>
                    <Form.Item name="modelsJson" label="步骤模型覆盖（JSON）">
                      <TextArea rows={5} />
                    </Form.Item>
                    <Space>
                      <Button type="primary" htmlType="submit">
                        保存翻译器
                      </Button>
                      {selectedTranslatorName && (
                        <Popconfirm
                          title="确认删除该翻译器？"
                          onConfirm={() => void onDeleteTranslator()}
                        >
                          <Button danger>删除</Button>
                        </Popconfirm>
                      )}
                    </Space>
                  </Form>
                </Card>
              </Col>
            </Row>
          ),
        },
        {
          key: 'auxiliary',
          label: '辅助配置',
          children: (
            <div className="section-stack">
              <Row gutter={16}>
                <Col span={12}>
                  <Card title="术语提取" loading={settingsLoading}>
                    <Form
                      form={extractorForm}
                      layout="vertical"
                      className="compact-form"
                      onFinish={(values) =>
                        void onSaveAuxiliaryConfig('extractor', values)
                      }
                    >
                      <AuxiliaryCommonFields />
                      <Row gutter={16}>
                        <Col span={8}>
                          <Form.Item name="maxCharsPerBatch" label="每批最大字符">
                            <Input type="number" />
                          </Form.Item>
                        </Col>
                        <Col span={8}>
                          <Form.Item name="occurrenceTopK" label="Top K">
                            <Input type="number" />
                          </Form.Item>
                        </Col>
                        <Col span={8}>
                          <Form.Item name="occurrenceTopP" label="Top P">
                            <Input type="number" />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Button type="primary" htmlType="submit">
                        保存
                      </Button>
                    </Form>
                  </Card>
                </Col>
                <Col span={12}>
                  <Card title="术语更新" loading={settingsLoading}>
                    <Form
                      form={updaterForm}
                      layout="vertical"
                      className="compact-form"
                      onFinish={(values) =>
                        void onSaveAuxiliaryConfig('updater', values)
                      }
                    >
                      <Row gutter={16}>
                        <Col span={8}>
                          <Form.Item name="workflow" label="工作流">
                            <Input placeholder="default" />
                          </Form.Item>
                        </Col>
                        <Col span={16}>
                          <Form.Item
                            name="modelName"
                            label="模型名"
                            rules={[{ required: true }]}
                          >
                            <Input />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Form.Item name="requestOptionsJson" label="请求选项（JSON）">
                        <TextArea rows={4} />
                      </Form.Item>
                      <Button type="primary" htmlType="submit">
                        保存
                      </Button>
                    </Form>
                  </Card>
                </Col>
              </Row>
              <Row gutter={16}>
                <Col span={12}>
                  <Card title="情节总结" loading={settingsLoading}>
                    <Form
                      form={plotForm}
                      layout="vertical"
                      className="compact-form"
                      onFinish={(values) =>
                        void onSaveAuxiliaryConfig('plot', values)
                      }
                    >
                      <Row gutter={16}>
                        <Col span={12}>
                          <Form.Item
                            name="modelName"
                            label="模型名"
                            rules={[{ required: true }]}
                          >
                            <Input />
                          </Form.Item>
                        </Col>
                        <Col span={6}>
                          <Form.Item name="fragmentsPerBatch" label="每批片段数">
                            <Input type="number" />
                          </Form.Item>
                        </Col>
                        <Col span={6}>
                          <Form.Item
                            name="maxContextSummaries"
                            label="最大上下文摘要数"
                          >
                            <Input type="number" />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Form.Item name="requestOptionsJson" label="请求选项（JSON）">
                        <TextArea rows={4} />
                      </Form.Item>
                      <Button type="primary" htmlType="submit">
                        保存
                      </Button>
                    </Form>
                  </Card>
                </Col>
                <Col span={12}>
                  <Card title="对齐补翻" loading={settingsLoading}>
                    <Form
                      form={alignmentForm}
                      layout="vertical"
                      className="compact-form"
                      onFinish={(values) =>
                        void onSaveAuxiliaryConfig('alignment', values)
                      }
                    >
                      <Form.Item
                        name="modelName"
                        label="模型名"
                        rules={[{ required: true }]}
                      >
                        <Input />
                      </Form.Item>
                      <Form.Item name="requestOptionsJson" label="请求选项（JSON）">
                        <TextArea rows={4} />
                      </Form.Item>
                      <Button type="primary" htmlType="submit">
                        保存
                      </Button>
                    </Form>
                  </Card>
                </Col>
              </Row>
            </div>
          ),
        },
      ]}
    />
  );
}

function AuxiliaryCommonFields() {
  return (
    <>
      <Form.Item
        name="modelName"
        label="模型名"
        rules={[{ required: true }]}
      >
        <Input />
      </Form.Item>
      <Form.Item name="requestOptionsJson" label="请求选项（JSON）">
        <TextArea rows={4} />
      </Form.Item>
    </>
  );
}
