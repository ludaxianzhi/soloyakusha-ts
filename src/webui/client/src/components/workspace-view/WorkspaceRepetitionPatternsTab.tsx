import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BranchesOutlined, CloseOutlined, RobotOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Empty,
  InputNumber,
  Modal,
  Progress,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { Input } from 'antd';
import type {
  RepetitionPatternAnalysis,
  RepetitionPatternAnalysisResult,
  RepetitionPatternConsistencyFixProgress,
  RepetitionPatternContextResult,
  RepetitionPatternLocation,
  SavedRepetitionPatternAnalysisResult,
  SavedRepetitionPatternLocation,
  StoryTopologyDescriptor,
  StoryTopologyRouteDescriptor,
  WorkspaceChapterDescriptor,
} from '../../app/types.ts';
import { usePollingTask } from '../../app/usePollingTask.ts';

const { TextArea } = Input;

type RepetitionPatternScopeSelection = {
  mode: 'all' | 'custom';
  chapterIds: number[];
  routeIds: string[];
};

interface WorkspaceRepetitionPatternsTabProps {
  active: boolean;
  repeatedPatterns: SavedRepetitionPatternAnalysisResult | null;
  chapters: WorkspaceChapterDescriptor[];
  topology: StoryTopologyDescriptor | null;
  llmProfileOptions: Array<{ label: string; value: string }>;
  defaultLlmProfileName?: string;
  onRefreshRepeatedPatterns: (options?: {
    chapterIds?: number[];
  }) => Promise<SavedRepetitionPatternAnalysisResult | null>;
  onScanRepeatedPatterns: (options?: {
    minOccurrences?: number;
    minLength?: number;
    maxResults?: number;
  }) => Promise<SavedRepetitionPatternAnalysisResult | null>;
  onHydrateRepeatedPatterns: (input: {
    chapterIds?: number[];
    patternTexts?: string[];
  }) => Promise<RepetitionPatternAnalysisResult | null>;
  onSaveRepeatedPatternTranslation: (input: {
    chapterId: number;
    fragmentIndex: number;
    lineIndex: number;
    translation: string;
  }) => Promise<void>;
  onLoadRepeatedPatternContext: (input: {
    chapterId: number;
    unitIndex: number;
  }) => Promise<RepetitionPatternContextResult>;
  onRefreshProjectStatus: () => void | Promise<void>;
  onStartRepeatedPatternConsistencyFix: (input: {
    llmProfileName: string;
    chapterIds?: number[];
  }) => Promise<RepetitionPatternConsistencyFixProgress>;
  onGetRepeatedPatternConsistencyFixStatus: () => Promise<RepetitionPatternConsistencyFixProgress | null>;
  onClearRepeatedPatternConsistencyFixStatus: () => Promise<void>;
}

