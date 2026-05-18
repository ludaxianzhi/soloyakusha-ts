import { useCallback } from 'react';
import {
  Space,
  Typography,
  Button,
  Input,
  Form,
} from 'antd';
import {
  DeleteOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
} from '@ant-design/icons';
import type { FormListFieldData } from 'antd';
import type { ProcessorParamSchema } from '../../app/types';

const { TextArea } = Input;

interface PreProcessPipelineBuilderProps {
  field: FormListFieldData;
  schema: ProcessorParamSchema;
  remove: () => void;
  move: (direction: -1 | 1) => void;
  index: number;
  total: number;
}

function regexValidator(_: unknown, value: string) {
  if (!value || value.length === 0) return Promise.resolve();
  try {
    new RegExp(value);
    return Promise.resolve();
  } catch (e) {
    return Promise.reject(new Error(`无效的正则表达式: ${(e as Error).message}`));
  }
}

function renderParamField(
  def: { key: string; type: string; title: string; placeholder?: string },
  fieldPrefix: string | number,
) {
  const isRegexField = def.key === 'matchRegex' || def.key === 'filterRegex';
  switch (def.type) {
    default:
      return (
        <Form.Item
          name={[fieldPrefix, 'params', def.key]}
          label={def.title}
          rules={[
            def.key === 'matchRegex'
              ? { required: true, message: '匹配 Regex 为必填项' }
              : {},
            ...(isRegexField ? [{ validator: regexValidator }] : []),
          ]}
          validateTrigger="onBlur"
        >
          <Input placeholder={def.placeholder} />
        </Form.Item>
      );
  }
}

export function PreProcessPipelineBuilder({
  field,
  schema,
  remove,
  move,
  index,
  total,
}: PreProcessPipelineBuilderProps) {
  const handleMoveUp = useCallback(() => move(-1), [move]);
  const handleMoveDown = useCallback(() => move(1), [move]);
  const handleRemove = useCallback(() => remove(), [remove]);

  return (
    <div
      style={{
        padding: '12px',
        border: '1px solid #303030',
        borderRadius: 4,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 4,
        }}
      >
        <Typography.Text strong style={{ flex: 1 }}>
          {index + 1}. 文本替换
        </Typography.Text>
        <Space size={4}>
          <Button
            type="text"
            size="small"
            icon={<ArrowUpOutlined />}
            disabled={index === 0}
            onClick={handleMoveUp}
          />
          <Button
            type="text"
            size="small"
            icon={<ArrowDownOutlined />}
            disabled={index === total - 1}
            onClick={handleMoveDown}
          />
          <Button
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={handleRemove}
          />
        </Space>
      </div>

      {Object.entries(schema.properties).map(([key, def]) =>
        renderParamField({ key, ...def }, field.name)
      )}
    </div>
  );
}
