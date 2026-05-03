import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Empty,
  Grid,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
} from 'antd';
import type { WorkspaceChapterDescriptor, TranslationPreviewChapter } from '../app/types.ts';
import { api } from '../app/api.ts';
import { useActiveWorkspaceId } from '../app/active-workspace-context.ts';
import { toErrorMessage } from '../app/ui-helpers.ts';

type PreviewViewMode = 'safe' | 'card';

interface TranslationPreviewModalProps {
  open: boolean;
  workspaceId?: string | null;
  chapters: WorkspaceChapterDescriptor[];
  defaultChapterId?: number;
  onCancel: () => void;
}

export function TranslationPreviewModal({
  open,
  workspaceId,
  chapters,
  defaultChapterId,
  onCancel,
}: TranslationPreviewModalProps) {
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const activeWorkspaceId = useActiveWorkspaceId();
  const resolvedWorkspaceId = workspaceId ?? activeWorkspaceId;
  const [selectedChapterId, setSelectedChapterId] = useState<number>();
  const [preview, setPreview] = useState<TranslationPreviewChapter | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [onlyTranslated, setOnlyTranslated] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [previewMode, setPreviewMode] = useState<PreviewViewMode>('card');

  const chapterOptions = useMemo(
    () =>
      chapters.map((chapter) => ({
        label: `Ch${chapter.id} · ${chapter.filePath}`,
        value: chapter.id,
      })),
    [chapters],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const fallbackChapterId =
      chapters.find((chapter) => chapter.hasTranslationData)?.id ?? chapters[0]?.id;
    const preferredChapterId =
      defaultChapterId && chapters.some((chapter) => chapter.id === defaultChapterId)
        ? defaultChapterId
        : fallbackChapterId;
    setSelectedChapterId(preferredChapterId);
  }, [chapters, defaultChapterId, open]);

  useEffect(() => {
    if (!open || !resolvedWorkspaceId || selectedChapterId === undefined) {
      if (!open || !resolvedWorkspaceId) {
        setPreview(null);
      }
      return;
    }

    let cancelled = false;
    setLoading(true);
    setErrorMessage(undefined);
    void api
      .getChapterPreview(selectedChapterId, resolvedWorkspaceId)
      .then((result) => {
        if (!cancelled) {
          setPreview(result);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setPreview(null);
          setErrorMessage(toErrorMessage(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, resolvedWorkspaceId, selectedChapterId]);

  const filteredUnits = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return (preview?.units ?? []).filter((unit) => {
      if (onlyTranslated && !hasVisibleText(unit.translatedText)) {
        return false;
      }
      if (!normalizedKeyword) {
        return true;
      }
      return (
        unit.sourceText.toLowerCase().includes(normalizedKeyword) ||
        unit.translatedText.toLowerCase().includes(normalizedKeyword)
      );
    });
  }, [keyword, onlyTranslated, preview?.units]);

  return (
    <Modal
      open={open}
      title="译文预览"
      width={isMobile ? 'calc(100vw - 16px)' : 1040}
      style={isMobile ? { top: 8 } : undefined}
      destroyOnClose={false}
      footer={<Button onClick={onCancel}>关闭</Button>}
      onCancel={onCancel}
    >
      {chapters.length === 0 ? (
        <Empty description="当前工作区还没有章节可预览" />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap className="translation-preview-toolbar">
            <Select
              value={selectedChapterId}
              style={isMobile ? { width: '100%' } : { minWidth: 320 }}
              options={chapterOptions}
              onChange={(value) => setSelectedChapterId(value)}
            />
            <Space size={6}>
              <Switch checked={onlyTranslated} onChange={setOnlyTranslated} />
              <Typography.Text>仅看已翻译</Typography.Text>
            </Space>
            <Segmented<PreviewViewMode>
              size="small"
              value={previewMode}
              onChange={(value) => setPreviewMode(value)}
              options={[
                { label: '卡片视图', value: 'card' },
                { label: '安全文本视图', value: 'safe' },
              ]}
            />
            <Input.Search
              allowClear
              placeholder="搜索原文或译文"
              style={isMobile ? { width: '100%' } : { width: 240 }}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
          </Space>

          {preview ? (
            <Space wrap size={[8, 8]}>
              <Tag>{`片段 ${preview.chapter.fragmentCount}`}</Tag>
              <Tag color={preview.chapter.hasTranslationData ? 'green' : 'default'}>
                {`已译 ${preview.chapter.translatedLineCount}/${preview.chapter.sourceLineCount}`}
              </Tag>
              <Tag>{`当前显示 ${filteredUnits.length}/${preview.units.length}`}</Tag>
            </Space>
          ) : null}

          {errorMessage ? (
            <Alert showIcon type="error" message="加载预览失败" description={errorMessage} />
          ) : null}

          {loading ? (
            <div className="translation-preview-loading">
              <Spin />
            </div>
          ) : preview ? (
            filteredUnits.length === 0 ? (
              <Empty
                description={
                  onlyTranslated ? '当前筛选下没有可显示的已翻译内容' : '没有匹配的预览内容'
                }
              />
            ) : (
              previewMode === 'safe' ? (
                <Input.TextArea
                  readOnly
                  autoSize={{ minRows: 18, maxRows: 28 }}
                  value={buildPreviewPlainText(filteredUnits)}
                  className="translation-preview-safe-textarea"
                />
              ) : (
                <div className="translation-preview-card-list">
                  {filteredUnits.map((unit) => (
                    <div key={unit.index} className="translation-preview-card-item">
                      <div className="translation-preview-card-line">
                        <span className="translation-preview-card-marker">○</span>
                        <span className="translation-preview-card-text">
                          {displayPreviewText(unit.sourceText, '（原文为空）')}
                        </span>
                      </div>
                      <div className="translation-preview-card-line">
                        <span className="translation-preview-card-marker">●</span>
                        <span
                          className={`translation-preview-card-text${
                            hasVisibleText(unit.translatedText)
                              ? ''
                              : ' translation-preview-card-text-empty'
                          }`}
                        >
                          {displayPreviewText(unit.translatedText, '（暂无译文）')}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )
            )
          ) : null}
        </Space>
      )}
    </Modal>
  );
}

function hasVisibleText(text: string): boolean {
  return text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim().length > 0;
}

function displayPreviewText(text: string, fallback: string): string {
  return hasVisibleText(text) ? text : fallback;
}

function buildPreviewPlainText(
  units: TranslationPreviewChapter['units'],
): string {
  return units
    .map((unit, index) => {
      const source = displayPreviewText(unit.sourceText, '（原文为空）');
      const target = displayPreviewText(unit.translatedText, '（暂无译文）');
      return `#${index + 1}\n○ ${source}\n● ${target}`;
    })
    .join('\n\n');
}
