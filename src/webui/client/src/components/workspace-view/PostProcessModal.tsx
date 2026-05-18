import { useState, useEffect } from 'react';
import {
  Modal,
  Space,
  Typography,
  Alert,
  message,
} from 'antd';
import { api } from '../../app/api';
import { useActiveWorkspaceId } from '../../app/active-workspace-context';
import type { TextPostProcessorDescriptor, PipelineStep } from '../../app/types';
import { PostProcessPipelineBuilder } from './PostProcessPipelineBuilder';

interface PostProcessModalProps {
  open: boolean;
  workspaceId?: string | null;
  chapterIds: number[];
  onCancel: () => void;
  onSuccess: () => void;
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
          <Typography.Text strong>选择处理器</Typography.Text>
          <div style={{ marginTop: 8 }}>
            <PostProcessPipelineBuilder
              processors={processors}
              steps={steps}
              onStepsChange={setSteps}
              loading={loading}
            />
          </div>
        </div>
      </Space>
    </Modal>
  );
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
