import { Button, Card, Col, Form, Input, Popconfirm, Row, Select, Space, Tabs, Tag, Typography } from 'antd';
import type { FormInstance } from 'antd';
import type {
  AlignmentRepairConfig,
  GlossaryExtractorConfig,
  GlossaryUpdaterConfig,
  LlmProfileConfig,
  PlotSummaryConfig,
  TranslationProcessorWorkflowMetadata,
  TranslatorEntry,
} from '../app/types.ts';
import {
  formatModelChain,
  formatTranslatorLanguagePair,
  translatorFieldName,
} from '../app/ui-helpers.ts';
import { YamlCodeEditor } from './YamlCodeEditor.tsx';

const { TextArea } = Input;
const { Paragraph, Text } = Typography;

interface SettingsViewProps {
  settingsLoading: {
    llmProfiles: boolean;
    embedding: boolean;
    translator: boolean;
    extractor: boolean;
    updater: boolean;
    plot: boolean;
    alignment: boolean;
  };
  llmProfiles: Record<string, LlmProfileConfig>;
  defaultLlmName?: string;
  selectedLlmName?: string;
  selectedTranslatorName?: string;
  translators: Record<string, TranslatorEntry>;
  translatorWorkflows: TranslationProcessorWorkflowMetadata[];
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
  translatorWorkflows,
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
  const selectedWorkflowKey = (Form.useWatch('type', translatorForm) as string | undefined) ?? 'default';
  const workflowMap = new Map(
    translatorWorkflows.map((workflow) => [workflow.workflow, workflow] as const),
  );
  const selectedWorkflow = workflowMap.get(selectedWorkflowKey) ?? translatorWorkflows[0];
  const llmProfileOptions = llmNames.map((name) => ({
    label: name,
    value: name,
  }));
  const workflowOptions = translatorWorkflows.map((workflow) => ({
    label: `${workflow.title} (${workflow.workflow})`,
    value: workflow.workflow,
  }));

