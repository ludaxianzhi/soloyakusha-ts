import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Collapse,
  Empty,
  Form,
  Input,
  Modal,
  Space,
  Statistic,
  Tag,
  Typography,
} from 'antd';
import { api } from '../../app/api.ts';
import { useActiveWorkspaceId } from '../../app/active-workspace-context.ts';
import type {
  ChapterFindReplaceApplyResult,
  ChapterFindReplacePreviewResult,
  ChapterFindReplaceRequest,
} from '../../app/types.ts';

interface ChapterFindReplaceModalProps {
  open: boolean;
  chapterIds: number[];
  onCancel: () => void;
  onSuccess: (result: ChapterFindReplaceApplyResult) => void | Promise<void>;
}

type ChapterFindReplaceFormValues = {
  sourceRegex?: string;
  translationRegex: string;
  replacement: string;
};

export function ChapterFindReplaceModal({
  open,
  chapterIds,
  onCancel,
  onSuccess,
}: ChapterFindReplaceModalProps) {
  const { message } = AntdApp.useApp();
  const activeWorkspaceId = useActiveWorkspaceId();
  const [form] = Form.useForm<ChapterFindReplaceFormValues>();
  const [previewResult, setPreviewResult] = useState<ChapterFindReplacePreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setPreviewResult(null);
    form.resetFields();
    form.setFieldsValue({
      sourceRegex: '',
      translationRegex: '',
      replacement: '',
    });
  }, [form, open]);

  const groupedMatches = useMemo(() => {
    const groups = new Map<string, ChapterFindReplacePreviewResult['matches']>();
    for (const match of previewResult?.matches ?? []) {
      const key = `${match.chapterId}`;
      const existing = groups.get(key) ?? [];
      existing.push(match);
      groups.set(key, existing);
    }
    return [...groups.entries()].map(([chapterId, matches]) => ({
      chapterId: Number(chapterId),
      title: `${matches[0]?.chapterDisplayName ?? chapterId} · ${matches[0]?.chapterFilePath ?? ''}`,
      matches,
    }));
  }, [previewResult]);

  const buildPayload = async (): Promise<ChapterFindReplaceRequest> => {
    const values = await form.validateFields();
    return {
      chapterIds,
      sourceRegex: values.sourceRegex?.trim() ? values.sourceRegex.trim() : undefined,
      translationRegex: values.translationRegex,
      replacement: values.replacement ?? '',
    };
  };

  const handlePreview = async () => {
    setPreviewing(true);
    try {
      const payload = await buildPayload();
      const result = await api.previewChapterFindReplace(payload, activeWorkspaceId ?? undefined);
      setPreviewResult(result);
      if (result.matchedPairCount > 0) {
        message.success(`已找到 ${result.matchedPairCount} 条待修改译文`);
      } else {
        message.info('当前条件下没有可修改的译文');
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPreviewing(false);
    }
  };

  const handleApply = async () => {
    setApplying(true);
    try {
      const payload = await buildPayload();
      const result = await api.applyChapterFindReplace(payload, activeWorkspaceId ?? undefined);
      setPreviewResult(result);
      if (result.updatedLineCount > 0) {
        message.success(
          `已修改 ${result.updatedLineCount} 条译文，共替换 ${result.totalReplacementCount} 处命中`,
        );
      } else {
        message.info('没有需要应用的修改');
      }
      await onSuccess(result);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Modal
      title="全局查找替换"
      open={open}
      onCancel={onCancel}
      width={920}
      destroyOnClose={false}
      footer={[
        <Button key="cancel" onClick={onCancel} disabled={previewing || applying}>
          取消
        </Button>,
        <Button key="preview" onClick={() => void handlePreview()} loading={previewing}>
          预览
        </Button>,
        <Button
          key="apply"
          type="primary"
          onClick={() => void handleApply()}
          loading={applying}
        >
          应用修改
        </Button>,
      ]}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message={`仅对已选中的 ${chapterIds.length} 个章节生效`}
          description="译文只会替换 Regex 命中的部分，不会整句覆盖。原文 Regex 为空时表示不过滤原文。"
        />

        <Form form={form} layout="vertical">
          <Form.Item
            label="原文 Regex"
            name="sourceRegex"
            extra="可选。仅修改原文命中的原文-译文对。"
          >
            <Input placeholder="例如：登场|退场" />
          </Form.Item>
          <Form.Item
            label="译文 Regex"
            name="translationRegex"
            rules={[{ required: true, message: '请输入译文 Regex' }]}
            extra="只输入表达式本体，系统会替换每条译文里所有命中的部分。"
          >
            <Input placeholder="例如：勇者(\\d+)" />
          </Form.Item>
          <Form.Item
            label="替换"
            name="replacement"
            extra="支持 JS replace 的捕获组写法，例如 $1、$2。"
          >
            <Input placeholder="例如：Hero-$1" />
          </Form.Item>
        </Form>

        {previewResult ? (
          <div className="chapter-find-replace-summary-grid">
            <Statistic title="选中章节" value={previewResult.totalSelectedChapters} />
            <Statistic title="受影响章节" value={previewResult.affectedChapterCount} />
            <Statistic title="待修改语句对" value={previewResult.matchedPairCount} />
            <Statistic title="总替换次数" value={previewResult.totalReplacementCount} />
          </div>
        ) : null}

        {previewResult ? (
          previewResult.matches.length === 0 ? (
            <Empty description="当前条件下没有匹配到可修改的译文" />
          ) : (
            <Collapse
              className="chapter-find-replace-collapse"
              items={groupedMatches.map((group) => ({
                key: String(group.chapterId),
                label: (
                  <Space wrap size={[8, 8]}>
                    <Typography.Text strong>{group.title}</Typography.Text>
                    <Tag>{group.matches.length} 条</Tag>
                    <Tag color="processing">
                      {group.matches.reduce(
                        (count, match) => count + match.replacementCount,
                        0,
                      )} 次替换
                    </Tag>
                  </Space>
                ),
                children: (
                  <div className="chapter-find-replace-match-list">
                    {group.matches.map((match) => (
                      <div
                        key={`${match.chapterId}-${match.fragmentIndex}-${match.lineIndex}`}
                        className="chapter-find-replace-match-item"
                      >
                        <Space wrap size={[8, 8]}>
                          <Tag>{`F${match.fragmentIndex + 1}`}</Tag>
                          <Tag>{`L${match.lineIndex + 1}`}</Tag>
                          <Tag color="processing">{`${match.replacementCount} 次命中`}</Tag>
                        </Space>
                        <div className="chapter-find-replace-line-block">
                          <Typography.Text type="secondary">原文</Typography.Text>
                          <Typography.Paragraph style={{ marginBottom: 0 }}>
                            {match.sourceText || '（原文为空）'}
                          </Typography.Paragraph>
                        </div>
                        <div className="chapter-find-replace-line-block">
                          <Typography.Text type="secondary">修改前</Typography.Text>
                          <Typography.Paragraph style={{ marginBottom: 0 }}>
                            {match.previousText || '（译文为空）'}
                          </Typography.Paragraph>
                        </div>
                        <div className="chapter-find-replace-line-block chapter-find-replace-line-block-next">
                          <Typography.Text type="secondary">修改后</Typography.Text>
                          <Typography.Paragraph style={{ marginBottom: 0 }}>
                            {match.nextText || '（结果为空）'}
                          </Typography.Paragraph>
                        </div>
                      </div>
                    ))}
                  </div>
                ),
              }))}
            />
          )
        ) : null}
      </Space>
    </Modal>
  );
}