import { useCallback } from 'react';
import {
  Space,
  Typography,
  Select,
  Button,
  Empty,
} from 'antd';
import { DeleteOutlined, ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons';
import type { TextPostProcessorDescriptor, PipelineStep } from '../../app/types';

interface PostProcessPipelineBuilderProps {
  processors: TextPostProcessorDescriptor[];
  steps: PipelineStep[];
  onStepsChange: (steps: PipelineStep[]) => void;
  loading?: boolean;
}

export function PostProcessPipelineBuilder({
  processors,
  steps,
  onStepsChange,
  loading = false,
}: PostProcessPipelineBuilderProps) {
  const processorMap = new Map(processors.map((p) => [p.id, p]));

  const handleAddStep = useCallback(
    (processorId: string) => {
      onStepsChange([...steps, { id: processorId }]);
    },
    [steps, onStepsChange],
  );

  const handleRemoveStep = useCallback(
    (index: number) => {
      onStepsChange(steps.filter((_, i) => i !== index));
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
    },
    [steps, onStepsChange],
  );

  const handleClearAll = useCallback(() => {
    onStepsChange([]);
  }, [onStepsChange]);

  const addableProcessors = processors.map((p) => ({
    value: p.id,
    label: p.name,
  }));

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
            return (
              <div
                key={`${step.id}-${index}`}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '8px 12px',
                  borderBottom:
                    index < steps.length - 1 ? '1px solid #303030' : undefined,
                }}
              >
                <Typography.Text
                  type="secondary"
                  style={{ minWidth: 24, textAlign: 'right', lineHeight: '22px' }}
                >
                  {index + 1}.
                </Typography.Text>
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
