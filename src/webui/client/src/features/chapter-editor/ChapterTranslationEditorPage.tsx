import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { lintGutter, linter } from '@codemirror/lint';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { RobotOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { useActiveWorkspaceId } from '../../app/active-workspace-context.ts';
import { api } from '../../app/api.ts';
import type {
  ChapterTranslationAssistantConversationTurn,
  ChapterTranslationAssistantMode,
  ChapterTranslationEditorDiagnostic,
  ChapterTranslationEditorDocument,
  ChapterTranslationEditorRepetitionMatch,
  EditableTranslationFormat,
  GlossaryTerm,
  LlmProfileConfig,
  WorkspaceChapterDescriptor,
} from '../../app/types.ts';
import { toErrorMessage } from '../../app/ui-helpers.ts';
import {
  applyAssistantDraftToSelection,
  buildAssistantGlossaryHints,
  buildAssistantRepetitionHints,
  buildChapterTranslationEditorSelectionSignature,
  collectChapterTranslationEditorSelection,
  type ChapterTranslationEditorSelection,
} from './chapter-editor-assistant.ts';

const EDITOR_FORMAT_OPTIONS: Array<{ label: string; value: EditableTranslationFormat }> = [
  { label: 'Nature Dialog', value: 'naturedialog' },
  { label: 'M3T', value: 'm3t' },
];

type EditorGlossaryDecoration = {
  from: number;
  to: number;
  className: string;
  title: string;
};

type EditorGlossaryHint = {
  position: number;
  text: string;
};

export function ChapterTranslationEditorPage({
  workspaceId,
  chaptersRevision,
}: {
  workspaceId?: string | null;
  chaptersRevision?: number;
}) {
  const { message } = AntdApp.useApp();
  const activeWorkspaceId = useActiveWorkspaceId();
  const resolvedWorkspaceId = workspaceId ?? activeWorkspaceId;
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
  const [llmProfiles, setLlmProfiles] = useState<Record<string, LlmProfileConfig>>({});
  const [defaultLlmProfileName, setDefaultLlmProfileName] = useState<string>();
  const [selectedLlmProfileName, setSelectedLlmProfileName] = useState<string>();
  const [assistantSelection, setAssistantSelection] = useState<ChapterTranslationEditorSelection | null>(
    null,
  );
  const [assistantModalOpen, setAssistantModalOpen] = useState(false);
  const [assistantMode, setAssistantMode] = useState<ChapterTranslationAssistantMode>('question');
  const [assistantConversation, setAssistantConversation] = useState<
    ChapterTranslationAssistantConversationTurn[]
  >([]);
  const [assistantInput, setAssistantInput] = useState('');
  const [assistantDraft, setAssistantDraft] = useState('');
  const [assistantSending, setAssistantSending] = useState(false);
  const [assistantAnchor, setAssistantAnchor] = useState<{ top: number; left: number } | null>(null);
  const editorShellRef = useRef<HTMLDivElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const pendingEditorScrollRef = useRef<{ top: number; left: number } | null>(null);
  const assistantSelectionSignatureRef = useRef('');

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
    if (!resolvedWorkspaceId) {
      setChapters([]);
      setDictionary([]);
      setDraft(null);
      setContent('');
      setDiagnostics([]);
      setSelectedChapterId(undefined);
      setLoading(false);
      setErrorMessage(undefined);
      return;
    }

    setLoading(true);
    setErrorMessage(undefined);
    void Promise.all([
      api.getChapters(resolvedWorkspaceId).catch(() => ({ chapters: [] })),
      api.getDictionary(resolvedWorkspaceId).catch(() => ({ terms: [] })),
      api.getLlmProfiles().catch(
        () =>
          ({
            profiles: {} as Record<string, LlmProfileConfig>,
            defaultName: undefined,
          }) satisfies {
            profiles: Record<string, LlmProfileConfig>;
            defaultName?: string;
          },
      ),
    ])
      .then(([chapterResponse, dictionaryResponse, llmResponse]) => {
        if (cancelled) {
          return;
        }
        setChapters(chapterResponse.chapters);
        setDictionary(dictionaryResponse.terms);
        setLlmProfiles(llmResponse.profiles);
        setDefaultLlmProfileName(llmResponse.defaultName);
        setSelectedLlmProfileName((current) => {
          if (current && llmResponse.profiles[current]) {
            return current;
          }
          return llmResponse.defaultName ?? Object.keys(llmResponse.profiles)[0];
        });
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
  }, [resolvedWorkspaceId, selectedChapterId]);

  const loadDraft = useCallback(async () => {
    if (!resolvedWorkspaceId || !selectedChapterId) {
      setDraft(null);
      setContent('');
      setDiagnostics([]);
      return;
    }

    setLoading(true);
    setErrorMessage(undefined);
    try {
      const nextDraft = await api.getChapterEditorDocument(
        selectedChapterId,
        format,
        resolvedWorkspaceId,
      );
      setDraft(nextDraft);
      setContent(nextDraft.content);
      setDiagnostics(nextDraft.diagnostics);
      setDirty(false);
      setAssistantSelection(null);
      setAssistantModalOpen(false);
      setAssistantConversation([]);
      setAssistantInput('');
      setAssistantDraft('');
      setAssistantAnchor(null);
      assistantSelectionSignatureRef.current = '';
      navigate(`/workspace/editor/${selectedChapterId}`, { replace: true });
    } catch (error) {
      setDraft(null);
      setContent('');
      setDiagnostics([]);
      setErrorMessage(toErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [format, navigate, resolvedWorkspaceId, selectedChapterId]);

  useEffect(() => {
    void loadDraft();
  }, [loadDraft]);

  // 当后端章节内容被外部任务（如校对）更新时，自动重拉内容
  useEffect(() => {
    if (!chaptersRevision || dirty) {
      return;
    }
    void loadDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chaptersRevision]);

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
        }, resolvedWorkspaceId ?? undefined)
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
  }, [content, dirty, draft, format, resolvedWorkspaceId, selectedChapterId]);

  const glossaryRender = useMemo(
    () => buildGlossaryRenderState(content, format, dictionary, draft?.repetitionMatches ?? []),
    [content, dictionary, draft?.repetitionMatches, format],
  );

  const editorExtensions = useMemo(() => {
    const decorations = Decoration.set(
      [
        ...glossaryRender.highlights.map((match) =>
          Decoration.mark({
            class: match.className,
            attributes: {
              title: match.title,
            },
          }).range(match.from, match.to),
        ),
        ...glossaryRender.hints.map((hint) =>
          Decoration.widget({
            widget: new InlineGlossaryHintWidget(hint.text),
            side: 1,
          }).range(hint.position),
        ),
      ],
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
  }, [diagnostics, glossaryRender, isDarkMode]);

  const chapterOptions = useMemo(
    () =>
      chapters.map((chapter) => ({
        label: `Ch${chapter.id} · ${chapter.filePath}`,
        value: chapter.id,
      })),
    [chapters],
  );

  const llmProfileOptions = useMemo(
    () =>
      Object.keys(llmProfiles)
        .sort()
        .map((name) => ({
          label: name,
          value: name,
        })),
    [llmProfiles],
  );

  useEffect(() => {
    if (selectedLlmProfileName && llmProfiles[selectedLlmProfileName]) {
      return;
    }
    setSelectedLlmProfileName(defaultLlmProfileName ?? llmProfileOptions[0]?.value);
  }, [defaultLlmProfileName, llmProfileOptions, llmProfiles, selectedLlmProfileName]);

  const changedLineCount = useMemo(
    () => (draft ? countChangedLines(draft.content, content) : 0),
    [content, draft],
  );

  const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  const warningCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length;

  const resetAssistantSession = useCallback(() => {
    assistantSelectionSignatureRef.current = '';
    setAssistantMode('question');
    setAssistantConversation([]);
    setAssistantInput('');
    setAssistantDraft('');
    setAssistantModalOpen(false);
    setAssistantAnchor(null);
  }, []);

  const syncAssistantSelectionFromView = useCallback(
    (view: EditorView) => {
      if (!draft) {
        setAssistantSelection(null);
        setAssistantAnchor(null);
        resetAssistantSession();
        return;
      }

      const selection = view.state.selection.main;
      const nextSelection = collectChapterTranslationEditorSelection({
        content,
        draft,
        from: selection.from,
        to: selection.to,
      });
      const nextSignature = buildChapterTranslationEditorSelectionSignature(nextSelection);
      const previousSignature = assistantSelectionSignatureRef.current;
      assistantSelectionSignatureRef.current = nextSignature;
      setAssistantSelection(nextSelection);

      if (!nextSelection) {
        setAssistantAnchor(null);
        if (previousSignature) {
          resetAssistantSession();
        }
        return;
      }

      const shellRect = editorShellRef.current?.getBoundingClientRect();
      const headCoords = view.coordsAtPos(selection.to) ?? view.coordsAtPos(selection.from);
      if (!shellRect || !headCoords) {
        setAssistantAnchor(null);
      } else {
        setAssistantAnchor({
          top: Math.max(0, headCoords.top - shellRect.top - 40),
          left: Math.max(12, headCoords.right - shellRect.left + 8),
        });
      }

      if (nextSignature !== previousSignature) {
        setAssistantMode('question');
        setAssistantModalOpen(false);
        setAssistantConversation([]);
        setAssistantInput('');
        setAssistantDraft('');
      }
    },
    [content, draft, resetAssistantSession],
  );

  const handleOpenAssistant = useCallback(() => {
    if (!assistantSelection || assistantSelection.units.length === 0) {
      message.warning('请先选中至少一个翻译单元');
      return;
    }
    if (!selectedLlmProfileName) {
      message.warning('请先选择一个可用的 LLM 配置');
      return;
    }
    setAssistantModalOpen(true);
  }, [assistantSelection, message, selectedLlmProfileName]);

  const handleAssistantModeChange = useCallback(
    (mode: ChapterTranslationAssistantMode) => {
      setAssistantMode(mode);
      setAssistantConversation([]);
      setAssistantDraft('');
      setAssistantInput('');
    },
    [],
  );

  const handleApplyAssistantDraft = useCallback(() => {
    if (!draft || !assistantSelection || assistantMode === 'question' || !assistantDraft.trim()) {
      return;
    }
    const nextContent = applyAssistantDraftToSelection({
      content,
      draft,
      selection: assistantSelection,
      draftText: assistantDraft,
    });
    if (!nextContent) {
      message.warning('AI 草稿与选区行数不一致，暂时无法直接合并');
      return;
    }
    setContent(nextContent);
    setDirty(nextContent !== draft?.content);
    setAssistantModalOpen(false);
    setAssistantDraft('');
    setAssistantConversation([]);
    setAssistantInput('');
    setAssistantSelection(null);
    setAssistantAnchor(null);
    assistantSelectionSignatureRef.current = '';
  }, [assistantDraft, assistantMode, assistantSelection, content, draft, message]);

  const handleSendAssistantMessage = useCallback(async () => {
    if (!assistantSelection || assistantSelection.units.length === 0) {
      message.warning('请先选中至少一个翻译单元');
      return;
    }
    if (!selectedLlmProfileName) {
      message.warning('请先选择一个可用的 LLM 配置');
      return;
    }
    const instruction = assistantInput.trim();
    if (!instruction) {
      message.warning('请输入要发送给 AI 的内容');
      return;
    }

    setAssistantDraft('');
    setAssistantSending(true);
    try {
      const glossaryHints =
        assistantMode === 'polish' ? [] : buildAssistantGlossaryHints(assistantSelection, dictionary);
      const repetitionHints =
        assistantMode === 'polish'
          ? []
          : buildAssistantRepetitionHints(assistantSelection, draft?.repetitionMatches ?? []);
      const result = await api.runChapterTranslationAssistant({
        chapterId: selectedChapterId ?? draft?.baseline.chapterId ?? 0,
        format,
        llmProfileName: selectedLlmProfileName,
        mode: assistantMode,
        selectedUnits: assistantSelection.units.map((unit) => ({
          id: String(unit.unitIndex + 1),
          sourceText: unit.sourceText,
          translatedText: unit.currentTranslation,
        })),
        conversationTurns: assistantConversation,
        instruction,
        glossaryHints,
        repetitionHints,
      }, resolvedWorkspaceId ?? undefined);

      setAssistantConversation((previous) => [
        ...previous,
        { role: 'user', content: instruction },
        { role: 'assistant', content: result.assistantText },
      ]);
      setAssistantDraft(result.assistantText);
      setAssistantInput('');
    } catch (error) {
      message.error(toErrorMessage(error));
    } finally {
      setAssistantSending(false);
    }
  }, [
    assistantConversation,
    assistantInput,
    assistantMode,
    assistantSelection,
    dictionary,
    draft?.repetitionMatches,
    format,
    message,
    resolvedWorkspaceId,
    selectedChapterId,
    selectedLlmProfileName,
  ]);

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
      }, resolvedWorkspaceId ?? undefined);
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
  }, [content, format, message, resolvedWorkspaceId, selectedChapterId]);

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
      }, resolvedWorkspaceId ?? undefined);
      setDiagnostics(result.validation.diagnostics);
      if (!result.validation.canApply) {
        message.error('提交失败，请先修复格式问题');
        return;
      }
      const nextContent = result.validation.normalizedContent;
      if (nextContent !== content) {
        const view = editorViewRef.current;
        if (view) {
          pendingEditorScrollRef.current = {
            top: view.scrollDOM.scrollTop,
            left: view.scrollDOM.scrollLeft,
          };
        }
      }
      setContent(nextContent);
      setDraft((current) =>
        current
          ? {
              ...current,
              content: nextContent,
              diagnostics: result.validation.diagnostics,
            }
          : current,
      );
      message.success(`已回写 ${result.appliedUpdateCount} 行译文`);
    } catch (error) {
      message.error(toErrorMessage(error));
    } finally {
      setApplying(false);
    }
  }, [content, format, message, resolvedWorkspaceId, selectedChapterId]);

  useLayoutEffect(() => {
    const scrollPosition = pendingEditorScrollRef.current;
    if (!scrollPosition) {
      return;
    }
    const view = editorViewRef.current;
    if (!view) {
      return;
    }

    view.scrollDOM.scrollTop = scrollPosition.top;
    view.scrollDOM.scrollLeft = scrollPosition.left;
    pendingEditorScrollRef.current = null;
  }, [content]);

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
            <Select
              style={{ minWidth: 220 }}
              placeholder="选择 AI 模型"
              value={selectedLlmProfileName}
              options={llmProfileOptions}
              onChange={(value) => setSelectedLlmProfileName(value)}
              disabled={llmProfileOptions.length === 0}
            />
            <Tag color={dirty ? 'gold' : 'green'}>{dirty ? '未提交修改' : '与草稿一致'}</Tag>
            <Tag>{`术语命中 ${glossaryRender.highlights.length}`}</Tag>
            <Tag color={assistantSelection ? 'blue' : 'default'}>
              {assistantSelection ? `AI 选区 ${assistantSelection.units.length}` : 'AI 选区为空'}
            </Tag>
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

              <div className="chapter-editor-shell" ref={editorShellRef}>
                {assistantAnchor && assistantSelection ? (
                  <Tooltip title="AI 辅助">
                    <Button
                      className="chapter-editor-assistant-trigger"
                      type="primary"
                      shape="circle"
                      icon={<RobotOutlined />}
                      size="small"
                      style={{ top: assistantAnchor.top, left: assistantAnchor.left }}
                      onClick={() => handleOpenAssistant()}
                    />
                  </Tooltip>
                ) : null}
                <CodeMirror
                  value={content}
                  height="100%"
                  basicSetup={{
                    foldGutter: false,
                    highlightActiveLineGutter: true,
                  }}
                  extensions={editorExtensions}
                  onCreateEditor={(view) => {
                    editorViewRef.current = view;
                    syncAssistantSelectionFromView(view);
                  }}
                  onUpdate={(viewUpdate) => {
                    editorViewRef.current = viewUpdate.view;
                    if (
                      viewUpdate.selectionSet ||
                      viewUpdate.docChanged ||
                      viewUpdate.geometryChanged ||
                      viewUpdate.viewportChanged
                    ) {
                      syncAssistantSelectionFromView(viewUpdate.view);
                    }
                  }}
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

          <Modal
            open={assistantModalOpen}
            title="AI 辅助"
            width={920}
            onCancel={() => setAssistantModalOpen(false)}
            footer={null}
            destroyOnClose
          >
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Space wrap>
                <Select
                  style={{ minWidth: 180 }}
                  value={assistantMode}
                  options={[
                    { label: '提问', value: 'question' },
                    { label: '修改', value: 'modify' },
                    { label: '润色', value: 'polish' },
                  ]}
                  onChange={(value) => handleAssistantModeChange(value as ChapterTranslationAssistantMode)}
                />
                <Tag>{`选中 ${assistantSelection?.units.length ?? 0} 个单元`}</Tag>
                <Tag>{assistantMode === 'question' ? '多轮会话会保留当前选区上下文' : '草稿可直接合并回编辑器'}</Tag>
              </Space>

              <div className="chapter-editor-assistant-selection">
                <Typography.Text strong>当前选区</Typography.Text>
                <div className="chapter-editor-assistant-selection-list">
                  {assistantSelection?.units.map((unit) => (
                    <div key={unit.unitIndex} className="chapter-editor-assistant-selection-item">
                      <Typography.Text code>{`#${unit.unitIndex + 1}`}</Typography.Text>
                      <Typography.Paragraph style={{ marginBottom: 0 }}>
                        <strong>原文：</strong>
                        {unit.sourceText}
                        <br />
                        <strong>译文：</strong>
                        {unit.currentTranslation}
                      </Typography.Paragraph>
                    </div>
                  ))}
                </div>
              </div>

              {assistantConversation.length > 0 ? (
                <div className="chapter-editor-assistant-thread">
                  {assistantConversation.map((turn, index) => (
                    <div key={`${turn.role}-${index}`} className={`chapter-editor-assistant-message chapter-editor-assistant-message-${turn.role}`}>
                      <Typography.Text type="secondary">
                        {turn.role === 'user' ? '你' : 'AI'}
                      </Typography.Text>
                      <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                        {turn.content}
                      </Typography.Paragraph>
                    </div>
                  ))}
                </div>
              ) : null}

              {assistantMode !== 'question' && assistantDraft ? (
                <Alert
                  type="info"
                  showIcon
                  message="修改草稿"
                  description={
                    <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                      {assistantDraft}
                    </Typography.Paragraph>
                  }
                />
              ) : null}

              <Input.TextArea
                value={assistantInput}
                onChange={(event) => setAssistantInput(event.target.value)}
                autoSize={{ minRows: 3, maxRows: 8 }}
                placeholder={
                  assistantMode === 'question'
                    ? '输入你的问题或要求...'
                    : assistantMode === 'modify'
                      ? '输入修改要求，例如：更自然、更口语化、保留专有名词...'
                      : '输入润色要求，例如：更自然、去掉翻译腔...'
                }
              />

              <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
                <Button onClick={() => setAssistantModalOpen(false)}>关闭</Button>
                {assistantMode !== 'question' && assistantDraft ? (
                  <Button onClick={handleApplyAssistantDraft}>接受并合并</Button>
                ) : null}
                <Button type="primary" loading={assistantSending} onClick={() => void handleSendAssistantMessage()}>
                  发送
                </Button>
              </Space>
            </Space>
          </Modal>
        </Space>
      </Card>
    </div>
  );
}

