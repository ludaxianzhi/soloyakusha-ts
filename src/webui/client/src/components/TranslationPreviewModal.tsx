import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
} from 'antd';
import type { WorkspaceChapterDescriptor, TranslationPreviewChapter } from '../app/types.ts';
import { api } from '../app/api.ts';
import { toErrorMessage } from '../app/ui-helpers.ts';

interface TranslationPreviewModalProps {
  open: boolean;
  chapters: WorkspaceChapterDescriptor[];
  onCancel: () => void;
}

export function TranslationPreviewModal({
  open,
  chapters,
  onCancel,
}: TranslationPreviewModalProps) {
  const [selectedChapterId, setSelectedChapterId] = useState<number>();
  const [preview, setPreview] = useState<TranslationPreviewChapter | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [onlyTranslated, setOnlyTranslated] = useState(false);
  const [keyword, setKeyword] = useState('');

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
    setSelectedChapterId((current) =>
      current && chapters.some((chapter) => chapter.id === current) ? current : fallbackChapterId,
    );
  }, [chapters, open]);

  useEffect(() => {
    if (!open || selectedChapterId === undefined) {
      return;
    }

    let cancelled = false;
    setLoading(true);
    setErrorMessage(undefined);
    void api
      .getChapterPreview(selectedChapterId)
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
  }, [open, selectedChapterId]);

  const filteredUnits = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return (preview?.units ?? []).filter((unit) => {
      if (onlyTranslated && !unit.hasTranslation) {
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
      width={1040}
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
              style={{ minWidth: 320 }}
              options={chapterOptions}
              onChange={(value) => setSelectedChapterId(value)}
            />
            <Space size={6}>
              <Switch checked={onlyTranslated} onChange={setOnlyTranslated} />
              <Typography.Text>仅看已翻译</Typography.Text>
            </Space>
            <Input.Search
              allowClear
              placeholder="搜索原文或译文"
              style={{ width: 240 }}
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
              <div className="translation-preview-list">
                {filteredUnits.map((unit) => (
                  <div key={unit.index} className="translation-preview-unit">
                    <div className="translation-preview-line source">
                      <span className="translation-preview-marker">○</span>
                      <div className="translation-preview-text">{unit.sourceText}</div>
                    </div>
                    <div
                      className={`translation-preview-line target${
                        unit.hasTranslation ? '' : ' empty'
                      }`}
                    >
                      <span className="translation-preview-marker">●</span>
                      <div className="translation-preview-text">
                        {unit.translatedText || '（暂无译文）'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : null}
        </Space>
      )}
    </Modal>
  );
}
