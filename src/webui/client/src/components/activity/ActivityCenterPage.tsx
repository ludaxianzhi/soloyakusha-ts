import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Collapse,
  Descriptions,
  Empty,
  Input,
  List,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Tabs,
  Typography,
} from 'antd';
import { SearchOutlined } from '@ant-design/icons';
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
const MAX_LOG_COUNT = 500;

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

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

function RuntimeLogsPanel({ active }: { active: boolean }) {
  const { message } = AntdApp.useApp();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [session, setSession] = useState<LogSession | null>(null);
  const [connected, setConnected] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  const handleAutoScroll = useCallback(() => {
    if (!autoScrollRef.current || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, []);

  useEffect(() => {
    if (!active) {
      setInitialized(false);
      return;
    }
    if (initialized) return;

    let disposed = false;
    const init = async () => {
      setLoading(true);
      try {
        const [sessionSnapshot, page] = await Promise.all([
          api.getLogSession(),
          api.getLogs({ limit: LOG_PAGE_SIZE }),
        ]);
        if (disposed) return;
        setSession(sessionSnapshot);
        const allLogs = [...page.items].reverse();
        setLogs(allLogs.slice(-MAX_LOG_COUNT));
        setInitialized(true);
      } catch (error) {
        if (!disposed) message.error(toErrorMessage(error));
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    void init();
    return () => { disposed = true; };
  }, [active, initialized, message]);

  useEffect(() => {
    if (!active || !initialized) return;

    setConnected(true);
    const query = new URLSearchParams({ includeLogs: '1' });
    const source = new EventSource(`${API_BASE}/api/events?${query.toString()}`);

    source.addEventListener('open', () => setConnected(true));
    source.addEventListener('error', () => setConnected(false));

    source.addEventListener('log', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent<string>).data) as LogEntry;
        if (!data || typeof data !== 'object') return;
        setLogs((prev) => {
          const next = [...prev, data as LogEntry];
          return next.length > MAX_LOG_COUNT
            ? next.slice(-Math.floor(MAX_LOG_COUNT * 0.6))
            : next;
        });
        requestAnimationFrame(() => handleAutoScroll());
      } catch {
        // ignore parse errors
      }
    });

    return () => {
      source.close();
      setConnected(false);
    };
  }, [active, handleAutoScroll, initialized]);

  const handleClear = useCallback(async () => {
    try {
      await api.clearLogs();
      setLogs([]);
      setSession(null);
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

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);

  return (
    <Card
      title="运行日志"
      extra={
        <Space>
          {session ? (
            <Tag color="blue">{`启动于 ${new Date(session.startedAt).toLocaleString()}`}</Tag>
          ) : null}
          <Tag color={connected ? 'green' : 'default'}>
            {connected ? '实时' : '离线'}
          </Tag>
          <Tag>{`共 ${logs.length} 条`}</Tag>
          <Button onClick={() => void handleExport()}>导出</Button>
          <Button onClick={() => void handleClear()}>清空</Button>
        </Space>
      }
    >
      {logs.length === 0 && !loading ? (
        <Empty description="当前运行暂无日志" />
      ) : (
        <div
          ref={scrollRef}
          className="runtime-log-stream"
          onScroll={handleScroll}
        >
          {logs.map((entry) => (
            <div key={entry.id} className={`runtime-log-line runtime-log-line--${entry.level}`}>
              <span className="runtime-log-time">
                {formatLogTime(entry.timestamp)}
              </span>
              <span className={`runtime-log-level runtime-log-level--${entry.level}`}>
                {entry.level.toUpperCase().padEnd(7)}
              </span>
              {entry.workspaceId ? (
                <span className="runtime-log-workspace">{`[${entry.workspaceId}]`}</span>
              ) : null}
              <span className="runtime-log-msg">{entry.message}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function formatLogTime(timestamp: string): string {
  try {
    const d = new Date(timestamp);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch {
    return timestamp;
  }
}

function RequestHistoryPanel({ active }: { active: boolean }) {
  const { message } = AntdApp.useApp();
  const [items, setItems] = useState<LlmRequestHistorySummaryItem[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<LlmRequestHistoryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [nextBeforeId, setNextBeforeId] = useState<number>();
  const [digest, setDigest] = useState<LlmRequestHistoryDigest>({ total: 0, latestId: 0 });
  const [searchText, setSearchText] = useState('');
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

  const filteredItems = useMemo(() => {
    if (!searchText.trim()) return items;
    const q = searchText.toLowerCase();
    return items.filter((entry) => {
      if (entry.modelName?.toLowerCase().includes(q)) return true;
      if (entry.meta?.label?.toLowerCase().includes(q)) return true;
      if (entry.source?.toLowerCase().includes(q)) return true;
      if (entry.meta?.stage?.toLowerCase().includes(q)) return true;
      if (entry.requestId?.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [items, searchText]);

  const handleOpenDetail = useCallback(
    async (entryId: number) => {
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
    <>
      <Card
        title="LLM 请求历史"
        extra={
          <Space>
            <Tag>{`共 ${digest.total} 条`}</Tag>
            <Button onClick={() => void handleExportAll()}>导出</Button>
            <Popconfirm
              title="确认清空全部请求历史？"
              description="该操作不可撤销。"
              onConfirm={() => void handleClear()}
            >
              <Button danger>清空</Button>
            </Popconfirm>
          </Space>
        }
      >
        <div style={{ marginBottom: 12 }}>
          <Input
            placeholder="搜索任务、模型、来源..."
            prefix={<SearchOutlined />}
            allowClear
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
        </div>

        {filteredItems.length === 0 && !loading ? (
          <Empty
            description={searchText ? '无匹配的请求记录' : '暂无请求历史'}
          />
        ) : (
          <List
            loading={loading}
            dataSource={filteredItems}
            loadMore={
              nextBeforeId && !searchText ? (
                <div style={{ textAlign: 'center', marginTop: 12 }}>
                  <Button loading={loadingMore} onClick={() => void loadHistory('append')}>
                    加载更多
                  </Button>
                </div>
              ) : undefined
            }
            renderItem={(entry) => {
              const ctx = readHistoryContext(entry);
              const tps =
                entry.statistics?.completionTokens != null && entry.durationSeconds != null && entry.durationSeconds > 0
                  ? entry.statistics.completionTokens / entry.durationSeconds
                  : undefined;
              return (
                <List.Item
                  key={entry.id}
                  actions={[
                    <Button
                      key="detail"
                      type="link"
                      onClick={() => void handleOpenDetail(entry.id)}
                    >
                      详情
                    </Button>,
                    <Popconfirm
                      key="delete"
                      title="确认删除该请求历史？"
                      onConfirm={() => void handleDelete(entry.id)}
                    >
                      <Button danger type="link">
                        删除
                      </Button>
                    </Popconfirm>,
                  ]}
                >
                  <Space wrap size={[8, 8]}>
                    <Tag color={entry.type === 'error' ? 'error' : 'success'}>
                      {entry.type === 'error' ? 'ERROR' : 'COMPLETION'}
                    </Tag>
                    {ctx.projectName ? <Tag color="gold">{ctx.projectName}</Tag> : null}
                    {entry.meta?.label ? <Tag color="purple">{entry.meta.label}</Tag> : null}
                    {entry.source ? <Tag>{entry.source}</Tag> : null}
                    {entry.meta?.stage ? <Tag>{`stage ${entry.meta.stage}`}</Tag> : null}
                    {entry.modelName ? <Tag color="blue">{entry.modelName}</Tag> : null}
                    {entry.durationSeconds != null ? (
                      <Tag>{`${entry.durationSeconds.toFixed(3)}s`}</Tag>
                    ) : null}
                    {tps != null ? (
                      <Tag color="green">{`${tps.toFixed(1)} t/s`}</Tag>
                    ) : null}
                    {entry.statistics ? (
                      <Tag color="orange">{`${entry.statistics.totalTokens} tok`}</Tag>
                    ) : null}
                    {entry.errorMessage ? (
                      <Typography.Text type="danger" ellipsis style={{ maxWidth: 260 }}>
                        {entry.errorMessage}
                      </Typography.Text>
                    ) : null}
                    <Typography.Text type="secondary">
                      {new Date(entry.timestamp).toLocaleString()}
                    </Typography.Text>
                  </Space>
                </List.Item>
              );
            }}
          />
        )}
      </Card>

      <Modal
        open={selectedEntry !== null || detailLoading}
        title="LLM 请求详情"
        width={960}
        footer={
          <Space>
            <Button onClick={handleExportSelected} disabled={!selectedEntry}>
              导出
            </Button>
            {selectedEntry ? (
              <Popconfirm
                title="确认删除该请求历史？"
                onConfirm={() => void handleDelete(selectedEntry.id)}
              >
                <Button danger>删除</Button>
              </Popconfirm>
            ) : null}
            <Button onClick={handleCloseDetail}>关闭</Button>
          </Space>
        }
        onCancel={handleCloseDetail}
      >
        {detailLoading ? (
          <Typography.Text type="secondary">正在加载详情...</Typography.Text>
        ) : selectedEntry ? (
          <HistoryDetailModalContent entry={selectedEntry} />
        ) : null}
      </Modal>
    </>
  );
}

function HistoryDetailModalContent({ entry }: { entry: LlmRequestHistoryDetail }) {
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
        children: (
          <JsonCodeBlock content={JSON.stringify(entry.requestConfig, null, 2)} />
        ),
      });
    }

    return sections;
  }, [entry, ctx.projectName, ctx.workspaceDir]);

  return (
    <Collapse
      defaultActiveKey={[
        'overview',
        'user-prompt',
        'response',
        ...(entry.errorMessage ? ['error'] : []),
      ]}
      items={collapseItems}
      size="small"
    />
  );
}

function JsonCodeBlock({ content }: { content: string }) {
  const tokens = useMemo(() => {
    try {
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

    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < json.length && /\s/.test(json.charAt(j))) j++;
      tokens.push({ type: 'space', text: json.slice(i, j) });
      i = j;
      continue;
    }

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

    const numMatch = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(json.slice(i));
    if (numMatch) {
      tokens.push({ type: 'number', text: numMatch[0] });
      i += numMatch[0].length;
      continue;
    }

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

    tokens.push({ type: 'punct', text: ch });
    i++;
  }

  return tokens;
}

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
