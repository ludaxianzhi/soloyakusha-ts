import { useState, useEffect, useCallback } from 'react';
import {
  Modal,
  Space,
  Typography,
  Alert,
  Select,
  Button,
  message,
  Empty,
} from 'antd';
import { DeleteOutlined, ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons';
import { api } from '../../app/api';
import { useActiveWorkspaceId } from '../../app/active-workspace-context';
import type { TextPostProcessorDescriptor } from '../../app/types';

interface PostProcessModalProps {
  open: boolean;
  workspaceId?: string | null;
  chapterIds: number[];
  onCancel: () => void;
  onSuccess: () => void;
}

interface PipelineStep {
  id: string;
  params?: Record<string, unknown>;
}

const STORAGE_KEY = 'postProcessPipeline';

function loadSavedPipeline(): PipelineStep[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item: unknown): item is PipelineStep =>
        typeof item === 'object' && item !== null && typeof (item as PipelineStep).id === 'string',
    );
  } catch {
    return [];
  }
}

function savePipeline(steps: PipelineStep[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(steps));
  } catch {
    // ignore storage errors
  }
}

export function PostProcessModal({
  open,
  workspaceId,
  chapterIds,
  onCancel,
  onSuccess,
}: PostProcessModalProps) {
  const activeWorkspaceId = useActiveWorkspaceId();
  const resolvedWorkspaceId = workspaceId ?? activeWorkspaceId;
  const [processors, setProcessors] = useState<TextPostProcessorDescriptor[]>([]);
  const [steps, setSteps] = useState<PipelineStep[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api
      .getPostProcessors(resolvedWorkspaceId ?? undefined)
      .then((res) => {
        setProcessors(res.processors);
        const saved = loadSavedPipeline();
        const validIds = new Set(res.processors.map((p) => p.id));
        const validSaved = saved.filter((s) => validIds.has(s.id));
        setSteps(validSaved);
      })
      .finally(() => setLoading(false));
  }, [open, resolvedWorkspaceId]);

  const processorMap = new Map(processors.map((p) => [p.id, p]));

  const handleAddStep = useCallback(
    (processorId: string) => {
      setSteps((prev) => [...prev, { id: processorId }]);
    },
    [],
  );

  const handleRemoveStep = useCallback((index: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleMoveStep = useCallback((index: number, direction: -1 | 1) => {
    setSteps((prev) => {
      const newIndex = index + direction;
      if (newIndex < 0 || newIndex >= prev.length) return prev;
      const next = [...prev];
      const temp = next[index]!;
      next[index] = next[newIndex]!;
      next[newIndex] = temp;
      return next;
    });
  }, []);

  const handleClearAll = useCallback(() => {
    setSteps([]);
  }, []);

  const handleOk = async () => {
    if (steps.length === 0) {
      message.warning('请至少添加一个后处理步骤');
      return;
    }
    setSubmitting(true);
    try {
      await api.runBatchPostProcess(chapterIds, steps, resolvedWorkspaceId ?? undefined);
      savePipeline(steps);
      message.success('后处理任务执行成功');
      onSuccess();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const addableProcessors = processors.map((p) => ({
    value: p.id,
    label: p.name,
  }));

  return (
    <Modal
      title="文本后处理"
      open={open}
      onOk={handleOk}
      onCancel={onCancel}
      confirmLoading={submitting}
      okButtonProps={{ disabled: steps.length === 0 }}
      okText="执行处理"
      cancelText="取消"
      width={600}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        <Alert
          type="info"
          showIcon
          message={`将对选中的 ${chapterIds.length} 个章节的所有译文执行后处理。操作会直接修改当前译文，建议先进行备份。`}
        />

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
      </Space>
    </Modal>
  );
}
