import { Collapse, Col, Form, Input, Row, Select, Typography } from 'antd';
import type { TranslationProcessorWorkflowFieldMetadata } from '../app/types.ts';
import { YamlCodeEditor } from './YamlCodeEditor.tsx';

const { Text } = Typography;
const { TextArea } = Input;
type YamlCodeEditorProps = Parameters<typeof YamlCodeEditor>[0];

export function WorkflowFieldSections({
  fields,
  llmProfileOptions,
  fieldNameForKey,
}: {
  fields: TranslationProcessorWorkflowFieldMetadata[];
  llmProfileOptions: Array<{ label: string; value: string }>;
  fieldNameForKey: (key: string) => string;
}) {
  if (fields.length === 0) {
    return null;
  }

  const basicFields = fields.filter((field) => field.section !== 'advanced');
  const advancedFields = fields.filter((field) => field.section === 'advanced');

  return (
    <>
      <WorkflowFieldSection
        title="基础配置"
        fields={basicFields}
        llmProfileOptions={llmProfileOptions}
        fieldNameForKey={fieldNameForKey}
      />
      {advancedFields.length > 0 ? (
        <WorkflowFieldSection
          title="高级配置"
          fields={advancedFields}
          llmProfileOptions={llmProfileOptions}
          fieldNameForKey={fieldNameForKey}
        />
      ) : null}
    </>
  );
}

function WorkflowFieldSection({
  title,
  fields,
  llmProfileOptions,
  fieldNameForKey,
}: {
  title: string;
  fields: TranslationProcessorWorkflowFieldMetadata[];
  llmProfileOptions: Array<{ label: string; value: string }>;
  fieldNameForKey: (key: string) => string;
}) {
  if (fields.length === 0) {
    return null;
  }

  return (
    <div className="section-stack">
      <Text strong>{title}</Text>
      <Row gutter={16}>
        {fields.map((field) => (
          <Col span={field.input === 'yaml' || field.input === 'textarea' ? 24 : 12} key={field.key}>
            <Form.Item
              name={fieldNameForKey(field.key)}
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
              {renderWorkflowField(field, llmProfileOptions)}
            </Form.Item>
          </Col>
        ))}
      </Row>
    </div>
  );
}

function renderWorkflowField(
  field: TranslationProcessorWorkflowFieldMetadata,
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

  if (field.input === 'text') {
    return <Input placeholder={field.placeholder ?? field.description} />;
  }

  if (field.input === 'textarea') {
    return <TextArea rows={5} placeholder={field.placeholder ?? field.description} />;
  }

  if (field.key.endsWith('requestOptions')) {
    return <CollapsibleRequestOptionsEditor placeholder={field.placeholder} />;
  }

  return <YamlCodeEditor height={200} placeholder={field.placeholder} />;
}

function CollapsibleRequestOptionsEditor({
  value,
  onChange,
  placeholder,
}: YamlCodeEditorProps) {
  return (
    <Collapse
      size="small"
      ghost
      items={[
        {
          key: 'requestOptions',
          label: '请求配置',
          children: (
            <YamlCodeEditor
              height={180}
              value={value}
              onChange={onChange}
              placeholder={placeholder}
            />
          ),
        },
      ]}
    />
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