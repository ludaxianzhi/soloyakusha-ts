import { useCallback, useState } from 'react';
import {
  Space,
  Typography,
  Select,
  Button,
  Empty,
  Input,
  InputNumber,
  Switch,
} from 'antd';
import {
  DeleteOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  DownOutlined,
  RightOutlined,
} from '@ant-design/icons';
import type { TextPostProcessorDescriptor, PipelineStep, ProcessorParamSchema } from '../../app/types';

interface PostProcessPipelineBuilderProps {
  processors: TextPostProcessorDescriptor[];
  steps: PipelineStep[];
  onStepsChange: (steps: PipelineStep[]) => void;
  loading?: boolean;
}

function initParamsFromSchema(schema: ProcessorParamSchema): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(schema.properties)) {
    if (def.default !== undefined) {
      params[key] = def.default;
    }
  }
  return params;
}

export function PostProcessPipelineBuilder({
  processors,
  steps,
  onStepsChange,
  loading = false,
}: PostProcessPipelineBuilderProps) {
  const processorMap = new Map(processors.map((p) => [p.id, p]));
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggleExpand = useCallback(
    (index: number) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(index)) {
          next.delete(index);
        } else {
          next.add(index);
        }
        return next;
      });
    },
    [],
  );

  const handleAddStep = useCallback(
    (processorId: string) => {
      const desc = processorMap.get(processorId);
      const params = desc?.paramsSchema ? initParamsFromSchema(desc.paramsSchema) : undefined;
      onStepsChange([...steps, { id: processorId, params }]);
    },
    [steps, processorMap, onStepsChange],
  );

  const handleRemoveStep = useCallback(
    (index: number) => {
      onStepsChange(steps.filter((_, i) => i !== index));
      setExpanded((prev) => {
        const next = new Set<number>();
        for (const i of prev) {
          if (i < index) next.add(i);
          else if (i > index) next.add(i - 1);
        }
        return next;
      });
    },
    [steps, onStepsChange],
  );

  const handleMoveStep = useCallback(
    (index: number, direction: -1 | 1) => {
      const newIndex = index + direction;
      if (newIndex < 0 || newIndex >= steps.length) return;
      const next = [...steps];
      const temp = next[index]!;
      next[index] = next[newIndex]!;
      next[newIndex] = temp;
      onStepsChange(next);
      setExpanded((prev) => {
        const nextSet = new Set(prev);
        if (nextSet.has(index)) {
          nextSet.delete(index);
          nextSet.add(newIndex);
        } else if (nextSet.has(newIndex)) {
          nextSet.delete(newIndex);
          nextSet.add(index);
        }
        return nextSet;
      });
    },
    [steps, onStepsChange],
  );

  const handleClearAll = useCallback(() => {
    onStepsChange([]);
    setExpanded(new Set());
  }, [onStepsChange]);

  const handleParamChange = useCallback(
    (stepIndex: number, key: string, value: unknown) => {
      const next = [...steps];
      const step = next[stepIndex];
      if (step) {
        next[stepIndex] = {
          ...step,
          params: { ...step.params, [key]: value },
        };
        onStepsChange(next);
      }
    },
    [steps, onStepsChange],
  );

  const addableProcessors = processors.map((p) => ({
    value: p.id,
    label: p.name,
  }));

  const renderParamField = (
    def: { key: string; type: string; title: string; placeholder?: string; minimum?: number; maximum?: number },
    value: unknown,
    stepIndex: number,
  ) => {
    switch (def.type) {
      case 'number':
        return (
          <InputNumber
            style={{ width: '100%' }}
            placeholder={def.placeholder}
            min={def.minimum}
            max={def.maximum}
            value={value as number | undefined}
            onChange={(v) => handleParamChange(stepIndex, def.key, v)}
          />
        );
      case 'boolean':
        return (
          <Switch
            checked={!!value}
            onChange={(v) => handleParamChange(stepIndex, def.key, v)}
          />
        );
      default:
        return (
          <Input
            placeholder={def.placeholder}
            value={value as string | undefined}
            onChange={(e) => handleParamChange(stepIndex, def.key, e.target.value)}
          />
        );
    }
  };

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <Typography.Text strong>处理步骤</Typography.Text>
        {steps.length > 0 && (
          <Button
            type="link"
            size="small"
            icon={<DeleteOutlined />}
            onClick={handleClearAll}
            style={{ padding: 0 }}
          >
            清空
          </Button>
        )}
      </div>

      <div
        style={{
          border: '1px solid #303030',
          borderRadius: 4,
          minHeight: 80,
          padding: steps.length > 0 ? 0 : 12,
        }}
      >
        {steps.length === 0 && !loading ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="暂无步骤，请在下方添加"
            style={{ margin: '16px 0' }}
          />
        ) : (
          steps.map((step, index) => {
            const desc = processorMap.get(step.id);
            const schema = desc?.paramsSchema;
            const isExpanded = expanded.has(index);

            return (
              <div key={`${step.id}-${index}`}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    padding: '8px 12px',
                    borderBottom: index < steps.length - 1 ? '1px solid #303030' : undefined,
                  }}
                >
                  <Typography.Text
                    type="secondary"
                    style={{ minWidth: 24, textAlign: 'right', lineHeight: '22px' }}
                  >
                    {index + 1}.
                  </Typography.Text>

                  {schema && (
                    <Button
                      type="text"
                      size="small"
                      icon={isExpanded ? <DownOutlined /> : <RightOutlined />}
                      onClick={() => toggleExpand(index)}
                      style={{ marginTop: 1 }}
                    />
                  )}

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Typography.Text strong>{desc?.name ?? step.id}</Typography.Text>
                    {desc?.description && (
                      <div>
                        <Typography.Text
                          type="secondary"
                          style={{ fontSize: 12 }}
                        >
                          {desc.description}
                        </Typography.Text>
                      </div>
                    )}
                  </div>

                  <Space size={4}>
                    <Button
                      type="text"
                      size="small"
                      icon={<ArrowUpOutlined />}
                      disabled={index === 0}
                      onClick={() => handleMoveStep(index, -1)}
                    />
                    <Button
                      type="text"
                      size="small"
                      icon={<ArrowDownOutlined />}
                      disabled={index === steps.length - 1}
                      onClick={() => handleMoveStep(index, 1)}
                    />
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => handleRemoveStep(index)}
                    />
                  </Space>
                </div>

                {isExpanded && schema && (
                  <div
                    style={{
                      padding: '8px 12px 12px 48px',
                      borderBottom: index < steps.length - 1 ? '1px solid #303030' : undefined,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                    }}
                  >
                    {Object.entries(schema.properties).map(([key, def]) => {
                      const value = step.params?.[key] ?? def.default;
                      const isRequired = schema.required?.includes(key);
                      return (
                        <div key={key}>
                          <div style={{ marginBottom: 4 }}>
                            <Typography.Text style={{ fontSize: 13 }}>
                              {def.title}
                              {isRequired && (
                                <Typography.Text type="danger" style={{ marginLeft: 2 }}>
                                  *
                                </Typography.Text>
                              )}
                            </Typography.Text>
                          </div>
                          {def.description && (
                            <div style={{ marginBottom: 4 }}>
                              <Typography.Text
                                type="secondary"
                                style={{ fontSize: 12 }}
                              >
                                {def.description}
                              </Typography.Text>
                            </div>
                          )}
                          {renderParamField(
                            { key, ...def },
                            value,
                            index,
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div style={{ marginTop: 8 }}>
        <Select
          style={{ width: '100%' }}
          placeholder="添加后处理步骤..."
          options={addableProcessors}
          value={undefined}
          onChange={handleAddStep}
          loading={loading}
          disabled={loading || processors.length === 0}
        />
      </div>
    </div>
  );
}
