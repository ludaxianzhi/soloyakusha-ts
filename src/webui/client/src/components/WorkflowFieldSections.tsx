import { Collapse, Col, Form, Input, Row, Select, Typography } from 'antd';
import type { TranslationProcessorWorkflowFieldMetadata } from '../app/types.ts';
import {
  isWorkflowFieldRequired,
  isWorkflowFieldVisible,
} from '../app/ui-helpers.ts';
import { YamlCodeEditor } from './YamlCodeEditor.tsx';

const { Text } = Typography;
const { TextArea } = Input;
type YamlCodeEditorProps = Parameters<typeof YamlCodeEditor>[0];

export function WorkflowFieldSections({
  formValues,
  fields,
  llmProfileOptions,
  fieldOptionsBySource,
  fieldNameForKey,
}: {
  formValues?: Record<string, unknown>;
  fields: TranslationProcessorWorkflowFieldMetadata[];
  llmProfileOptions: Array<{ label: string; value: string }>;
  fieldOptionsBySource?: Partial<Record<'style-libraries', Array<{ label: string; value: string; description?: string }>>>;
  fieldNameForKey: (key: string) => string;
}) {
  if (fields.length === 0) {
    return null;
  }

  const visibleFields = fields.filter((field) => isWorkflowFieldVisible(field, formValues, fieldNameForKey));
  const basicFields = visibleFields.filter((field) => field.section !== 'advanced');
  const advancedFields = visibleFields.filter((field) => field.section === 'advanced');

  return (
    <>
      <WorkflowFieldSection
        formValues={formValues}
        title="基础配置"
        fields={basicFields}
        llmProfileOptions={llmProfileOptions}
        fieldOptionsBySource={fieldOptionsBySource}
        fieldNameForKey={fieldNameForKey}
      />
      {advancedFields.length > 0 ? (
        <WorkflowFieldSection
          formValues={formValues}
          title="高级配置"
          fields={advancedFields}
          llmProfileOptions={llmProfileOptions}
          fieldOptionsBySource={fieldOptionsBySource}
          fieldNameForKey={fieldNameForKey}
        />
      ) : null}
    </>
  );
}

function WorkflowFieldSection({
  formValues,
  title,
  fields,
  llmProfileOptions,
  fieldOptionsBySource,
  fieldNameForKey,
}: {
  formValues?: Record<string, unknown>;
  title: string;
  fields: TranslationProcessorWorkflowFieldMetadata[];
  llmProfileOptions: Array<{ label: string; value: string }>;
  fieldOptionsBySource?: Partial<Record<'style-libraries', Array<{ label: string; value: string; description?: string }>>>;
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
              preserve={false}
              name={fieldNameForKey(field.key)}
              label={field.label}
              tooltip={field.description}
              extra={
                field.input === 'llm-profile'
                  ? '按选择顺序执行；后面的模型会作为前面的 Fallback。'
                  : undefined
              }
              rules={buildWorkflowFieldRules(field, formValues, fieldNameForKey)}
            >
              {renderWorkflowField(field, llmProfileOptions, fieldOptionsBySource)}
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
  fieldOptionsBySource?: Partial<Record<'style-libraries', Array<{ label: string; value: string; description?: string }>>>,
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

  if (field.input === 'select') {
    return (
      <Select
        showSearch
        allowClear={!field.required}
        options={field.options ?? (field.optionsSource ? fieldOptionsBySource?.[field.optionsSource] : undefined)}
        placeholder={field.placeholder ?? field.description}
        optionFilterProp="label"
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

function buildWorkflowFieldRules(
  field: TranslationProcessorWorkflowFieldMetadata,
  formValues: Record<string, unknown> | undefined,
  fieldNameForKey: (key: string) => string,
) {
  const rules: Array<{ required?: boolean; message?: string; validator?: (_: unknown, value: unknown) => Promise<void> }> = [];
  const required = isWorkflowFieldRequired(field, formValues, fieldNameForKey);

  if (required) {
    rules.push(
      field.input === 'llm-profile'
        ? buildModelChainRule(field.label)
        : { required: true, message: `请填写${field.label}` },
    );
  }

  if (typeof field.minLength === 'number' && field.minLength > 0) {
    rules.push({
      validator(_: unknown, value: unknown) {
        const text = typeof value === 'string' ? value.trim() : '';
        if (!text) {
          return required
            ? Promise.reject(new Error(`请填写${field.label}`))
            : Promise.resolve();
        }
        if (text.length < field.minLength!) {
          return Promise.reject(new Error(`${field.label}至少需要 ${field.minLength} 个字符`));
        }
        return Promise.resolve();
      },
    });
  }

  return rules.length > 0 ? rules : undefined;
}