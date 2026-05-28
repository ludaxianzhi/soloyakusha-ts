import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { UploadFile } from 'antd';
import type {
  UpdateTranslationArchivePreviewResult,
  UpdateTranslationArchiveApplyResult,
  UpdateTranslationMatchedFile,
} from '../../app/types.ts';
import {
  IMPORT_FORMAT_OPTIONS,
  DEFAULT_ARCHIVE_IMPORT_PATTERN,
} from '../../app/ui-helpers.ts';
import { FormatParamFields, useFormatParams } from './FormatParamFields.tsx';

interface UpdateTranslationModalProps {
  open: boolean;
  chapterCount: number;
  onCancel: () => void;
  onPreview: (payload: {
    file: File;
    importFormat?: string;
    importPattern?: string;
    importParams?: Record<string, unknown>;
  }) => Promise<UpdateTranslationArchivePreviewResult>;
  onApply: (
    sessionId: string,
    chapterIds: number[],
    skipChapterIds?: number[],
  ) => Promise<UpdateTranslationArchiveApplyResult>;
  onSuccess: () => void;
}

type PreviewStep = 'upload' | 'preview';

export function UpdateTranslationModal({
  open,
  chapterCount,
  onCancel,
  onPreview,
  onApply,
  onSuccess,
}: UpdateTranslationModalProps) {
  const { message } = AntdApp.useApp();
  const [step, setStep] = useState<PreviewStep>('upload');
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<{
    importFormat?: string;
    importPattern?: string;
  }>();
  const [importParams, setImportParams] = useState<Record<string, unknown>>({});
  const importFormat = Form.useWatch('importFormat', form);
  const { paramDefs } = useFormatParams(importFormat ?? '', 'import');

  const [previewResult, setPreviewResult] = useState<UpdateTranslationArchivePreviewResult | null>(null);
  const [skipChapterIds, setSkipChapterIds] = useState<Set<number>>(new Set());
  const [applyResult, setApplyResult] = useState<UpdateTranslationArchiveApplyResult | null>(null);

  const mismatchedFiles = useMemo(
    () => previewResult?.matchedFiles.filter((f) => !f.lineCountMatch) ?? [],
    [previewResult],
  );

  const matchedFiles = useMemo(
    () => previewResult?.matchedFiles.filter((f) => f.lineCountMatch) ?? [],
    [previewResult],
  );

  const handleReset = useCallback(() => {
    setStep('upload');
    setFiles([]);
    setSubmitting(false);
    setPreviewResult(null);
    setSkipChapterIds(new Set());
    setApplyResult(null);
    setImportParams({});
    form.resetFields();
  }, [form]);

  const handleClose = useCallback(() => {
    if (submitting) return;
    handleReset();
    onCancel();
  }, [submitting, handleReset, onCancel]);

  const handlePreview = useCallback(async () => {
    const file = files[0]?.originFileObj;
    if (!file) {
      message.error('请先选择 ZIP / 7Z 压缩包');
      return;
    }
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      const result = await onPreview({
        file,
        importFormat: values.importFormat,
        importPattern: values.importPattern,
        importParams,
      });
      setPreviewResult(result);
      setSkipChapterIds(new Set());
      setStep('preview');
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }, [files, form, importParams, message, onPreview]);

  const handleApply = useCallback(async () => {
    if (!previewResult) return;
    setSubmitting(true);
    try {
      const allChapterIds = previewResult.matchedFiles.map((f) => f.chapterId);
      const result = await onApply(
        previewResult.sessionId,
        allChapterIds,
        [...skipChapterIds],
      );
      setApplyResult(result);
      if (result.updatedCount > 0) {
        message.success(
          `译文更新完成：成功更新 ${result.updatedCount} 个章节` +
            (result.skippedCount > 0 ? `，跳过 ${result.skippedCount} 个` : ''),
        );
        onSuccess();
      } else if (result.failedFiles.length > 0) {
        message.warning('译文更新未成功，请查看失败详情');
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }, [previewResult, skipChapterIds, message, onApply, onSuccess]);

  const toggleSkip = useCallback((chapterId: number) => {
    setSkipChapterIds((prev) => {
      const next = new Set(prev);
      if (next.has(chapterId)) {
        next.delete(chapterId);
      } else {
        next.add(chapterId);
      }
      return next;
    });
  }, []);

  const matchedColumns = useMemo(
    () => [
      { title: '压缩包文件', dataIndex: 'archivePath', ellipsis: true },
      { title: '章节ID', dataIndex: 'chapterId', width: 70, align: 'center' as const },
      { title: '章节路径', dataIndex: 'chapterFilePath', ellipsis: true },
      {
        title: '源文本行数',
        width: 120,
        render: (_: unknown, record: UpdateTranslationMatchedFile) =>
          `${record.archiveSourceLineCount} / ${record.chapterSourceLineCount}`,
      },
    ],
    [],
  );

  const mismatchedColumns = useMemo(
    () => [
      { title: '压缩包文件', dataIndex: 'archivePath', ellipsis: true },
      { title: '章节ID', dataIndex: 'chapterId', width: 70, align: 'center' as const },
      { title: '章节路径', dataIndex: 'chapterFilePath', ellipsis: true },
      {
        title: '压缩包行数',
        dataIndex: 'archiveSourceLineCount',
        width: 90,
        align: 'center' as const,
      },
      {
        title: '章节行数',
        dataIndex: 'chapterSourceLineCount',
        width: 90,
        align: 'center' as const,
      },
      {
        title: '操作',
        width: 80,
        align: 'center' as const,
        render: (_: unknown, record: UpdateTranslationMatchedFile) => (
          <Checkbox
            checked={!skipChapterIds.has(record.chapterId)}
            onChange={() => toggleSkip(record.chapterId)}
          >
            更新
          </Checkbox>
        ),
      },
    ],
    [skipChapterIds, toggleSkip],
  );

  return (
    <Modal
      title="从压缩包更新译文"
      open={open}
      onCancel={handleClose}
      width={720}
      footer={
        applyResult
          ? [
              <Button key="close" onClick={handleClose}>
                关闭
              </Button>,
            ]
          : step === 'upload'
            ? [
                <Button key="cancel" onClick={handleClose}>
                  取消
                </Button>,
                <Button key="preview" type="primary" loading={submitting} onClick={handlePreview}>
                  解析预览
                </Button>,
              ]
            : [
                <Button key="back" onClick={() => setStep('upload')}>
                  返回
                </Button>,
                <Button key="cancel" onClick={handleClose}>
                  取消
                </Button>,
                <Button
                  key="apply"
                  type="primary"
                  loading={submitting}
                  onClick={handleApply}
                  disabled={previewResult != null && previewResult.matchedFiles.length === 0}
                >
                  确认更新
                </Button>,
              ]
      }
    >
      {applyResult ? (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type={applyResult.ok ? 'success' : 'warning'}
            showIcon
            message={`更新完成：成功 ${applyResult.updatedCount} 个章节，跳过 ${applyResult.skippedCount} 个`}
          />
          {applyResult.failedFiles.length > 0 ? (
            <Alert
              type="error"
              showIcon
              message="以下章节更新失败"
              description={
                <div style={{ whiteSpace: 'pre-wrap' }}>
                  {applyResult.failedFiles
                    .map((f) => `[${f.chapterId}] ${f.filePath}: ${f.error}`)
                    .join('\n')}
                </div>
              }
            />
          ) : null}
        </Space>
      ) : step === 'upload' ? (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="从压缩包中的 m3t / nd 文件解析译文，按 basename 匹配已有章节并更新翻译。行数不匹配的文件将被跳过。"
          />
          <Form
            form={form}
            layout="vertical"
            initialValues={{
              importFormat: '',
              importPattern: DEFAULT_ARCHIVE_IMPORT_PATTERN,
            }}
          >
            <Form.Item
              label="压缩包文件"
              required
              help={files[0] ? `当前文件：${files[0].name}` : '请选择一个 ZIP / 7Z 压缩包'}
            >
              <Upload.Dragger
                accept=".zip,.7z"
                beforeUpload={() => false}
                maxCount={1}
                disabled={submitting}
                fileList={files}
                onChange={({ fileList }) => setFiles(fileList.slice(-1))}
              >
                <p>拖入或点击上传 ZIP / 7Z</p>
              </Upload.Dragger>
            </Form.Item>
            <Form.Item label="文件格式" name="importFormat">
              <Select options={IMPORT_FORMAT_OPTIONS} />
            </Form.Item>
            {paramDefs.length > 0 ? (
              <Form.Item label="格式参数">
                <FormatParamFields
                  paramDefs={paramDefs}
                  values={importParams}
                  onChange={(key, value) => setImportParams((prev) => ({ ...prev, [key]: value }))}
                />
              </Form.Item>
            ) : null}
            <Form.Item
              label="压缩包内 Pattern"
              name="importPattern"
              rules={[{ required: true, message: '请输入压缩包内 Pattern' }]}
            >
              <Input placeholder={DEFAULT_ARCHIVE_IMPORT_PATTERN} />
            </Form.Item>
          </Form>
        </Space>
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {previewResult && previewResult.matchedFiles.length === 0 ? (
            <Alert
              type="warning"
              showIcon
              message="没有匹配到任何章节"
              description="压缩包中的文件无法通过 basename 或路径匹配到已有章节，请检查文件名或调整 Pattern。"
            />
          ) : null}

          {matchedFiles.length > 0 ? (
            <>
              <Typography.Text strong>
                已匹配文件（行数一致）
                <Tag color="success" style={{ marginLeft: 8 }}>
                  {matchedFiles.length} 个
                </Tag>
              </Typography.Text>
              <Table
                size="small"
                dataSource={matchedFiles}
                columns={matchedColumns}
                rowKey="chapterId"
                pagination={false}
                scroll={{ y: 200 }}
              />
            </>
          ) : null}

          {mismatchedFiles.length > 0 ? (
            <>
              <Typography.Text strong>
                行数不匹配文件
                <Tag color="warning" style={{ marginLeft: 8 }}>
                  {mismatchedFiles.length} 个
                </Tag>
              </Typography.Text>
              <Alert
                type="warning"
                showIcon
                message="以下文件的源文本行数与章节不一致，更新可能导致内容错位。请确认是否更新这些章节。"
              />
              <Table
                size="small"
                dataSource={mismatchedFiles}
                columns={mismatchedColumns}
                rowKey="chapterId"
                pagination={false}
                scroll={{ y: 200 }}
              />
            </>
          ) : null}

          {previewResult && previewResult.unmatchedArchiveFiles.length > 0 ? (
            <Alert
              type="info"
              showIcon
              message={`以下 ${previewResult.unmatchedArchiveFiles.length} 个压缩包文件未匹配到章节，将被丢弃`}
              description={
                <div style={{ whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>
                  {previewResult.unmatchedArchiveFiles.join('\n')}
                </div>
              }
            />
          ) : null}
        </Space>
      )}
    </Modal>
  );
}
