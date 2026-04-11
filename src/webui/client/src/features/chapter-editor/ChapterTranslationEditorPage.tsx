import { useCallback, useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { lintGutter, linter } from '@codemirror/lint';
import { Decoration, EditorView } from '@codemirror/view';
import { Alert, App as AntdApp, Button, Card, Empty, Select, Space, Spin, Tag, Typography } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../app/api.ts';
import type {
  ChapterTranslationEditorDiagnostic,
  ChapterTranslationEditorDocument,
  ChapterTranslationEditorGlossaryMatch,
  EditableTranslationFormat,
  GlossaryTerm,
  WorkspaceChapterDescriptor,
} from '../../app/types.ts';
import { toErrorMessage } from '../../app/ui-helpers.ts';

const EDITOR_FORMAT_OPTIONS: Array<{ label: string; value: EditableTranslationFormat }> = [
  { label: 'Nature Dialog', value: 'naturedialog' },
  { label: 'M3T', value: 'm3t' },
];

export function ChapterTranslationEditorPage() {
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const params = useParams<{ chapterId?: string }>();
  const [isDarkMode, setIsDarkMode] = useState(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const [chapters, setChapters] = useState<WorkspaceChapterDescriptor[]>([]);
  const [dictionary, setDictionary] = useState<GlossaryTerm[]>([]);
  const [selectedChapterId, setSelectedChapterId] = useState<number>();
  const [format, setFormat] = useState<EditableTranslationFormat>('naturedialog');
  const [draft, setDraft] = useState<ChapterTranslationEditorDocument | null>(null);
  const [content, setContent] = useState('');
  const [diagnostics, setDiagnostics] = useState<ChapterTranslationEditorDiagnostic[]>([]);
  const [loading, setLoading] = useState(true);
  const [validating, setValidating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => {
      setIsDarkMode(event.matches);
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, []);

  useEffect(() => {
    const requestedChapterId = Number(params.chapterId);
    if (Number.isInteger(requestedChapterId) && requestedChapterId > 0) {
      setSelectedChapterId(requestedChapterId);
    }
  }, [params.chapterId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorMessage(undefined);
    void Promise.all([
      api.getChapters().catch(() => ({ chapters: [] })),
      api.getDictionary().catch(() => ({ terms: [] })),
    ])
      .then(([chapterResponse, dictionaryResponse]) => {
        if (cancelled) {
          return;
        }
        setChapters(chapterResponse.chapters);
        setDictionary(dictionaryResponse.terms);
        if (selectedChapterId && chapterResponse.chapters.some((chapter) => chapter.id === selectedChapterId)) {
          return;
        }
        const fallbackChapterId =
          chapterResponse.chapters.find((chapter) => chapter.hasTranslationData)?.id ??
          chapterResponse.chapters[0]?.id;
        setSelectedChapterId(fallbackChapterId);
      })
      .catch((error) => {
        if (!cancelled) {
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
  }, [selectedChapterId]);

  const loadDraft = useCallback(async () => {
    if (!selectedChapterId) {
      setDraft(null);
      setContent('');
      setDiagnostics([]);
      return;
    }

    setLoading(true);
    setErrorMessage(undefined);
    try {
      const nextDraft = await api.getChapterEditorDocument(selectedChapterId, format);
      setDraft(nextDraft);
      setContent(nextDraft.content);
      setDiagnostics(nextDraft.diagnostics);
      setDirty(false);
      navigate(`/workspace/editor/${selectedChapterId}`, { replace: true });
    } catch (error) {
      setDraft(null);
      setContent('');
      setDiagnostics([]);
      setErrorMessage(toErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [format, navigate, selectedChapterId]);

  useEffect(() => {
    void loadDraft();
  }, [loadDraft]);

  useEffect(() => {
    if (!dirty || !draft || !selectedChapterId) {
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      setValidating(true);
      void api
        .validateChapterEditor({
          chapterId: selectedChapterId,
          format,
          content,
        })
        .then((result) => {
          if (!cancelled) {
            setDiagnostics(result.diagnostics);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setDiagnostics([]);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setValidating(false);
          }
        });
    }, 500);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [content, dirty, draft, format, selectedChapterId]);

  const glossaryMatches = useMemo(
    () => collectGlossaryMatches(content, dictionary),
    [content, dictionary],
  );

  const editorExtensions = useMemo(() => {
    const decorations = Decoration.set(
      glossaryMatches.map((match) =>
        Decoration.mark({
          class:
            match.kind === 'sourceTerm'
              ? 'chapter-editor-match-source'
              : 'chapter-editor-match-target',
          attributes: {
            title:
              match.kind === 'sourceTerm'
                ? `术语：${match.term}${match.translation ? ` -> ${match.translation}` : ''}`
                : `译文命中：${match.translation ?? match.text}`,
          },
        }).range(match.from, match.to),
      ),
      true,
    );

    return [
      EditorView.lineWrapping,
      EditorView.theme(
        {
          '&': {
            fontSize: '14px',
            backgroundColor: 'var(--editor-bg)',
            color: 'var(--editor-text)',
            minHeight: '62vh',
          },
          '.cm-content': {
            fontFamily: 'var(--font-family)',
            color: 'var(--editor-text)',
            caretColor: 'var(--editor-caret)',
          },
          '.cm-scroller': {
            backgroundColor: 'var(--editor-bg)',
            color: 'var(--editor-text)',
          },
          '.cm-gutters': {
            color: 'var(--editor-gutter-text)',
            backgroundColor: 'var(--editor-gutter-bg)',
            borderRight: '1px solid var(--editor-gutter-border)',
          },
          '.cm-activeLine, .cm-activeLineGutter': {
            backgroundColor: isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(15,23,42,0.05)',
          },
          '.cm-selectionBackground': {
            backgroundColor: isDarkMode ? 'rgba(108,140,255,0.3)' : 'rgba(108,140,255,0.18)',
          },
        },
        { dark: isDarkMode },
      ),
      EditorView.decorations.of(decorations),
      lintGutter(),
      linter(() =>
        diagnostics.map((diagnostic) => ({
          from: diagnostic.from,
          to: diagnostic.to,
          severity: diagnostic.severity,
          message: diagnostic.message,
        })),
      ),
    ];
  }, [diagnostics, glossaryMatches, isDarkMode]);

  const chapterOptions = useMemo(
    () =>
      chapters.map((chapter) => ({
        label: `Ch${chapter.id} · ${chapter.filePath}`,
        value: chapter.id,
      })),
    [chapters],
  );

  const changedLineCount = useMemo(
    () => (draft ? countChangedLines(draft.content, content) : 0),
    [content, draft],
  );

  const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  const warningCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length;

  const handleValidate = useCallback(async () => {
    if (!selectedChapterId) {
      return;
    }
    setValidating(true);
    try {
      const result = await api.validateChapterEditor({
        chapterId: selectedChapterId,
        format,
        content,
      });
      setDiagnostics(result.diagnostics);
      if (result.canApply) {
        message.success('校验通过');
      } else {
        message.warning('校验未通过');
      }
    } catch (error) {
      message.error(toErrorMessage(error));
    } finally {
      setValidating(false);
    }
  }, [content, format, message, selectedChapterId]);

  const handleApply = useCallback(async () => {
    if (!selectedChapterId) {
      return;
    }
    setApplying(true);
    try {
      const result = await api.applyChapterEditor({
        chapterId: selectedChapterId,
        format,
        content,
      });
      setDiagnostics(result.validation.diagnostics);
      if (!result.validation.canApply) {
        message.error('提交失败，请先修复格式问题');
        return;
      }
      setContent(result.validation.normalizedContent);
      message.success(`已回写 ${result.appliedUpdateCount} 行译文`);
      await loadDraft();
    } catch (error) {
      message.error(toErrorMessage(error));
    } finally {
      setApplying(false);
    }
  }, [content, format, loadDraft, message, selectedChapterId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') {
        return;
      }
      event.preventDefault();
      if (!draft || applying) {
        return;
      }
      void handleApply();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [applying, draft, handleApply]);

  return (
    <div className="section-stack">
      <Card
        title="章节翻译文本编辑器"
        extra={
          <Space>
            <Button onClick={() => navigate('/workspace/current?tab=chapters')}>
              返回章节管理
            </Button>
            <Button onClick={() => void loadDraft()} disabled={!selectedChapterId}>
              重新生成草稿
            </Button>
            <Button onClick={() => void handleValidate()} disabled={!draft} loading={validating}>
              校验格式
            </Button>
            <Button type="primary" onClick={() => void handleApply()} disabled={!draft} loading={applying}>
              提交更改 (Ctrl+S)
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="这是独立编辑模块"
            description="当前版本不会接管工作区主界面流程；它把章节内部数据实时投影成 Nature Dialog 或 M3T 文本，允许你直接编辑译文后再做结构化回写。"
          />
          <Typography.Text type="secondary">提示：在本页面按 Ctrl+S / Cmd+S 会直接触发提交并沿用同一套校验逻辑。</Typography.Text>

          <Space wrap className="chapter-editor-toolbar">
            <Select
              placeholder="选择章节"
              style={{ minWidth: 320 }}
              value={selectedChapterId}
              options={chapterOptions}
              onChange={(value) => setSelectedChapterId(value)}
            />
            <Select
              style={{ width: 220 }}
              value={format}
              options={EDITOR_FORMAT_OPTIONS}
              onChange={(value) => setFormat(value)}
            />
            <Tag color={dirty ? 'gold' : 'green'}>{dirty ? '未提交修改' : '与草稿一致'}</Tag>
            <Tag>{`术语命中 ${glossaryMatches.length}`}</Tag>
            <Tag color={errorCount > 0 ? 'red' : 'default'}>{`错误 ${errorCount}`}</Tag>
            <Tag color={warningCount > 0 ? 'gold' : 'default'}>{`警告 ${warningCount}`}</Tag>
            <Tag>{`变更行 ${changedLineCount}`}</Tag>
          </Space>

          {errorMessage ? <Alert type="error" showIcon message="加载编辑器失败" description={errorMessage} /> : null}

          {loading ? (
            <div className="translation-preview-loading">
              <Spin />
            </div>
          ) : !selectedChapterId ? (
            <Empty description="当前工作区没有可编辑章节" />
          ) : draft ? (
            <>
              <Space wrap size={[8, 8]}>
                <Tag>{`基线单元 ${draft.baseline.unitCount}`}</Tag>
                <Tag>{`基线行数 ${draft.baseline.rawLineCount}`}</Tag>
                <Tag>{`当前格式 ${draft.baseline.format}`}</Tag>
              </Space>

              <div className="chapter-editor-shell">
                <CodeMirror
                  value={content}
                  height="100%"
                  basicSetup={{
                    foldGutter: false,
                    highlightActiveLineGutter: true,
                  }}
                  extensions={editorExtensions}
                  onChange={(value) => {
                    setContent(value);
                    setDirty(value !== draft.content);
                  }}
                />
              </div>

              <Card size="small" title="校验结果">
                {diagnostics.length === 0 ? (
                  <Typography.Text type="secondary">
                    {validating ? '正在后台校验…' : '当前没有诊断信息'}
                  </Typography.Text>
                ) : (
                  <div className="chapter-editor-diagnostic-list">
                    {diagnostics.map((diagnostic, index) => (
                      <div
                        key={`${diagnostic.code}-${diagnostic.from}-${index}`}
                        className={`chapter-editor-diagnostic-item chapter-editor-diagnostic-item-${diagnostic.severity}`}
                      >
                        <Space size={8} wrap>
                          <Tag color={diagnostic.severity === 'error' ? 'red' : 'gold'}>
                            {diagnostic.severity === 'error' ? '错误' : '警告'}
                          </Tag>
                          <Typography.Text code>{diagnostic.code}</Typography.Text>
                          <Typography.Text type="secondary">
                            {`L${diagnostic.startLineNumber}-${diagnostic.endLineNumber}`}
                          </Typography.Text>
                        </Space>
                        <Typography.Paragraph style={{ marginBottom: 0, marginTop: 6 }}>
                          {diagnostic.message}
                        </Typography.Paragraph>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </>
          ) : null}
        </Space>
      </Card>
    </div>
  );
}

function collectGlossaryMatches(
  content: string,
  glossaryTerms: GlossaryTerm[],
): ChapterTranslationEditorGlossaryMatch[] {
  const matches: ChapterTranslationEditorGlossaryMatch[] = [];
  for (const glossaryTerm of glossaryTerms) {
    const term = glossaryTerm.term.trim();
    if (term) {
      matches.push(
        ...findAllOccurrences(content, term).map(({ from, to }) => ({
          from,
          to,
          text: content.slice(from, to),
          term,
          translation: glossaryTerm.translation,
          kind: 'sourceTerm' as const,
        })),
      );
    }

    const translation = glossaryTerm.translation?.trim();
    if (translation) {
      matches.push(
        ...findAllOccurrences(content, translation).map(({ from, to }) => ({
          from,
          to,
          text: content.slice(from, to),
          term,
          translation,
          kind: 'targetTranslation' as const,
        })),
      );
    }
  }
  return matches.sort((left, right) => left.from - right.from || right.to - left.to);
}

function findAllOccurrences(content: string, query: string): Array<{ from: number; to: number }> {
  const matches: Array<{ from: number; to: number }> = [];
  let startIndex = 0;
  while (startIndex < content.length) {
    const index = content.indexOf(query, startIndex);
    if (index === -1) {
      break;
    }
    matches.push({ from: index, to: index + query.length });
    startIndex = index + Math.max(query.length, 1);
  }
  return matches;
}

function countChangedLines(previousText: string, nextText: string): number {
  const previousLines = previousText.split(/\r?\n/);
  const nextLines = nextText.split(/\r?\n/);
  const maxLength = Math.max(previousLines.length, nextLines.length);
  let changedCount = 0;
  for (let index = 0; index < maxLength; index += 1) {
    if ((previousLines[index] ?? '') !== (nextLines[index] ?? '')) {
      changedCount += 1;
    }
  }
  return changedCount;
}
