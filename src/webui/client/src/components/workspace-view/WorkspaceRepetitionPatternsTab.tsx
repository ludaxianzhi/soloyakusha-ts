import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BranchesOutlined, CloseOutlined, RobotOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Empty,
  Input,
  InputNumber,
  Modal,
  Progress,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type {
  RepetitionPatternAnalysisResult,
  RepetitionPatternConsistencyFixProgress,
  RepetitionPatternContextResult,
  RepetitionPatternLocation,
} from '../../app/types.ts';
import { usePollingTask } from '../../app/usePollingTask.ts';

const { TextArea } = Input;

interface WorkspaceRepetitionPatternsTabProps {
  active: boolean;
  repeatedPatterns: RepetitionPatternAnalysisResult | null;
  llmProfileOptions: Array<{ label: string; value: string }>;
  defaultLlmProfileName?: string;
  onRefreshRepeatedPatterns: (options?: {
    minOccurrences?: number;
    minLength?: number;
    maxResults?: number;
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
    minOccurrences?: number;
    minLength?: number;
    maxResults?: number;
  }) => Promise<RepetitionPatternConsistencyFixProgress>;
  onGetRepeatedPatternConsistencyFixStatus: () => Promise<RepetitionPatternConsistencyFixProgress | null>;
  onClearRepeatedPatternConsistencyFixStatus: () => Promise<void>;
}

export function WorkspaceRepetitionPatternsTab({
  active,
  repeatedPatterns,
  llmProfileOptions,
  defaultLlmProfileName,
  onRefreshRepeatedPatterns,
  onSaveRepeatedPatternTranslation,
  onLoadRepeatedPatternContext,
  onRefreshProjectStatus,
  onStartRepeatedPatternConsistencyFix,
  onGetRepeatedPatternConsistencyFixStatus,
  onClearRepeatedPatternConsistencyFixStatus,
}: WorkspaceRepetitionPatternsTabProps) {
  const { message } = AntdApp.useApp();
  const [loading, setLoading] = useState(false);
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
  const consistencyFixProgressRef = useRef<RepetitionPatternConsistencyFixProgress | null>(null);

  const analysisOptions = useMemo(
    () => ({
      minOccurrences,
      minLength,
      maxResults,
    }),
    [maxResults, minLength, minOccurrences],
  );

  const refresh = async () => {
    setLoading(true);
    try {
      await onRefreshRepeatedPatterns(analysisOptions);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const translationsByLineKey = useMemo(() => {
    const mapping: Record<string, string> = {};
    for (const pattern of repeatedPatterns?.patterns ?? []) {
      for (const location of pattern.locations) {
        mapping[buildEditableLineKey(location)] = location.translatedSentence;
      }
    }
    return mapping;
  }, [repeatedPatterns]);

  const readDraftTranslation = (location: RepetitionPatternLocation) =>
    draftTranslations[buildEditableLineKey(location)] ??
    translationsByLineKey[buildEditableLineKey(location)] ??
    '';

  const pendingSaveLocations = useMemo(() => {
    const pending = new Map<string, RepetitionPatternLocation>();
    for (const pattern of repeatedPatterns?.patterns ?? []) {
      for (const location of pattern.locations) {
        const lineKey = buildEditableLineKey(location);
        if (readDraftTranslation(location) !== location.translatedSentence) {
          pending.set(lineKey, location);
        }
      }
    }
    return [...pending.values()];
  }, [draftTranslations, repeatedPatterns, translationsByLineKey]);

  const consistencyFixRunning = consistencyFixProgress?.status === 'running';

  useEffect(() => {
    consistencyFixProgressRef.current = consistencyFixProgress;
  }, [consistencyFixProgress]);

  useEffect(() => {
    if (selectedLlmProfileName && llmProfileOptions.some((option) => option.value === selectedLlmProfileName)) {
      return;
    }
    setSelectedLlmProfileName(defaultLlmProfileName ?? llmProfileOptions[0]?.value);
  }, [defaultLlmProfileName, llmProfileOptions, selectedLlmProfileName]);

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
      await onRefreshRepeatedPatterns(analysisOptions);
    }
    if (
      nextProgress?.status !== 'running' &&
      previousProgress?.status === 'running'
    ) {
      await onRefreshProjectStatus();
    }
  }, [
    analysisOptions,
    onGetRepeatedPatternConsistencyFixStatus,
    onRefreshProjectStatus,
    onRefreshRepeatedPatterns,
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

  const handleSave = async (location: RepetitionPatternLocation) => {
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
      setDraftTranslations((prev) => {
        const next = { ...prev };
        delete next[lineKey];
        return next;
      });
      await refresh();
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
      setDraftTranslations((prev) => {
        const next = { ...prev };
        for (const location of pendingSaveLocations) {
          delete next[buildEditableLineKey(location)];
        }
        return next;
      });
      await refresh();
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
    if (pendingSaveLocations.length > 0) {
      message.error('请先保存当前手动修改，再执行 AI 统一表达');
      return;
    }

    setStartingConsistencyFix(true);
    try {
      const progress = await onStartRepeatedPatternConsistencyFix({
        llmProfileName: selectedLlmProfileName,
        ...analysisOptions,
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

  const handleOpenDetail = async (location: RepetitionPatternLocation) => {
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
          onClick={() => void refresh()}
        >
          {repeatedPatterns ? '重新分析' : '开始分析'}
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
            bulkSaving ||
            savingLineKey !== null ||
            !repeatedPatterns?.patterns.length ||
            !llmProfileOptions.length ||
            pendingSaveLocations.length > 0
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
            savingLineKey !== null
          }
          onClick={() => void handleBulkSave()}
        >
          批量保存修改{pendingSaveLocations.length ? ` (${pendingSaveLocations.length})` : ''}
        </Button>
      </Space>
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
            共扫描 {repeatedPatterns.totalSentenceCount} 句，发现 {repeatedPatterns.patterns.length} 个重复
            Pattern。
          </Typography.Text>
          <Table
            rowKey="text"
            dataSource={repeatedPatterns.patterns}
            pagination={{ pageSize: 10 }}
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
                        return (
                          <TextArea
                            autoSize={{ minRows: 1, maxRows: 4 }}
                            disabled={consistencyFixRunning}
                            value={readDraftTranslation(location)}
                            placeholder="输入或修改译文"
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
                                  consistencyFixRunning ||
                                  readDraftTranslation(location) === location.translatedSentence
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
                render: (_, record) => (
                  <Tag color={record.isTranslationConsistent ? 'green' : 'gold'}>
                    {record.isTranslationConsistent ? '统一' : '不统一'}
                  </Tag>
                ),
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
              ? '当前阈值下没有发现可用的重复 Pattern'
              : '点击“开始分析”后查看重复 Pattern、命中位置和译文一致性'
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

function buildEditableLineKey(location: RepetitionPatternLocation): string {
  return `${location.chapterId}-${location.fragmentIndex}-${location.lineIndex}`;
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
