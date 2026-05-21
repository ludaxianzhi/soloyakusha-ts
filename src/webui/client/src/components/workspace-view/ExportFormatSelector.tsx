import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Input,
  Modal,
  Space,
  Typography,
  Select,
  Switch,
  Collapse,
  message,
} from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { api } from '../../app/api';
import { useActiveWorkspaceId } from '../../app/active-workspace-context';
import { FormatParamFields, useFormatParams } from './FormatParamFields';
import { PostProcessPipelineBuilder } from './PostProcessPipelineBuilder';
import type { TextPostProcessorDescriptor, PipelineStep } from '../../app/types';

const EXPORT_FORMAT_DEFAULT_EXTENSIONS: Record<string, string> = {
  plain_text: '.txt',
  naturedialog: '.nd',
  dbl_tp1: '.txt',
  m3t: '.m3t',
  galtransl_json: '.json',
  nd_with_meta: '.nd',
  dbl_tp2: '.txt',
};

interface ExportFormatSelectorProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: (config: {
    format: string;
    params?: Record<string, unknown>;
    processors?: PipelineStep[];
    fileExtension?: string;
  }) => void;
  storageKey: string;
  chapterCount?: number;
}

const EXPORT_FORMATS: Array<{ label: string; value: string }> = [
  { label: '纯文本', value: 'plain_text' },
  { label: 'Nature Dialog', value: 'naturedialog' },
  { label: 'DBL TP1', value: 'dbl_tp1' },
  { label: 'M3T', value: 'm3t' },
  { label: 'GalTransl JSON', value: 'galtransl_json' },
  { label: 'ND With Meta', value: 'nd_with_meta' },
  { label: 'DBL TP2', value: 'dbl_tp2' },
];

interface SavedExportState {
  format: string;
  params: Record<string, unknown>;
  postProcessEnabled: boolean;
  postProcessSteps: PipelineStep[];
}

function loadSavedState(storageKey: string): SavedExportState | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    return JSON.parse(raw) as SavedExportState;
  } catch {
    return null;
  }
}

function saveState(storageKey: string, state: SavedExportState): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // ignore storage errors
  }
}

export function ExportFormatSelector({
  open,
  onCancel,
  onConfirm,
  storageKey,
  chapterCount,
}: ExportFormatSelectorProps) {
  const activeWorkspaceId = useActiveWorkspaceId();
  const [format, setFormat] = useState('plain_text');
  const [fileExtension, setFileExtension] = useState('.txt');
  const [paramValues, setParamValues] = useState<Record<string, unknown>>({});
  const [postProcessEnabled, setPostProcessEnabled] = useState(false);
  const [postProcessSteps, setPostProcessSteps] = useState<PipelineStep[]>([]);
  const [processors, setProcessors] = useState<TextPostProcessorDescriptor[]>([]);
  const [processorsLoading, setProcessorsLoading] = useState(false);

  const { paramDefs, buildParams } = useFormatParams(format, 'export');

  const defaultExtension = useMemo(
    () => EXPORT_FORMAT_DEFAULT_EXTENSIONS[format] ?? '.txt',
    [format],
  );

  useEffect(() => {
    setFileExtension(defaultExtension);
  }, [defaultExtension]);

  useEffect(() => {
    const defaults: Record<string, unknown> = {};
    for (const def of paramDefs) {
      defaults[def.key] = def.defaultValue;
    }
    setParamValues((prev) => {
      const merged = { ...defaults };
      for (const key of Object.keys(prev)) {
        if (key in defaults) {
          merged[key] = prev[key];
        }
      }
      return merged;
    });
  }, [paramDefs]);

  useEffect(() => {
    if (!open) return;
    const saved = loadSavedState(storageKey);
    if (saved) {
      setFormat(saved.format);
      setParamValues(saved.params ?? {});
      setPostProcessEnabled(saved.postProcessEnabled ?? false);
      setPostProcessSteps(saved.postProcessSteps ?? []);
    } else {
      setFormat('plain_text');
      setParamValues({});
      setPostProcessEnabled(false);
      setPostProcessSteps([]);
    }

    setProcessorsLoading(true);
    api
      .getPostProcessors(activeWorkspaceId ?? undefined)
      .then((res) => {
        setProcessors(res.processors);
        const validIds = new Set(res.processors.map((p) => p.id));
        setPostProcessSteps((prev) => prev.filter((s) => validIds.has(s.id)));
      })
      .finally(() => setProcessorsLoading(false));
  }, [open, storageKey, activeWorkspaceId]);

  const handleParamChange = useCallback((key: string, value: unknown) => {
    setParamValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleConfirm = useCallback(() => {
    const params = buildParams(paramValues);
    const state: SavedExportState = {
      format,
      params,
      postProcessEnabled,
      postProcessSteps,
    };
    saveState(storageKey, state);

    const ext = fileExtension.trim() || defaultExtension;
    if (postProcessEnabled && postProcessSteps.length > 0) {
      onConfirm({ format, params, processors: postProcessSteps, fileExtension: ext });
    } else {
      onConfirm({ format, params, fileExtension: ext });
    }
  }, [format, fileExtension, defaultExtension, paramValues, buildParams, postProcessEnabled, postProcessSteps, storageKey, onConfirm]);

  return (
    <Modal
      title="下载导出章节"
      open={open}
      onOk={handleConfirm}
      onCancel={onCancel}
      okText="下载"
      cancelText="取消"
      width={600}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        {chapterCount != null && (
          <Typography.Text type="secondary">
            将导出 {chapterCount} 个章节
          </Typography.Text>
        )}

        <div>
          <Typography.Text strong>导出格式</Typography.Text>
          <Select
            style={{ width: '100%', marginTop: 4 }}
            value={format}
            onChange={(value) => setFormat(value)}
            options={EXPORT_FORMATS}
          />
        </div>

        <div>
          <Typography.Text strong>文件后缀</Typography.Text>
          <Input
            style={{ width: '100%', marginTop: 4 }}
            value={fileExtension}
            onChange={(e) => setFileExtension(e.target.value)}
            placeholder={defaultExtension}
          />
        </div>

        {paramDefs.length > 0 && (
          <div>
            <Typography.Text strong>格式参数</Typography.Text>
            <div style={{ marginTop: 4 }}>
              <FormatParamFields
                paramDefs={paramDefs}
                values={paramValues}
                onChange={handleParamChange}
              />
            </div>
          </div>
        )}

        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 8,
            }}
          >
            <Space>
              <SettingOutlined />
              <Typography.Text strong>文本后处理</Typography.Text>
            </Space>
            <Switch
              checked={postProcessEnabled}
              onChange={(checked) => {
                setPostProcessEnabled(checked);
              }}
            />
          </div>

          {postProcessEnabled && (
            <PostProcessPipelineBuilder
              processors={processors}
              steps={postProcessSteps}
              onStepsChange={setPostProcessSteps}
              loading={processorsLoading}
            />
          )}
        </div>
      </Space>
    </Modal>
  );
}
