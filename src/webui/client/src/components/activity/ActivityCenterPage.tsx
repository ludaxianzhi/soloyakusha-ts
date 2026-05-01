import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Collapse,
  Descriptions,
  Empty,
  List,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Tabs,
  Typography,
} from 'antd';
import type {
  LlmRequestHistoryDetail,
  LlmRequestHistoryDigest,
  LlmRequestHistorySummaryItem,
  LogDigest,
  LogEntry,
  LogSession,
} from '../../app/types.ts';
import { api } from '../../app/api.ts';
import { usePollingTask } from '../../app/usePollingTask.ts';
import { logColor, toErrorMessage } from '../../app/ui-helpers.ts';
import { UsageStatsPanel } from './UsageStatsPanel.tsx';

const LOG_PAGE_SIZE = 50;
const HISTORY_PAGE_SIZE = 20;

// ─── Main Page ──────────────────────────────────────────────────────────────

export function ActivityCenterPage() {
  const [activeTab, setActiveTab] = useState('runtime-logs');

  return (
    <div className="activity-center-page">
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'runtime-logs',
            label: '运行日志',
            children: (
              <div className="activity-tab-scroll">
                <RuntimeLogsPanel active={activeTab === 'runtime-logs'} />
              </div>
            ),
          },
          {
            key: 'llm-history',
            label: '请求历史',
            children: <RequestHistoryPanel active={activeTab === 'llm-history'} />,
          },
          {
            key: 'usage-stats',
            label: '使用统计',
            children: (
              <div className="activity-tab-scroll">
                <UsageStatsPanel active={activeTab === 'usage-stats'} />
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

// ─── Runtime Logs Panel ─────────────────────────────────────────────────────

function RuntimeLogsPanel({ active }: { active: boolean }) {
  const { message } = AntdApp.useApp();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [nextBeforeId, setNextBeforeId] = useState<number>();
  const [digest, setDigest] = useState<LogDigest>({ total: 0, latestId: 0 });
  const [session, setSession] = useState<LogSession | null>(null);

  const loadLogs = useCallback(
    async (mode: 'replace' | 'append' = 'replace') => {
      if (mode === 'append' && nextBeforeId === undefined) return;
      if (mode === 'replace') setLoading(true);
      else setLoadingMore(true);
      try {
        const sessionSnapshot =
          mode === 'replace' || !session ? await api.getLogSession() : session;
        const page = await api.getLogs({
          limit: LOG_PAGE_SIZE,
          beforeId: mode === 'append' ? nextBeforeId : undefined,
        });
        setLogs((prev) => (mode === 'append' ? [...prev, ...page.items] : page.items));
        setNextBeforeId(page.nextBeforeId);
        setDigest({ total: page.total, latestId: page.latestId });
        setSession(sessionSnapshot);
        setInitialized(true);
      } catch (error) {
        message.error(toErrorMessage(error));
      } finally {
        if (mode === 'replace') setLoading(false);
        else setLoadingMore(false);
      }
    },
    [message, nextBeforeId, session],
  );

  const refreshIfChanged = useCallback(async () => {
    try {
      const nextDigest = await api.getLogsSummary();
      if (
        !initialized ||
        nextDigest.latestId !== digest.latestId ||
        nextDigest.total !== digest.total
      ) {
        await loadLogs('replace');
      }
    } catch {
      // keep background polling quiet
    }
  }, [digest.latestId, digest.total, initialized, loadLogs]);

  useEffect(() => {
    if (!active) {
      setInitialized(false);
      return;
    }
    if (initialized) return;
    void loadLogs('replace');
  }, [active, initialized, loadLogs]);

  usePollingTask({ enabled: active, intervalMs: 2_000, task: refreshIfChanged });

  const handleClear = useCallback(async () => {
    try {
      await api.clearLogs();
      setLogs([]);
      setSelectedLog(null);
      setNextBeforeId(undefined);
      setDigest({ total: 0, latestId: 0 });
      setInitialized(true);
      message.success('运行日志已清空');
    } catch (error) {
      message.error(toErrorMessage(error));
    }
  }, [message]);

  const handleExport = useCallback(async () => {
    try {
      const blob = await api.downloadLogs('text');
      const fileName = session ? `runtime-logs-${session.runId}.txt` : 'runtime-logs.txt';
      downloadBlob(blob, fileName);
      message.success('运行日志已开始导出');
    } catch (error) {
      message.error(toErrorMessage(error));
    }
  }, [message, session]);

  return (
    <>
      <Card
        title="运行日志"
        extra={
          <Space>
            {session ? (
              <Tag color="blue">{`启动于 ${new Date(session.startedAt).toLocaleString()}`}</Tag>
            ) : null}
            <Tag>{`共 ${digest.total} 条`}</Tag>
            <Button onClick={() => void handleExport()}>导出</Button>
            <Button onClick={() => void handleClear()}>清空</Button>
          </Space>
        }
      >
        {logs.length === 0 && !loading ? (
          <Empty description="当前运行暂无日志" />
        ) : (
          <List
            loading={loading}
            dataSource={logs}
            loadMore={
              nextBeforeId ? (
                <div style={{ textAlign: 'center', marginTop: 12 }}>
                  <Button loading={loadingMore} onClick={() => void loadLogs('append')}>
                    加载更多
                  </Button>
                </div>
              ) : undefined
            }
            renderItem={(item) => (
              <List.Item
                key={item.id}
                actions={[
                  <Button key="detail" type="link" onClick={() => setSelectedLog(item)}>
                    详情
                  </Button>,
                ]}
              >
                <Space wrap size={[8, 8]}>
                  <Tag color={logColor(item.level)}>{item.level.toUpperCase()}</Tag>
                  <Typography.Text type="secondary">
                    {new Date(item.timestamp).toLocaleString()}
                  </Typography.Text>
                  <Typography.Text
                    ellipsis={{ tooltip: item.message }}
                    style={{ maxWidth: 680 }}
                  >
                    {item.message}
                  </Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        )}
      </Card>
      <Modal
        open={selectedLog !== null}
        title="日志详情"
        footer={<Button onClick={() => setSelectedLog(null)}>关闭</Button>}
        onCancel={() => setSelectedLog(null)}
      >
        {selectedLog ? (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="级别">
                <Tag color={logColor(selectedLog.level)}>
                  {selectedLog.level.toUpperCase()}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="时间">
                {new Date(selectedLog.timestamp).toLocaleString()}
              </Descriptions.Item>
              <Descriptions.Item label="ID">{selectedLog.id}</Descriptions.Item>
            </Descriptions>
            <DetailTextBlock title="消息" content={selectedLog.message} />
          </Space>
        ) : null}
      </Modal>
    </>
  );
}

// ─── Request History Panel (two-column) ─────────────────────────────────────

function RequestHistoryPanel({ active }: { active: boolean }) {
  const { message } = AntdApp.useApp();
  const [items, setItems] = useState<LlmRequestHistorySummaryItem[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<LlmRequestHistoryDetail | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [nextBeforeId, setNextBeforeId] = useState<number>();
  const [digest, setDigest] = useState<LlmRequestHistoryDigest>({ total: 0, latestId: 0 });
  const detailRequestRef = useRef(0);

  const loadHistory = useCallback(
    async (mode: 'replace' | 'append' = 'replace') => {
      if (mode === 'append' && nextBeforeId === undefined) return;
      if (mode === 'replace') setLoading(true);
      else setLoadingMore(true);
      try {
        const page = await api.getHistory({
          limit: HISTORY_PAGE_SIZE,
          beforeId: mode === 'append' ? nextBeforeId : undefined,
        });
        setItems((prev) => (mode === 'append' ? [...prev, ...page.items] : page.items));
        setNextBeforeId(page.nextBeforeId);
        setDigest({ total: page.total, latestId: page.latestId });
        setInitialized(true);
      } catch (error) {
        message.error(toErrorMessage(error));
      } finally {
        if (mode === 'replace') setLoading(false);
        else setLoadingMore(false);
      }
    },
    [message, nextBeforeId],
  );

  const refreshIfChanged = useCallback(async () => {
    try {
      const nextDigest = await api.getHistorySummary();
      if (
        !initialized ||
        nextDigest.latestId !== digest.latestId ||
        nextDigest.total !== digest.total
      ) {
        await loadHistory('replace');
      }
    } catch {
      // keep background polling quiet
    }
  }, [digest.latestId, digest.total, initialized, loadHistory]);

  useEffect(() => {
    if (!active) {
      setInitialized(false);
      return;
    }
    if (initialized) return;
    void loadHistory('replace');
  }, [active, initialized, loadHistory]);

  usePollingTask({ enabled: active, intervalMs: 5_000, task: refreshIfChanged });

  const handleOpenDetail = useCallback(
    async (entryId: number) => {
      setSelectedId(entryId);
      const requestId = detailRequestRef.current + 1;
      detailRequestRef.current = requestId;
      setDetailLoading(true);
      setSelectedEntry(null);
      try {
        const detail = await api.getHistoryDetail(entryId);
        if (detailRequestRef.current === requestId) {
          setSelectedEntry(detail);
        }
      } catch (error) {
        message.error(toErrorMessage(error));
      } finally {
        if (detailRequestRef.current === requestId) {
          setDetailLoading(false);
        }
      }
    },
    [message],
  );

  const handleCloseDetail = useCallback(() => {
    detailRequestRef.current += 1;
    setDetailLoading(false);
    setSelectedEntry(null);
    setSelectedId(null);
  }, []);

  const handleDelete = useCallback(
    async (entryId: number) => {
      try {
        await api.deleteHistoryEntry(entryId);
        if (selectedEntry?.id === entryId) {
          handleCloseDetail();
        }
        setItems((prev) => prev.filter((entry) => entry.id !== entryId));
        setDigest((prev) => ({
          total: Math.max(0, prev.total - 1),
          latestId: prev.latestId === entryId ? 0 : prev.latestId,
        }));
        message.success('请求历史已删除');
        await loadHistory('replace');
      } catch (error) {
        message.error(toErrorMessage(error));
      }
    },
    [handleCloseDetail, loadHistory, message, selectedEntry?.id],
  );

  const handleClear = useCallback(async () => {
    try {
      await api.clearHistory();
      handleCloseDetail();
      setItems([]);
      setNextBeforeId(undefined);
      setDigest({ total: 0, latestId: 0 });
      setInitialized(true);
      message.success('请求历史已清空');
    } catch (error) {
      message.error(toErrorMessage(error));
    }
  }, [handleCloseDetail, message]);

  const handleExportAll = useCallback(async () => {
    try {
      const blob = await api.downloadHistoryExport();
      downloadBlob(blob, 'request-history.json');
      message.success('请求历史已开始导出');
    } catch (error) {
      message.error(toErrorMessage(error));
    }
  }, [message]);

  const handleExportSelected = useCallback(() => {
    if (!selectedEntry) return;
    const blob = new Blob([JSON.stringify(selectedEntry, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    downloadBlob(blob, `request-history-${selectedEntry.id}.json`);
    message.success('当前请求详情已导出');
  }, [message, selectedEntry]);

  return (
    <div className="history-panel">
      {/* ── Left: list ───────────────────────────────────────── */}
      <div className="history-list-pane">
        <div className="history-list-header">
          <Space size={6} wrap>
            <Tag>{`共 ${digest.total} 条`}</Tag>
            <Button size="small" onClick={() => void handleExportAll()}>
              导出
            </Button>
            <Popconfirm
              title="确认清空全部请求历史？"
              description="该操作不可撤销。"
              onConfirm={() => void handleClear()}
            >
              <Button size="small" danger>
                清空
              </Button>
            </Popconfirm>
          </Space>
        </div>

        <div className="history-list-scroll">
          {items.length === 0 && !loading ? (
            <Empty
              description="暂无请求历史"
              style={{ marginTop: 48 }}
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          ) : (
            <List
              loading={loading}
              dataSource={items}
              loadMore={
                nextBeforeId ? (
                  <div style={{ textAlign: 'center', padding: '8px 0 12px' }}>
                    <Button size="small" loading={loadingMore} onClick={() => void loadHistory('append')}>
                      加载更多
                    </Button>
                  </div>
                ) : undefined
              }
              renderItem={(entry) => {
                const ctx = readHistoryContext(entry);
                const isSelected = entry.id === selectedId;
                return (
                  <div
                    key={entry.id}
                    className={`history-entry-item${isSelected ? ' history-entry-item--selected' : ''}`}
                    onClick={() => void handleOpenDetail(entry.id)}
                  >
                    <div className="history-entry-top">
                      <Tag
                        color={entry.type === 'error' ? 'error' : 'success'}
                        style={{ marginRight: 4 }}
                      >
                        {entry.type === 'error' ? 'ERR' : 'OK'}
                      </Tag>
                      {entry.modelName ? (
                        <Typography.Text className="history-entry-model">
                          {entry.modelName}
                        </Typography.Text>
                      ) : null}
                      {entry.durationSeconds != null ? (
                        <Typography.Text type="secondary" className="history-entry-meta">
                          {entry.durationSeconds.toFixed(2)}s
                        </Typography.Text>
                      ) : null}
                    </div>
                    <div className="history-entry-tags">
                      {entry.meta?.label ? <Tag color="purple">{entry.meta.label}</Tag> : null}
                      {entry.meta?.stage ? (
                        <Tag>{`stage ${entry.meta.stage}`}</Tag>
                      ) : null}
                      {entry.source ? <Tag>{entry.source}</Tag> : null}
                      {entry.statistics ? (
                        <Tag color="blue">{`${entry.statistics.totalTokens} tok`}</Tag>
                      ) : null}
                    </div>
                    {entry.errorMessage ? (
                      <Typography.Text
                        type="danger"
                        className="history-entry-error"
                        ellipsis
                      >
                        {entry.errorMessage}
                      </Typography.Text>
                    ) : null}
                    {ctx.projectName ? (
                      <Typography.Text
                        type="secondary"
                        className="history-entry-project"
                        ellipsis
                      >
                        {ctx.projectName}
                      </Typography.Text>
                    ) : null}
                    <Typography.Text type="secondary" className="history-entry-time">
                      {new Date(entry.timestamp).toLocaleString()}
                    </Typography.Text>
                  </div>
                );
              }}
            />
          )}
        </div>
      </div>

      {/* ── Right: detail ────────────────────────────────────── */}
      <div className="history-detail-pane">
        {detailLoading ? (
          <div className="history-detail-loading">
            <Spin tip="正在加载详情..." />
          </div>
        ) : selectedEntry ? (
          <HistoryDetailPanel
            entry={selectedEntry}
            onExport={handleExportSelected}
            onDelete={() => void handleDelete(selectedEntry.id)}
          />
        ) : (
          <div className="history-detail-empty">
            <Empty
              description="从左侧列表选择一条请求记录"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── History Detail Panel ───────────────────────────────────────────────────

interface HistoryDetailPanelProps {
  entry: LlmRequestHistoryDetail;
  onExport: () => void;
  onDelete: () => void;
}

function HistoryDetailPanel({ entry, onExport, onDelete }: HistoryDetailPanelProps) {
  const ctx = readHistoryContext(entry);

  const collapseItems = useMemo(() => {
    const sections: NonNullable<React.ComponentProps<typeof Collapse>['items']> = [];

    sections.push({
      key: 'overview',
      label: '基本信息',
      children: (
        <Descriptions column={2} size="small" bordered>
          <Descriptions.Item label="状态">
            <Tag color={entry.type === 'error' ? 'error' : 'success'}>
              {entry.type === 'error' ? 'ERROR' : 'COMPLETION'}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="时间">
            {new Date(entry.timestamp).toLocaleString()}
          </Descriptions.Item>
          <Descriptions.Item label="请求 ID">{entry.requestId}</Descriptions.Item>
          <Descriptions.Item label="模型">{entry.modelName ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="来源">{entry.source ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="时长">
            {entry.durationSeconds != null
              ? `${entry.durationSeconds.toFixed(3)}s`
              : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="Token">
            {entry.statistics?.totalTokens ?? '-'}
          </Descriptions.Item>
          <Descriptions.Item label="Prompt Token">
            {entry.statistics?.promptTokens ?? '-'}
          </Descriptions.Item>
          <Descriptions.Item label="Completion Token">
            {entry.statistics?.completionTokens ?? '-'}
          </Descriptions.Item>
          <Descriptions.Item label="项目">{ctx.projectName ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="工作区" span={2}>
            {ctx.workspaceDir ?? '-'}
          </Descriptions.Item>
        </Descriptions>
      ),
    });

    if (entry.meta) {
      sections.push({
        key: 'meta',
        label: 'Meta',
        children: <JsonCodeBlock content={JSON.stringify(entry.meta, null, 2)} />,
      });
    }

    if (entry.requestConfig?.systemPrompt) {
      sections.push({
        key: 'system-prompt',
        label: 'System Prompt',
        children: <DetailTextBlock content={entry.requestConfig.systemPrompt} />,
      });
    }

    sections.push({
      key: 'user-prompt',
      label: 'User Prompt',
      children: <DetailTextBlock content={entry.prompt} />,
    });

    if (entry.response) {
      sections.push({
        key: 'response',
        label: 'Response',
        children: <DetailTextBlock content={entry.response} />,
      });
    }

    if (entry.reasoning) {
      sections.push({
        key: 'reasoning',
        label: 'Reasoning',
        children: <DetailTextBlock content={entry.reasoning} />,
      });
    }

    if (entry.errorMessage) {
      sections.push({
        key: 'error',
        label: 'Error',
        children: <DetailTextBlock content={entry.errorMessage} isError />,
      });
    }

    if (entry.responseBody) {
      sections.push({
        key: 'response-body',
        label: 'Response Body',
        children: <JsonCodeBlock content={entry.responseBody} />,
      });
    }

    if (entry.requestConfig) {
      sections.push({
        key: 'request-config',
        label: 'Request Config',
        children: <JsonCodeBlock content={JSON.stringify(entry.requestConfig, null, 2)} />,
      });
    }

    return sections;
  }, [entry, ctx.projectName, ctx.workspaceDir]);

  return (
    <div className="history-detail-content">
      <div className="history-detail-content-header">
        <Typography.Text strong>{`请求 #${entry.id}`}</Typography.Text>
        <Space size={6}>
          <Button size="small" onClick={onExport}>
            导出
          </Button>
          <Popconfirm title="确认删除该请求历史？" onConfirm={onDelete}>
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      </div>
      <Collapse
        defaultActiveKey={['overview', 'user-prompt', 'response', ...(entry.errorMessage ? ['error'] : [])]}
        items={collapseItems}
        size="small"
      />
    </div>
  );
}

// ─── JSON Code Block ─────────────────────────────────────────────────────────

type JsonTokenType = 'key' | 'string' | 'number' | 'bool' | 'null' | 'punct' | 'space';

interface JsonToken {
  type: JsonTokenType;
  text: string;
}

function tokenizeJson(json: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let i = 0;

  while (i < json.length) {
    const ch = json.charAt(i);

    // Whitespace
    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < json.length && /\s/.test(json.charAt(j))) j++;
      tokens.push({ type: 'space', text: json.slice(i, j) });
      i = j;
      continue;
    }

    // String
    if (ch === '"') {
      let j = i + 1;
      while (j < json.length) {
        const c = json.charAt(j);
        if (c === '\\') {
          j += 2;
        } else if (c === '"') {
          j++;
          break;
        } else {
          j++;
        }
      }
      const str = json.slice(i, j);
      const rest = json.slice(j).replace(/^\s*/, '');
      tokens.push({ type: rest.startsWith(':') ? 'key' : 'string', text: str });
      i = j;
      continue;
    }

    // Number
    const numMatch = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(json.slice(i));
    if (numMatch) {
      tokens.push({ type: 'number', text: numMatch[0] });
      i += numMatch[0].length;
      continue;
    }

    // Boolean / null keywords
    if (json.startsWith('true', i)) {
      tokens.push({ type: 'bool', text: 'true' });
      i += 4;
      continue;
    }
    if (json.startsWith('false', i)) {
      tokens.push({ type: 'bool', text: 'false' });
      i += 5;
      continue;
    }
    if (json.startsWith('null', i)) {
      tokens.push({ type: 'null', text: 'null' });
      i += 4;
      continue;
    }

    // Punctuation / everything else
    tokens.push({ type: 'punct', text: ch });
    i++;
  }

  return tokens;
}

function JsonCodeBlock({ content }: { content: string }) {
  const tokens = useMemo(() => {
    try {
      // Pretty-print if the content is valid JSON but might be compact
      const parsed = JSON.parse(content) as unknown;
      return tokenizeJson(JSON.stringify(parsed, null, 2));
    } catch {
      return tokenizeJson(content);
    }
  }, [content]);

  return (
    <pre className="json-code-block">
      {tokens.map((token, idx) =>
        token.type === 'space' ? (
          // eslint-disable-next-line react/no-array-index-key
          <span key={idx}>{token.text}</span>
        ) : (
          // eslint-disable-next-line react/no-array-index-key
          <span key={idx} className={`json-token-${token.type}`}>
            {token.text}
          </span>
        ),
      )}
    </pre>
  );
}

// ─── Detail Text Block ───────────────────────────────────────────────────────

function DetailTextBlock({
  title,
  content,
  isError = false,
}: {
  title?: string;
  content: string;
  isError?: boolean;
}) {
  return (
    <div>
      {title ? (
        <Typography.Text strong style={{ display: 'block', marginBottom: 6 }}>
          {title}
        </Typography.Text>
      ) : null}
      <pre className={`detail-text-block${isError ? ' detail-text-block--error' : ''}`}>
        {content}
      </pre>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function readHistoryContext(entry: {
  meta?: { context?: Record<string, unknown> };
}) {
  const ctx = entry.meta?.context;
  return {
    projectName: typeof ctx?.projectName === 'string' ? ctx.projectName : undefined,
    workspaceDir: typeof ctx?.workspaceDir === 'string' ? ctx.workspaceDir : undefined,
  };
}