  return (
    <Tabs
      size="small"
      defaultActiveKey="llm"
      items={[
        {
          key: 'llm',
          label: 'LLM Profiles',
          children: (
            <Row gutter={12}>
              <Col span={7}>
                    <Card
                      size="small"
                      title="Chat Profiles"
                      loading={settingsLoading.llmProfiles}
                      extra={<Button onClick={onCreateLlmProfile}>新建</Button>}
                >
                  <Space direction="vertical" style={{ width: '100%' }}>
                    {llmNames.map((name) => (
                      <button
                        type="button"
                        key={name}
                        onClick={() => onSelectLlmProfile(name)}
                        className={`settings-list-card${name === selectedLlmName ? ' active' : ''}`}
                      >
                        <Space wrap>
                          <span>{name}</span>
                          {name === defaultLlmName && <Tag color="blue">默认</Tag>}
                        </Space>
                        <div>{llmProfiles[name]?.modelName}</div>
                      </button>
                    ))}
                  </Space>
                </Card>
              </Col>
              <Col span={17}>
                <Card size="small" title="编辑 Profile" loading={settingsLoading.llmProfiles}>
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
                          <Select options={[{ label: 'chat', value: 'chat' }]} disabled />
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
                      name="defaultRequestConfigYaml"
                      label="默认请求配置（YAML）"
                      extra="temperature / topP 等标准字段可直接写；供应商特有参数也可直接写，保存时会自动归入 extraBody。"
                    >
                      <YamlCodeEditor
                        placeholder={
                          'temperature: 0.2\nchat_template_kwargs:\n  enable_thinking: false'
                        }
                      />
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

                <Card title="Embedding 配置" loading={settingsLoading.embedding} className="mt-2">
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
                  loading={settingsLoading.translator}
                  extra={<Button onClick={onCreateTranslator}>新建</Button>}
                >
                  <Space direction="vertical" style={{ width: '100%' }}>
                    {translatorNames.map((name) => {
                      const translator = translators[name];
                      if (!translator) {
                        return null;
                      }
                      const workflow = workflowMap.get(translator.type ?? 'default');
                      return (
                        <button
                          type="button"
                          key={name}
                          onClick={() => onSelectTranslator(name)}
                          className={`settings-list-card${name === selectedTranslatorName ? ' active' : ''}`}
                        >
                          <Space wrap>
                            <strong>{translator.metadata?.title ?? name}</strong>
                            {workflow ? <Tag color="purple">{workflow.title}</Tag> : null}
                          </Space>
                          <div>{name}</div>
                          <div>{formatTranslatorLanguagePair(translator)}</div>
                          <div>{formatModelChain(translator.modelNames)}</div>
                          {translator.metadata?.description ? (
                            <Paragraph className="settings-list-description" ellipsis={{ rows: 2 }}>
                              {translator.metadata.description}
                            </Paragraph>
                          ) : null}
                        </button>
                      );
                    })}
                  </Space>
                </Card>
              </Col>
              <Col span={17}>
                <Card title="编辑翻译器" loading={settingsLoading.translator}>
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
                        <Form.Item
                          name="metadataTitle"
                          label="显示名称"
                        >
                          <Input placeholder="界面上展示给用户的名称" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="type" label="工作流" rules={[{ required: true }]}>
                          <Select options={workflowOptions} />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item
                          name="sourceLanguage"
                          label="源语言"
                          rules={[{ required: true, message: '请输入源语言代码' }]}
                        >
                          <Input placeholder="ja" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item
                          name="targetLanguage"
                          label="目标语言"
                          rules={[{ required: true, message: '请输入目标语言代码' }]}
                        >
                          <Input placeholder="zh-CN" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item
                          name="promptSet"
                          label="Prompt 套件"
                          rules={[{ required: true, message: '请输入 Prompt 套件标识' }]}
                        >
                          <Input placeholder="ja-zhCN" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Form.Item name="metadataDescription" label="说明">
                      <TextArea rows={3} placeholder="帮助后续使用者理解这个翻译器适用于什么场景。" />
                    </Form.Item>
                    {selectedWorkflow ? (
                      <Card size="small" className="settings-meta-card">
                        <Space direction="vertical" size={4}>
                          <Space wrap>
                            <strong>{selectedWorkflow.title}</strong>
                            <Tag>{selectedWorkflow.workflow}</Tag>
                          </Space>
                          {selectedWorkflow.description ? (
                            <Text type="secondary">{selectedWorkflow.description}</Text>
                          ) : null}
                        </Space>
                      </Card>
                    ) : null}
                    <DynamicTranslatorFields
                      workflow={selectedWorkflow}
                      llmProfileOptions={llmProfileOptions}
                    />
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
                  <Card title="术语提取" loading={settingsLoading.extractor}>
                    <Form
                      form={extractorForm}
                      layout="vertical"
                      className="compact-form"
                      onFinish={(values) =>
                        void onSaveAuxiliaryConfig('extractor', values)
                      }
                    >
                      <AuxiliaryCommonFields llmProfileOptions={llmProfileOptions} />
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
                  <Card title="术语更新" loading={settingsLoading.updater}>
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
                            name="modelNames"
                            label="模型链"
                            extra="按选择顺序执行；后面的模型会作为前面的 Fallback。"
                            rules={[buildModelChainRule('模型链')]}
                          >
                            <Select
                              mode="multiple"
                              showSearch
                              options={llmProfileOptions}
                              placeholder="按顺序选择 LLM Profile"
                            />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Form.Item name="requestOptionsYaml" label="请求选项（YAML）">
                        <YamlCodeEditor height={180} placeholder="temperature: 0.1" />
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
                  <Card title="情节总结" loading={settingsLoading.plot}>
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
                            name="modelNames"
                            label="模型链"
                            extra="按选择顺序执行；后面的模型会作为前面的 Fallback。"
                            rules={[buildModelChainRule('模型链')]}
                          >
                            <Select
                              mode="multiple"
                              showSearch
                              options={llmProfileOptions}
                              placeholder="按顺序选择 LLM Profile"
                            />
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
                      <Form.Item name="requestOptionsYaml" label="请求选项（YAML）">
                        <YamlCodeEditor height={180} placeholder="temperature: 0.3" />
                      </Form.Item>
                      <Button type="primary" htmlType="submit">
                        保存
                      </Button>
                    </Form>
                  </Card>
                </Col>
                <Col span={12}>
                  <Card title="对齐补翻" loading={settingsLoading.alignment}>
                    <Form
                      form={alignmentForm}
                      layout="vertical"
                      className="compact-form"
                      onFinish={(values) =>
                        void onSaveAuxiliaryConfig('alignment', values)
                      }
                    >
                      <Form.Item
                        name="modelNames"
                        label="模型链"
                        extra="按选择顺序执行；后面的模型会作为前面的 Fallback。"
                        rules={[buildModelChainRule('模型链')]}
                      >
                        <Select
                          mode="multiple"
                          showSearch
                          options={llmProfileOptions}
                          placeholder="按顺序选择 LLM Profile"
                        />
                      </Form.Item>
                      <Form.Item name="requestOptionsYaml" label="请求选项（YAML）">
                        <YamlCodeEditor height={180} placeholder="temperature: 0.1" />
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

function DynamicTranslatorFields({
  workflow,
  llmProfileOptions,
}: {
  workflow?: TranslationProcessorWorkflowMetadata;
  llmProfileOptions: Array<{ label: string; value: string }>;
}) {
  if (!workflow) {
    return null;
  }

  const basicFields = workflow.fields.filter((field) => field.section !== 'advanced');
  const advancedFields = workflow.fields.filter((field) => field.section === 'advanced');

  return (
    <>
      <TranslatorFieldSection title="基础配置" fields={basicFields} llmProfileOptions={llmProfileOptions} />
      {advancedFields.length > 0 ? (
        <TranslatorFieldSection
          title="高级配置"
          fields={advancedFields}
          llmProfileOptions={llmProfileOptions}
        />
      ) : null}
    </>
  );
}

function TranslatorFieldSection({
  title,
  fields,
  llmProfileOptions,
}: {
  title: string;
  fields: TranslationProcessorWorkflowMetadata['fields'];
  llmProfileOptions: Array<{ label: string; value: string }>;
}) {
  if (fields.length === 0) {
    return null;
  }

  return (
    <div className="section-stack">
      <Text strong>{title}</Text>
      <Row gutter={16}>
        {fields.map((field) => (
          <Col span={field.input === 'yaml' ? 24 : 12} key={field.key}>
            <Form.Item
              name={translatorFieldName(field.key)}
              label={field.label}
              tooltip={field.description}
              extra={
                field.input === 'llm-profile'
                  ? '按选择顺序执行；后面的模型会作为前面的 Fallback。'
                  : undefined
              }
              rules={
                field.required
                  ? [
                      field.input === 'llm-profile'
                        ? buildModelChainRule(field.label)
                        : { required: true, message: `请填写${field.label}` },
                    ]
                  : undefined
              }
            >
              {renderTranslatorField(field, llmProfileOptions)}
            </Form.Item>
          </Col>
        ))}
      </Row>
    </div>
  );
}

function renderTranslatorField(
  field: TranslationProcessorWorkflowMetadata['fields'][number],
  llmProfileOptions: Array<{ label: string; value: string }>,
) {
  if (field.input === 'llm-profile') {
    return (
      <Select
        mode="multiple"
        showSearch
        options={llmProfileOptions}
        placeholder="按顺序选择 LLM Profile"
      />
    );
  }

  if (field.input === 'number') {
    return <Input type="number" min={field.min} placeholder={field.description} />;
  }

  return <YamlCodeEditor height={200} placeholder={field.placeholder} />;
}

function AuxiliaryCommonFields({
  llmProfileOptions,
}: {
  llmProfileOptions: Array<{ label: string; value: string }>;
}) {
  return (
    <>
      <Form.Item
        name="modelNames"
        label="模型链"
        extra="按选择顺序执行；后面的模型会作为前面的 Fallback。"
        rules={[buildModelChainRule('模型链')]}
      >
        <Select
          mode="multiple"
          showSearch
          options={llmProfileOptions}
          placeholder="按顺序选择 LLM Profile"
        />
      </Form.Item>
      <Form.Item name="requestOptionsYaml" label="请求选项（YAML）">
        <YamlCodeEditor height={180} placeholder="temperature: 0.2" />
      </Form.Item>
    </>
  );
}

function buildModelChainRule(label: string) {
  return {
    validator(_: unknown, value: unknown) {
      if (Array.isArray(value) && value.length > 0) {
        return Promise.resolve();
      }
      return Promise.reject(new Error(`请至少选择一个${label}`));
    },
  };
}
