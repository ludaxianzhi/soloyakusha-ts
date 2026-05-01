import { useState, useEffect } from 'react';
import { Modal, Checkbox, Space, Typography, Alert, message } from 'antd';
import { api } from '../../app/api';
import type { TextPostProcessorDescriptor } from '../../app/types';

interface PostProcessModalProps {
  open: boolean;
  chapterIds: number[];
  onCancel: () => void;
  onSuccess: () => void;
}

export function PostProcessModal({ open, chapterIds, onCancel, onSuccess }: PostProcessModalProps) {
  const [processors, setProcessors] = useState<TextPostProcessorDescriptor[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setLoading(true);
      api.getPostProcessors()
        .then(res => {
          setProcessors(res.processors);
          // 默认全选
          setSelectedIds(res.processors.map(p => p.id));
        })
        .finally(() => setLoading(false));
    }
  }, [open]);

  const handleOk = async () => {
    if (selectedIds.length === 0) {
      message.warning('请至少选择一个后处理器');
      return;
    }
    setSubmitting(true);
    try {
      await api.runBatchPostProcess(chapterIds, selectedIds);
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
          <div style={{ marginTop: 8, padding: '12px', border: '1px solid #303030', borderRadius: '4px' }}>
            <Checkbox.Group 
              style={{ width: '100%' }} 
              value={selectedIds} 
              onChange={(vals) => setSelectedIds(vals as string[])}
            >
              <Space direction="vertical" style={{ width: '100%' }}>
                {processors.map(p => (
                  <div key={p.id}>
                    <Checkbox value={p.id}>
                      <Typography.Text strong>{p.name}</Typography.Text>
                    </Checkbox>
                    <div style={{ paddingLeft: 24 }}>
                      <Typography.Text type="secondary" style={{ fontSize: '12px' }}>
                        {p.description}
                      </Typography.Text>
                    </div>
                  </div>
                ))}
                {loading && <Typography.Text type="secondary">加载中...</Typography.Text>}
                {!loading && processors.length === 0 && <Typography.Text type="secondary">无可用处理器</Typography.Text>}
              </Space>
            </Checkbox.Group>
          </div>
        </div>
      </Space>
    </Modal>
  );
}