export function WorkspaceRepetitionPatternsTab({
  active,
  repeatedPatterns,
  chapters,
  topology,
  llmProfileOptions,
  defaultLlmProfileName,
  onRefreshRepeatedPatterns,
  onScanRepeatedPatterns,
  onHydrateRepeatedPatterns,
  onSaveRepeatedPatternTranslation,
  onLoadRepeatedPatternContext,
  onRefreshProjectStatus,
  onStartRepeatedPatternConsistencyFix,
  onGetRepeatedPatternConsistencyFixStatus,
  onClearRepeatedPatternConsistencyFixStatus,
}: WorkspaceRepetitionPatternsTabProps) {
  const { message } = AntdApp.useApp();
  const [loading, setLoading] = useState(false);
  const [hydrating, setHydrating] = useState(false);
  const [savingLineKey, setSavingLineKey] = useState<string | null>(null);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [startingConsistencyFix, setStartingConsistencyFix] = useState(false);
  const [draftTranslations, setDraftTranslations] = useState<Record<string, string>>({});
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailContext, setDetailContext] = useState<RepetitionPatternContextResult | null>(null);
  const [consistencyFixProgress, setConsistencyFixProgress] =
    useState<RepetitionPatternConsistencyFixProgress | null>(null);
  const [consistencyFixDismissed, setConsistencyFixDismissed] = useState(false);
  const [selectedLlmProfileName, setSelectedLlmProfileName] = useState<string | undefined>(
    defaultLlmProfileName,
  );
  const [minOccurrences, setMinOccurrences] = useState(3);
  const [minLength, setMinLength] = useState(8);
  const [maxResults, setMaxResults] = useState(20);
  const [scopeSelection, setScopeSelection] = useState<RepetitionPatternScopeSelection>({
    mode: 'all',
    chapterIds: [],
    routeIds: [],
  });
  const [scopeModalOpen, setScopeModalOpen] = useState(false);
  const [scopeDraft, setScopeDraft] = useState<RepetitionPatternScopeSelection>({
    mode: 'all',
    chapterIds: [],
    routeIds: [],
  });
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 10;
  const [hydratedPatternsByText, setHydratedPatternsByText] = useState<
    Record<string, RepetitionPatternAnalysis>
  >({});
  const consistencyFixProgressRef = useRef<RepetitionPatternConsistencyFixProgress | null>(null);

  const chapterOptions = useMemo(
    () =>
      chapters.map((chapter) => ({
        label: `章节 ${chapter.id} · ${chapter.filePath}`,
        value: chapter.id,
      })),
    [chapters],
  );

  const availableRoutes = useMemo(
    () =>
      topology?.routes.length
        ? topology.routes
        : chapters.length
          ? [
              {
                id: 'main',
                name: '主线',
                parentRouteId: null,
                forkAfterChapterId: null,
                chapters: chapters.map((chapter) => chapter.id),
                childRouteIds: [],
                depth: 0,
                isMain: true,
              } satisfies StoryTopologyRouteDescriptor,
            ]
          : [],
    [chapters, topology],
  );

  const routeOptions = useMemo(
    () =>
      availableRoutes.map((route) => ({
        label: `${route.name} (${route.id})`,
        value: route.id,
      })),
    [availableRoutes],
  );

  useEffect(() => {
    const nextSelection = normalizeScopeSelection(scopeSelection, chapters, routeOptions);
    if (!areScopeSelectionsEqual(nextSelection, scopeSelection)) {
      setScopeSelection(nextSelection);
    }

    const nextDraft = normalizeScopeSelection(scopeDraft, chapters, routeOptions);
    if (!areScopeSelectionsEqual(nextDraft, scopeDraft)) {
      setScopeDraft(nextDraft);
    }
  }, [chapters, routeOptions, scopeDraft, scopeSelection]);

  const scopedChapterIds = useMemo(
    () => resolveScopeChapterIds(scopeSelection, chapters, availableRoutes, topology),
    [availableRoutes, chapters, scopeSelection, topology],
  );

  const draftScopedChapterIds = useMemo(
    () => resolveScopeChapterIds(scopeDraft, chapters, availableRoutes, topology),
    [availableRoutes, chapters, scopeDraft, topology],
  );

  const scopeChapterIds = scopeSelection.mode === 'all' ? undefined : scopedChapterIds;
  const scopeReady = scopeSelection.mode === 'all' || scopedChapterIds.length > 0;
  const draftScopeReady = scopeDraft.mode === 'all' || draftScopedChapterIds.length > 0;

  const scopeSummary = useMemo(
    () => buildScopeSummary(scopeSelection, scopedChapterIds),
    [scopeSelection, scopedChapterIds],
  );

  const draftScopeSummary = useMemo(
    () => buildScopeSummary(scopeDraft, draftScopedChapterIds),
    [draftScopedChapterIds, scopeDraft],
  );

  useEffect(() => {
    if (selectedLlmProfileName && llmProfileOptions.some((option) => option.value === selectedLlmProfileName)) {
      return;
    }
    setSelectedLlmProfileName(defaultLlmProfileName ?? llmProfileOptions[0]?.value);
  }, [defaultLlmProfileName, llmProfileOptions, selectedLlmProfileName]);

  useEffect(() => {
    if (!repeatedPatterns) {
      setHydratedPatternsByText({});
      setDraftTranslations({});
      setCurrentPage(1);
      return;
    }
    setCurrentPage((previous) => {
      const maxPage = Math.max(1, Math.ceil(repeatedPatterns.patterns.length / pageSize));
      return Math.min(previous, maxPage);
    });
    setHydratedPatternsByText({});
    setDraftTranslations({});
  }, [repeatedPatterns]);

  const currentPagePatterns = useMemo(() => {
    if (!repeatedPatterns) {
      return [];
    }
    const startIndex = (currentPage - 1) * pageSize;
    return repeatedPatterns.patterns.slice(startIndex, startIndex + pageSize);
  }, [currentPage, repeatedPatterns]);

  const loadPatterns = useCallback(async () => {
    setLoading(true);
    try {
      setCurrentPage(1);
      await onRefreshRepeatedPatterns({ chapterIds: scopeChapterIds });
    } catch (error) {
      if (!isNotFoundError(error)) {
        message.error(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setLoading(false);
    }
  }, [message, onRefreshRepeatedPatterns, scopeChapterIds]);

  const hydrateVisiblePatterns = useCallback(async () => {
    if (!active || !currentPagePatterns.length) {
      return;
    }
    setHydrating(true);
    try {
      const hydrated = await onHydrateRepeatedPatterns({
        chapterIds: scopeChapterIds,
        patternTexts: currentPagePatterns.map((pattern) => pattern.text),
      });
      if (!hydrated) {
        return;
      }
      setHydratedPatternsByText((previous) => {
        const next = { ...previous };
        for (const pattern of hydrated.patterns) {
          next[pattern.text] = pattern;
        }
        return next;
      });
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setHydrating(false);
    }
  }, [active, currentPagePatterns, message, onHydrateRepeatedPatterns, scopeChapterIds]);

  useEffect(() => {
    if (!active) {
      return;
    }
    void loadPatterns();
  }, [active, loadPatterns]);

  useEffect(() => {
    void hydrateVisiblePatterns();
  }, [hydrateVisiblePatterns]);

  useEffect(() => {
    if (!repeatedPatterns) {
      return;
    }
    setMinOccurrences(repeatedPatterns.scanOptions.minOccurrences ?? 3);
    setMinLength(repeatedPatterns.scanOptions.minLength ?? 8);
    setMaxResults(repeatedPatterns.scanOptions.maxResults ?? 20);
  }, [repeatedPatterns]);

  const translationsByLineKey = useMemo(() => {
    const mapping: Record<string, string> = {};
    for (const pattern of Object.values(hydratedPatternsByText)) {
      for (const location of pattern.locations) {
        mapping[buildEditableLineKey(location)] = location.translatedSentence;
      }
    }
    return mapping;
  }, [hydratedPatternsByText]);

  const readDraftTranslation = (location: SavedRepetitionPatternLocation) =>
    draftTranslations[buildEditableLineKey(location)] ??
    translationsByLineKey[buildEditableLineKey(location)] ??
    '';

  const pendingSaveLocations = useMemo(() => {
    const pending = new Map<string, RepetitionPatternLocation>();
    for (const pattern of Object.values(hydratedPatternsByText)) {
      for (const location of pattern.locations) {
        const lineKey = buildEditableLineKey(location);
        if (readDraftTranslation(location) !== location.translatedSentence) {
          pending.set(lineKey, location);
        }
      }
    }
    return [...pending.values()];
  }, [draftTranslations, hydratedPatternsByText, translationsByLineKey]);

  const consistencyFixRunning = consistencyFixProgress?.status === 'running';

  useEffect(() => {
    consistencyFixProgressRef.current = consistencyFixProgress;
  }, [consistencyFixProgress]);

  const refreshConsistencyFixStatus = useCallback(async () => {
    const nextProgress = await onGetRepeatedPatternConsistencyFixStatus();
    const previousProgress = consistencyFixProgressRef.current;
    consistencyFixProgressRef.current = nextProgress;
    setConsistencyFixProgress(nextProgress);

    const previousProcessed =
      (previousProgress?.completedPatterns ?? 0) + (previousProgress?.failedPatterns ?? 0);
    const nextProcessed =
      (nextProgress?.completedPatterns ?? 0) + (nextProgress?.failedPatterns ?? 0);
    const shouldRefreshPatterns =
      nextProcessed > previousProcessed ||
      (previousProgress?.status === 'running' && nextProgress?.status !== 'running');

    if (shouldRefreshPatterns) {
      await onRefreshRepeatedPatterns({ chapterIds: scopeChapterIds });
      await hydrateVisiblePatterns();
    }
    if (
      nextProgress?.status !== 'running' &&
      previousProgress?.status === 'running'
    ) {
      await onRefreshProjectStatus();
    }
  }, [
    hydrateVisiblePatterns,
    onGetRepeatedPatternConsistencyFixStatus,
    onRefreshProjectStatus,
    onRefreshRepeatedPatterns,
    scopeChapterIds,
  ]);

  useEffect(() => {
    if (!active || consistencyFixDismissed) {
      return;
    }
    void refreshConsistencyFixStatus();
  }, [active, consistencyFixDismissed, refreshConsistencyFixStatus]);

  usePollingTask({
    enabled: active && !consistencyFixDismissed && consistencyFixRunning,
    intervalMs: 2_000,
    task: async () => {
      await refreshConsistencyFixStatus();
    },
  });

  const handleScan = async () => {
    setLoading(true);
    try {
      await onScanRepeatedPatterns({
        minOccurrences,
        minLength,
        maxResults,
      });
      await onRefreshRepeatedPatterns({ chapterIds: scopeChapterIds });
      message.success('重复 Pattern 已重新扫描并保存');
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (location: SavedRepetitionPatternLocation) => {
    const lineKey = buildEditableLineKey(location);
    const translation = readDraftTranslation(location);
    setSavingLineKey(lineKey);
    try {
      await onSaveRepeatedPatternTranslation({
        chapterId: location.chapterId,
        fragmentIndex: location.fragmentIndex,
        lineIndex: location.lineIndex,
        translation,
      });
      setDraftTranslations((previous) => {
        const next = { ...previous };
        delete next[lineKey];
        return next;
      });
      await hydrateVisiblePatterns();
      await onRefreshProjectStatus();
      message.success('译文已保存');
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingLineKey(null);
    }
  };

  const handleBulkSave = async () => {
    if (!pendingSaveLocations.length) {
      return;
    }
    setBulkSaving(true);
    try {
      for (const location of pendingSaveLocations) {
        await onSaveRepeatedPatternTranslation({
          chapterId: location.chapterId,
          fragmentIndex: location.fragmentIndex,
          lineIndex: location.lineIndex,
          translation: readDraftTranslation(location),
        });
      }
      setDraftTranslations((previous) => {
        const next = { ...previous };
        for (const location of pendingSaveLocations) {
          delete next[buildEditableLineKey(location)];
        }
        return next;
      });
      await hydrateVisiblePatterns();
      await onRefreshProjectStatus();
      message.success(`已批量保存 ${pendingSaveLocations.length} 条译文修改`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBulkSaving(false);
    }
  };

  const handleStartConsistencyFix = async () => {
    if (!selectedLlmProfileName) {
      message.error('请先选择一个 LLM 配置');
      return;
    }
    if (!scopeReady) {
      message.error('请先选择有效的查找区域');
      return;
    }
    if (pendingSaveLocations.length > 0) {
      message.error('请先保存当前手动修改，再执行 AI 统一表达');
      return;
    }

    setStartingConsistencyFix(true);
    try {
      const progress = await onStartRepeatedPatternConsistencyFix({
        llmProfileName: selectedLlmProfileName,
        chapterIds: scopeChapterIds,
      });
      consistencyFixProgressRef.current = progress;
      setConsistencyFixDismissed(false);
      setConsistencyFixProgress(progress);
      await onRefreshProjectStatus();
      if (progress.totalPatterns === 0) {
        message.info('当前没有需要 AI 统一的重复 Pattern');
      } else {
        message.success(`已启动 AI 表达统一任务（${progress.totalPatterns} 个 Pattern）`);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setStartingConsistencyFix(false);
    }
  };

  const handleOpenScopeModal = () => {
    setScopeDraft(scopeSelection);
    setScopeModalOpen(true);
  };

  const handleApplyScope = () => {
    if (!draftScopeReady) {
      message.error('请至少选择一个章节或一条路线');
      return;
    }
    setScopeSelection(scopeDraft);
    setScopeModalOpen(false);
    setCurrentPage(1);
  };

  const handleClearConsistencyFixProgress = async () => {
    try {
      await onClearRepeatedPatternConsistencyFixStatus();
      consistencyFixProgressRef.current = null;
      setConsistencyFixProgress(null);
      setConsistencyFixDismissed(true);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleOpenDetail = async (location: SavedRepetitionPatternLocation) => {
    setDetailLoading(true);
    setDetailContext({
      chapterId: location.chapterId,
      unitIndex: location.unitIndex + 1,
      startUnitIndex: location.unitIndex + 1,
      endUnitIndexExclusive: location.unitIndex + 2,
      entries: [],
    });
    try {
      const context = await onLoadRepeatedPatternContext({
        chapterId: location.chapterId,
        unitIndex: location.unitIndex + 1,
      });
      setDetailContext(context);
    } catch (error) {
      setDetailContext(null);
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <div className="section-stack">
      <Space wrap>
        <Space>
          <BranchesOutlined />
          <Typography.Text strong>重复 Pattern 发现</Typography.Text>
        </Space>
        <Button disabled={consistencyFixRunning} onClick={handleOpenScopeModal}>
          查找区域
        </Button>
        <span>最少出现</span>
        <InputNumber
          min={2}
          value={minOccurrences}
          onChange={(value) => setMinOccurrences(Number(value ?? 3))}
        />
        <span>最短长度</span>
        <InputNumber
          min={2}
          value={minLength}
          onChange={(value) => setMinLength(Number(value ?? 8))}
        />
        <span>结果上限</span>
        <InputNumber
          min={1}
          value={maxResults}
          onChange={(value) => setMaxResults(Number(value ?? 20))}
        />
        <Button
          type="primary"
          loading={loading}
          disabled={consistencyFixRunning}
          onClick={() => void handleScan()}
        >
          {repeatedPatterns ? '重新扫描并保存' : '开始扫描并保存'}
        </Button>
        <span>LLM 配置</span>
        <Select
          style={{ minWidth: 220 }}
          placeholder="选择已注册的 LLM 配置"
          options={llmProfileOptions}
          value={selectedLlmProfileName}
          onChange={setSelectedLlmProfileName}
        />
        <Button
          icon={<RobotOutlined />}
          loading={startingConsistencyFix}
          disabled={
            consistencyFixRunning ||
            loading ||
            hydrating ||
            bulkSaving ||
            savingLineKey !== null ||
            !repeatedPatterns?.patterns.length ||
            !llmProfileOptions.length ||
            pendingSaveLocations.length > 0 ||
            !scopeReady
          }
          onClick={() => void handleStartConsistencyFix()}
        >
          AI 一键统一表达
        </Button>
        <Button
          loading={bulkSaving}
          disabled={
            consistencyFixRunning ||
            !pendingSaveLocations.length ||
            loading ||
            hydrating ||
            savingLineKey !== null
          }
          onClick={() => void handleBulkSave()}
        >
          批量保存修改{pendingSaveLocations.length ? ` (${pendingSaveLocations.length})` : ''}
        </Button>
      </Space>
      <Typography.Text type="secondary">{scopeSummary}</Typography.Text>
      {repeatedPatterns ? (
        <Typography.Text type="secondary">
          已保存扫描：{new Date(repeatedPatterns.generatedAt).toLocaleString()}；阈值为出现 ≥
          {repeatedPatterns.scanOptions.minOccurrences ?? 3}、长度 ≥
          {repeatedPatterns.scanOptions.minLength ?? 8}、结果上限
          {repeatedPatterns.scanOptions.maxResults ?? 20}。
        </Typography.Text>
      ) : null}
      <Modal
        open={scopeModalOpen}
        title="选择查找区域"
        okText="应用"
        cancelText="取消"
        okButtonProps={{ disabled: !draftScopeReady }}
        onOk={handleApplyScope}
        onCancel={() => setScopeModalOpen(false)}
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Segmented<'all' | 'custom'>
            block
            options={[
              { label: '全部章节', value: 'all' },
              { label: '自定义章节 / 路线', value: 'custom' },
            ]}
            value={scopeDraft.mode}
            onChange={(value) =>
              setScopeDraft((current) => ({
                ...current,
                mode: value,
              }))
            }
          />
          {scopeDraft.mode === 'custom' ? (
            <>
              <Typography.Text type="secondary">
                工作区只保存一份基线扫描结果，这里选择的是当前查看 / AI 统一表达的作用域。
              </Typography.Text>
              <div className="section-stack">
                <Typography.Text strong>路线</Typography.Text>
                <Select
                  mode="multiple"
                  allowClear
                  showSearch
                  style={{ width: '100%' }}
                  placeholder="可选择多条路线"
                  options={routeOptions}
                  value={scopeDraft.routeIds}
                  onChange={(value) =>
                    setScopeDraft((current) => ({
                      ...current,
                      routeIds: value,
                    }))
                  }
                />
              </div>
              <div className="section-stack">
                <Typography.Text strong>章节</Typography.Text>
                <Select
                  mode="multiple"
                  allowClear
                  showSearch
                  style={{ width: '100%' }}
                  placeholder="可选择不连续章节"
                  options={chapterOptions}
                  value={scopeDraft.chapterIds}
                  onChange={(value) =>
                    setScopeDraft((current) => ({
                      ...current,
                      chapterIds: value,
                    }))
                  }
                />
              </div>
              <Alert
                type={draftScopeReady ? 'info' : 'warning'}
                showIcon
                message={draftScopeSummary}
              />
            </>
          ) : (
            <Alert type="info" showIcon message="将查看当前工作区已保存扫描中的全部章节结果。" />
          )}
        </Space>
      </Modal>
      {!llmProfileOptions.length ? (
        <Alert
          type="info"
          showIcon
          message="请先在系统设置中创建至少一个 chat 类型的 LLM 配置，才能使用 AI 一键统一表达。"
        />
      ) : null}
      {!consistencyFixDismissed && consistencyFixProgress ? (
        <Card
          size="small"
          title="AI 表达统一进度"
          extra={
            consistencyFixProgress.status !== 'running' ? (
              <Button
                type="text"
                size="small"
                icon={<CloseOutlined />}
                onClick={() => void handleClearConsistencyFixProgress()}
                aria-label="关闭 AI 表达统一进度卡片"
              />
            ) : null
          }
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Space wrap>
              <Tag color={toProgressTagColor(consistencyFixProgress.status)}>
                {toProgressLabel(consistencyFixProgress.status)}
              </Tag>
              <Tag>{`LLM ${consistencyFixProgress.llmProfileName}`}</Tag>
              <Tag>{`成功 ${consistencyFixProgress.completedPatterns}`}</Tag>
              <Tag color={consistencyFixProgress.failedPatterns > 0 ? 'error' : 'default'}>
                {`失败 ${consistencyFixProgress.failedPatterns}`}
              </Tag>
            </Space>
            <Progress
              percent={toFixProgressPercent(consistencyFixProgress)}
              status={toFixProgressStatus(consistencyFixProgress.status)}
              format={() =>
                `${consistencyFixProgress.completedPatterns + consistencyFixProgress.failedPatterns}/${consistencyFixProgress.totalPatterns} Pattern`
              }
            />
            {consistencyFixProgress.runningPatterns.length ? (
              <Typography.Text type="secondary">
                进行中：{consistencyFixProgress.runningPatterns.join('、')}
              </Typography.Text>
            ) : null}
            {consistencyFixProgress.lastAppliedPatternText ? (
              <Typography.Text type="secondary">
                最近已应用：{consistencyFixProgress.lastAppliedPatternText}
              </Typography.Text>
            ) : null}
            {consistencyFixProgress.errorMessage ? (
              <Alert type="error" showIcon message={consistencyFixProgress.errorMessage} />
            ) : null}
          </Space>
        </Card>
      ) : null}
      {repeatedPatterns?.patterns.length ? (
        <div className="section-stack">
          <Typography.Text type="secondary">
            当前作用域共 {repeatedPatterns.totalSentenceCount} 句，命中 {repeatedPatterns.patterns.length} 个已保存
            Pattern。{hydrating ? ' 正在按当前页动态加载译文…' : ''}
          </Typography.Text>
          <Table
            rowKey="text"
            dataSource={repeatedPatterns.patterns}
            pagination={{
              current: currentPage,
              pageSize,
              onChange: (page) => {
                setCurrentPage(page);
              },
            }}
            expandable={{
              expandedRowRender: (record) => (
                <Table
                  size="small"
                  scroll={{ x: 1080 }}
                  rowKey={(location) =>
                    `${record.text}-${location.chapterId}-${location.unitIndex}-${location.globalStartIndex}`
                  }
                  pagination={false}
                  dataSource={record.locations}
                  columns={[
                    {
                      title: '位置',
                      width: 120,
                      render: (_, location) =>
                        `章节 ${location.chapterId} / 句 ${location.unitIndex + 1}`,
                    },
                    {
                      title: '原文整句',
                      dataIndex: 'sourceSentence',
                      width: 220,
                    },
                    {
                      title: '译文',
                      width: 500,
                      render: (_, location) => {
                        const lineKey = buildEditableLineKey(location);
                        const hydratedPattern = hydratedPatternsByText[record.text];
                        const hydratedLineReady = hydratedPattern?.locations.some(
                          (entry) => buildEditableLineKey(entry) === lineKey,
                        );
                        return (
                          <TextArea
                            autoSize={{ minRows: 1, maxRows: 4 }}
                            disabled={consistencyFixRunning || (!hydratedLineReady && !draftTranslations[lineKey])}
                            value={readDraftTranslation(location)}
                            placeholder={hydratedLineReady ? '输入或修改译文' : '该页译文正在动态加载'}
                            onChange={(event) =>
                              setDraftTranslations((prev) => ({
                                ...prev,
                                [lineKey]: event.target.value,
                              }))
                            }
                          />
                        );
                      },
                    },
                    {
                      title: '句内区间',
                      width: 140,
                      render: (_, location) =>
                        `${location.matchStartInSentence}-${location.matchEndInSentence}`,
                    },
                    {
                      title: '操作',
                      width: 140,
                      render: (_, location) => {
                        const lineKey = buildEditableLineKey(location);
                        const hydratedPattern = hydratedPatternsByText[record.text];
                        const hydratedLine = hydratedPattern?.locations.find(
                          (entry) => buildEditableLineKey(entry) === lineKey,
                        );
                        return (
                          <Space size={0}>
                            <Button type="link" onClick={() => void handleOpenDetail(location)}>
                              详细
                            </Button>
                            <Button
                              type="link"
                              loading={savingLineKey === lineKey}
                              disabled={
                                bulkSaving ||
                                hydrating ||
                                consistencyFixRunning ||
                                !hydratedLine ||
                                readDraftTranslation(location) === hydratedLine.translatedSentence
                              }
                              onClick={() => void handleSave(location)}
                            >
                              保存
                            </Button>
                          </Space>
                        );
                      },
                    },
                  ]}
                />
              ),
            }}
            columns={[
              { title: 'Pattern', dataIndex: 'text' },
              { title: '长度', dataIndex: 'length', width: 90 },
              { title: '出现次数', dataIndex: 'occurrenceCount', width: 100 },
              {
                title: '译文状态',
                width: 120,
                render: (_, record) => {
                  const hydrated = hydratedPatternsByText[record.text];
                  if (!hydrated) {
                    return <Tag>待加载</Tag>;
                  }
                  return (
                    <Tag color={hydrated.isTranslationConsistent ? 'green' : 'gold'}>
                      {hydrated.isTranslationConsistent ? '统一' : '不统一'}
                    </Tag>
                  );
                },
              },
              {
                title: '命中句数',
                width: 100,
                render: (_, record) => record.locations.length,
              },
            ]}
          />
        </div>
      ) : (
        <Empty
          description={
            repeatedPatterns
              ? '当前作用域下没有命中已保存的重复 Pattern'
              : '点击“开始扫描并保存”后，可在这里查看已持久化的重复 Pattern'
          }
        />
      )}
      <Modal
        open={detailContext !== null}
        title={
          detailContext
            ? `详细上下文：章节 ${detailContext.chapterId} / 句 ${detailContext.unitIndex}`
            : '详细上下文'
        }
        footer={null}
        onCancel={() => setDetailContext(null)}
      >
        {detailLoading ? (
          <Typography.Text type="secondary">正在加载上下文…</Typography.Text>
        ) : (
          <div className="section-stack">
            {detailContext?.entries.map((entry) => (
              <div
                key={`${detailContext.chapterId}-${entry.unitIndex}`}
                style={{
                  background: entry.isFocus ? 'rgba(250, 173, 20, 0.15)' : 'transparent',
                  border: entry.isFocus ? '1px solid #faad14' : '1px solid transparent',
                  borderRadius: 8,
                  padding: 8,
                }}
              >
                <Typography.Text type={entry.isFocus ? undefined : 'secondary'}>
                  第 {entry.unitIndex} 句
                </Typography.Text>
                <pre
                  style={{
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    margin: '8px 0 0',
                  }}
                >
                  {entry.content}
                </pre>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number' &&
    error.status === 404
  );
}

function buildEditableLineKey(
  location: Pick<RepetitionPatternLocation, 'chapterId' | 'fragmentIndex' | 'lineIndex'>,
): string {
  return `${location.chapterId}-${location.fragmentIndex}-${location.lineIndex}`;
}

function normalizeScopeSelection(
  selection: RepetitionPatternScopeSelection,
  chapters: WorkspaceChapterDescriptor[],
  routeOptions: Array<{ label: string; value: string }>,
): RepetitionPatternScopeSelection {
  const validChapterIds = new Set(chapters.map((chapter) => chapter.id));
  const validRouteIds = new Set(routeOptions.map((route) => route.value));
  const normalized: RepetitionPatternScopeSelection = {
    mode: selection.mode,
    chapterIds: selection.chapterIds.filter(
      (chapterId, index, chapterIds) =>
        validChapterIds.has(chapterId) && chapterIds.indexOf(chapterId) === index,
    ),
    routeIds: selection.routeIds.filter(
      (routeId, index, routeIds) => validRouteIds.has(routeId) && routeIds.indexOf(routeId) === index,
    ),
  };
  return normalized;
}

function areScopeSelectionsEqual(
  left: RepetitionPatternScopeSelection,
  right: RepetitionPatternScopeSelection,
): boolean {
  return (
    left.mode === right.mode &&
    left.chapterIds.length === right.chapterIds.length &&
    left.routeIds.length === right.routeIds.length &&
    left.chapterIds.every((chapterId, index) => chapterId === right.chapterIds[index]) &&
    left.routeIds.every((routeId, index) => routeId === right.routeIds[index])
  );
}

function buildRouteChapterSequence(
  topology: StoryTopologyDescriptor,
  routeId: string,
): number[] {
  const routeById = new Map(topology.routes.map((route) => [route.id, route] as const));
  const ancestorChain: StoryTopologyRouteDescriptor[] = [];
  let currentRoute: StoryTopologyRouteDescriptor | undefined = routeById.get(routeId);
  while (currentRoute) {
    ancestorChain.unshift(currentRoute);
    currentRoute = currentRoute.parentRouteId
      ? routeById.get(currentRoute.parentRouteId)
      : undefined;
  }

  return ancestorChain
    .flatMap((route) => route.chapters)
    .filter((chapterId, index, chapterIds) => chapterIds.indexOf(chapterId) === index);
}

function resolveScopeChapterIds(
  selection: RepetitionPatternScopeSelection,
  chapters: WorkspaceChapterDescriptor[],
  routes: StoryTopologyRouteDescriptor[],
  topology: StoryTopologyDescriptor | null,
): number[] {
  if (selection.mode === 'all') {
    return chapters.map((chapter) => chapter.id);
  }

  const selectedChapterIds = new Set<number>(selection.chapterIds);
  for (const routeId of selection.routeIds) {
    const routeChapterIds =
      topology?.routes.length || routes.length
        ? buildRouteChapterSequence(
            topology ?? {
              routes,
              schemaVersion: 1,
              hasPersistedTopology: false,
              hasBranches: false,
            },
            routeId,
          )
        : [];
    for (const chapterId of routeChapterIds) {
      selectedChapterIds.add(chapterId);
    }
  }

  return chapters
    .map((chapter) => chapter.id)
    .filter((chapterId) => selectedChapterIds.has(chapterId));
}

function buildScopeSummary(
  selection: RepetitionPatternScopeSelection,
  resolvedChapterIds: number[],
): string {
  if (selection.mode === 'all') {
    return '查找区域：全部章节';
  }
  if (resolvedChapterIds.length === 0) {
    return '查找区域：未选择章节或路线';
  }

  const segments = [`共 ${resolvedChapterIds.length} 章`];
  if (selection.routeIds.length > 0) {
    segments.push(`${selection.routeIds.length} 条路线`);
  }
  if (selection.chapterIds.length > 0) {
    segments.push(`${selection.chapterIds.length} 个离散章节`);
  }
  const preview = resolvedChapterIds.slice(0, 8).map((chapterId) => `#${chapterId}`).join('、');
  const suffix = resolvedChapterIds.length > 8 ? ' …' : '';
  return `查找区域：自定义（${segments.join(' / ')}）${preview ? `：${preview}${suffix}` : ''}`;
}

function toFixProgressPercent(progress: RepetitionPatternConsistencyFixProgress): number {
  if (progress.totalPatterns <= 0) {
    return progress.status === 'done' ? 100 : 0;
  }
  return Number(
    (
      ((progress.completedPatterns + progress.failedPatterns) / progress.totalPatterns) *
      100
    ).toFixed(1),
  );
}

function toFixProgressStatus(
  status: 'running' | 'done' | 'error',
): 'active' | 'success' | 'exception' {
  switch (status) {
    case 'done':
      return 'success';
    case 'error':
      return 'exception';
    default:
      return 'active';
  }
}

function toProgressTagColor(status: 'running' | 'done' | 'error'): string {
  switch (status) {
    case 'done':
      return 'success';
    case 'error':
      return 'error';
    default:
      return 'processing';
  }
}

function toProgressLabel(status: 'running' | 'done' | 'error'): string {
  switch (status) {
    case 'done':
      return '已完成';
    case 'error':
      return '部分失败';
    default:
      return '进行中';
  }
}