function buildGlossaryRenderState(
  content: string,
  format: EditableTranslationFormat,
  glossaryTerms: GlossaryTerm[],
  repetitionMatches: ChapterTranslationEditorRepetitionMatch[],
): {
  highlights: EditorGlossaryDecoration[];
  hints: EditorGlossaryHint[];
} {
  const lines = classifyEditorLines(content, format);
  const highlights: EditorGlossaryDecoration[] = [];
  const hints: EditorGlossaryHint[] = [];
  const sourceLines = lines.filter((line) => line.kind === 'source');

  for (const line of lines) {
    if (line.kind === 'source') {
      const matchedTerms = glossaryTerms
        .map((glossaryTerm) => ({
          term: glossaryTerm.term.trim(),
          translation: glossaryTerm.translation?.trim() ?? '',
        }))
        .filter((glossaryTerm) => glossaryTerm.term.length > 0 && line.body.includes(glossaryTerm.term));

      for (const matchedTerm of matchedTerms) {
        for (const occurrence of findAllOccurrences(line.body, matchedTerm.term)) {
          highlights.push({
            from: line.bodyFrom + occurrence.from,
            to: line.bodyFrom + occurrence.to,
            className: 'chapter-editor-match-source',
            title: matchedTerm.translation
              ? `术语：${matchedTerm.term} -> ${matchedTerm.translation}`
              : `术语：${matchedTerm.term}`,
          });
        }
      }

      const hintText = matchedTerms
        .filter((matchedTerm) => matchedTerm.translation.length > 0)
        .filter(
          (matchedTerm, index, allTerms) =>
            allTerms.findIndex((term) => term.term === matchedTerm.term) === index,
        )
        .map((matchedTerm) => `${matchedTerm.term} -> ${matchedTerm.translation}`)
        .join('  ');
      if (hintText) {
        hints.push({
          position: line.to,
          text: hintText,
        });
      }
      continue;
    }

    if (line.kind === 'target') {
      for (const glossaryTerm of glossaryTerms) {
        const translation = glossaryTerm.translation?.trim();
        if (!translation || !line.body.includes(translation)) {
          continue;
        }
        for (const occurrence of findAllOccurrences(line.body, translation)) {
          highlights.push({
            from: line.bodyFrom + occurrence.from,
            to: line.bodyFrom + occurrence.to,
            className: 'chapter-editor-match-target',
            title: `术语译文：${glossaryTerm.term.trim()} -> ${translation}`,
          });
        }
      }
    }
  }

  for (const match of repetitionMatches) {
    const line = sourceLines[match.unitIndex];
    if (!line) {
      continue;
    }
    const from = line.bodyFrom + match.matchStartInSentence;
    const to = line.bodyFrom + match.matchEndInSentence;
    if (from < line.bodyFrom || to > line.bodyFrom + line.body.length || from >= to) {
      continue;
    }
    highlights.push({
      from,
      to,
      className: 'chapter-editor-match-pattern',
      title: match.hoverText,
    });
  }

  return {
    highlights: highlights.sort((left, right) => left.from - right.from || right.to - left.to),
    hints,
  };
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

function classifyEditorLines(
  content: string,
  format: EditableTranslationFormat,
): Array<{
  kind: 'source' | 'target' | 'name' | 'blank' | 'other';
  from: number;
  to: number;
  bodyFrom: number;
  body: string;
}> {
  const rawLines = content.split(/\r?\n/);
  const lines: Array<{
    kind: 'source' | 'target' | 'name' | 'blank' | 'other';
    from: number;
    to: number;
    bodyFrom: number;
    body: string;
  }> = [];
  let offset = 0;
  let expectSource = true;
  let pendingNamedSource = false;

  for (const rawLine of rawLines) {
    const lineFrom = offset;
    const lineTo = lineFrom + rawLine.length;
    offset = lineTo + 1;
    const trimmed = rawLine.trim();

    if (!trimmed) {
      lines.push({
        kind: 'blank',
        from: lineFrom,
        to: lineTo,
        bodyFrom: lineTo,
        body: '',
      });
      if (format === 'naturedialog') {
        expectSource = true;
      }
      continue;
    }

    if (format === 'm3t') {
      if (trimmed.startsWith('○ NAME:')) {
        pendingNamedSource = true;
        expectSource = true;
        lines.push({
          kind: 'name',
          from: lineFrom,
          to: lineTo,
          bodyFrom: lineFrom + rawLine.indexOf('NAME:') + 'NAME:'.length,
          body: trimmed.slice('○ NAME:'.length).trim(),
        });
        continue;
      }
      if (trimmed.startsWith('○')) {
        const prefixLength = rawLine.indexOf('○') + 1 + (rawLine.slice(rawLine.indexOf('○') + 1).startsWith(' ') ? 1 : 0);
        const kind = pendingNamedSource || expectSource ? 'source' : 'target';
        lines.push({
          kind,
          from: lineFrom,
          to: lineTo,
          bodyFrom: lineFrom + prefixLength,
          body: rawLine.slice(prefixLength),
        });
        pendingNamedSource = false;
        expectSource = false;
        continue;
      }
      if (trimmed.startsWith('●')) {
        const prefixLength = rawLine.indexOf('●') + 1 + (rawLine.slice(rawLine.indexOf('●') + 1).startsWith(' ') ? 1 : 0);
        lines.push({
          kind: 'target',
          from: lineFrom,
          to: lineTo,
          bodyFrom: lineFrom + prefixLength,
          body: rawLine.slice(prefixLength),
        });
        expectSource = true;
        pendingNamedSource = false;
        continue;
      }
    }

    if (format === 'naturedialog') {
      if (trimmed.startsWith('○')) {
        const prefixLength = rawLine.indexOf('○') + 1 + (rawLine.slice(rawLine.indexOf('○') + 1).startsWith(' ') ? 1 : 0);
        lines.push({
          kind: expectSource ? 'source' : 'target',
          from: lineFrom,
          to: lineTo,
          bodyFrom: lineFrom + prefixLength,
          body: rawLine.slice(prefixLength),
        });
        expectSource = false;
        continue;
      }
      if (trimmed.startsWith('●')) {
        const prefixLength = rawLine.indexOf('●') + 1 + (rawLine.slice(rawLine.indexOf('●') + 1).startsWith(' ') ? 1 : 0);
        lines.push({
          kind: 'target',
          from: lineFrom,
          to: lineTo,
          bodyFrom: lineFrom + prefixLength,
          body: rawLine.slice(prefixLength),
        });
        expectSource = true;
        continue;
      }
    }

    lines.push({
      kind: 'other',
      from: lineFrom,
      to: lineTo,
      bodyFrom: lineFrom,
      body: rawLine,
    });
  }

  return lines;
}

class InlineGlossaryHintWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }

  override eq(other: InlineGlossaryHintWidget): boolean {
    return other.text === this.text;
  }

  override toDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = 'chapter-editor-inline-glossary-hint';
    element.textContent = this.text;
    return element;
  }

  override ignoreEvent(): boolean {
    return true;
  }
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
