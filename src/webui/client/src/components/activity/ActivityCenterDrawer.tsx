import { useCallback, useEffect, useRef, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  List,
  Modal,
  Popconfirm,
  Space,
  Tabs,
  Tag,
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

interface ActivityCenterDrawerProps {
  open: boolean;
  onClose: () => void;
}

export function ActivityCenterDrawer({ open, onClose }: ActivityCenterDrawerProps) {
  const [activeTabKey, setActiveTabKey] = useState('runtime-logs');

  return (
    <Drawer
      title="活动中心"
      placement="right"
      width={960}
      open={open}
      onClose={onClose}
      destroyOnClose={false}
    >
      <Tabs
        size="small"
        activeKey={activeTabKey}
        onChange={setActiveTabKey}
        items={[
          {
            key: 'runtime-logs',
            label: '运行日志',
            children: <RuntimeLogsPanel active={open && activeTabKey === 'runtime-logs'} />,
          },
          {
            key: 'llm-history',
            label: '请求历史',
            children: <RequestHistoryPanel active={open && activeTabKey === 'llm-history'} />,
          },
          {
            key: 'usage-stats',
            label: '使用统计',
            children: <UsageStatsPanel active={open && activeTabKey === 'usage-stats'} />,
          },
        ]}
      />
    </Drawer>
  );
}

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
      if (mode === 'append' && nextBeforeId === undefined) {
        return;
      }
      if (mode === 'replace') {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      try {
        const sessionSnapshot = mode === 'replace' || !session ? await api.getLogSession() : session;
        const page = await api.getLogs({
          limit: LOG_PAGE_SIZE,
          beforeId: mode === 'append' ? nextBeforeId : undefined,
        });
        setLogs((prev) => (mode === 'append' ? [...prev, ...page.items] : page.items));
        setNextBeforeId(page.nextBeforeId);
        setDigest({
          total: page.total,
          latestId: page.latestId,
        });
        setSession(sessionSnapshot);
        setInitialized(true);
      } catch (error) {
        message.error(toErrorMessage(error));
      } finally {
        if (mode === 'replace') {
          setLoading(false);
        } else {
          setLoadingMore(false);
        }
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
    if (!active || initialized) {
      return;
    }
    void loadLogs('replace');
  }, [active, initialized, loadLogs]);

  usePollingTask({
    enabled: active,
    intervalMs: 2_000,
    task: refreshIfChanged,
  });

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
                  <Typography.Text ellipsis={{ tooltip: item.message }} style={{ maxWidth: 520 }}>
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
            <DetailSection title="消息" content={selectedLog.message} />
          </Space>
        ) : null}
      </Modal>
    </>
  );
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
  const [digest, setDigest] = useState<LlmRequestHistoryDigest>({
    total: 0,
    latestId: 0,
  });
  const detailRequestRef = useRef(0);

  const loadHistory = useCallback(
    async (mode: 'replace' | 'append' = 'replace') => {
      if (mode === 'append' && nextBeforeId === undefined) {
        return;
      }
      if (mode === 'replace') {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      try {
        const page = await api.getHistory({
          limit: HISTORY_PAGE_SIZE,
          beforeId: mode === 'append' ? nextBeforeId : undefined,
        });
        setItems((prev) => (mode === 'append' ? [...prev, ...page.items] : page.items));
        setNextBeforeId(page.nextBeforeId);
        setDigest({
          total: page.total,
          latestId: page.latestId,
        });
        setInitialized(true);
      } catch (error) {
        message.error(toErrorMessage(error));
      } finally {
        if (mode === 'replace') {
          setLoading(false);
        } else {
          setLoadingMore(false);
        }
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
    if (!active || initialized) {
      return;
    }
    void loadHistory('replace');
  }, [active, initialized, loadHistory]);

  usePollingTask({
    enabled: active,
    intervalMs: 5_000,
    task: refreshIfChanged,
  });

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
    if (!selectedEntry) {
      return;
    }
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
        {items.length === 0 && !loading ? (
          <Empty description="暂无请求历史" />
        ) : (
          <List
            loading={loading}
            dataSource={items}
            loadMore={
              nextBeforeId ? (
                <div style={{ textAlign: 'center', marginTop: 12 }}>
                  <Button loading={loadingMore} onClick={() => void loadHistory('append')}>
                    加载更多
                  </Button>
                </div>
              ) : undefined
            }
            renderItem={(entry) => {
              const context = readHistoryContext(entry);
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
                    {context.projectName ? <Tag color="gold">{context.projectName}</Tag> : null}
                    {entry.meta?.label ? <Tag color="purple">{entry.meta.label}</Tag> : null}
                    {entry.source ? <Tag>{entry.source}</Tag> : null}
                    {entry.meta?.stage ? <Tag>{`stage ${entry.meta.stage}`}</Tag> : null}
                    {entry.modelName ? <Tag color="blue">{entry.modelName}</Tag> : null}
                    <Tag>{`requestId ${entry.requestId}`}</Tag>
                    {entry.durationSeconds != null ? (
                      <Tag>{`${entry.durationSeconds.toFixed(3)}s`}</Tag>
                    ) : null}
                    {entry.statistics ? (
                      <Tag>{`tokens ${entry.statistics.totalTokens}`}</Tag>
                    ) : null}
                    {entry.errorMessage ? (
                      <Typography.Text type="danger" ellipsis style={{ maxWidth: 260 }}>
                        {entry.errorMessage}
                      </Typography.Text>
                    ) : null}
                    {context.workspaceDir ? (
                      <Typography.Text type="secondary" ellipsis style={{ maxWidth: 220 }}>
                        {context.workspaceDir}
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
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="状态">
                <Tag color={selectedEntry.type === 'error' ? 'error' : 'success'}>
                  {selectedEntry.type === 'error' ? 'ERROR' : 'COMPLETION'}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="时间">
                {new Date(selectedEntry.timestamp).toLocaleString()}
              </Descriptions.Item>
              <Descriptions.Item label="请求 ID">
                {selectedEntry.requestId}
              </Descriptions.Item>
              <Descriptions.Item label="来源">
                {selectedEntry.source ?? '-'}
              </Descriptions.Item>
              <Descriptions.Item label="项目">
                {readHistoryContext(selectedEntry).projectName ?? '-'}
              </Descriptions.Item>
              <Descriptions.Item label="工作区">
                {readHistoryContext(selectedEntry).workspaceDir ?? '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Meta">
                {selectedEntry.meta?.label ?? '-'}
              </Descriptions.Item>
              <Descriptions.Item label="模型">
                {selectedEntry.modelName ?? '-'}
              </Descriptions.Item>
              <Descriptions.Item label="时长">
                {selectedEntry.durationSeconds != null
                  ? `${selectedEntry.durationSeconds.toFixed(3)}s`
                  : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Token">
                {selectedEntry.statistics?.totalTokens ?? '-'}
              </Descriptions.Item>
            </Descriptions>
            {selectedEntry.meta ? (
              <DetailSection
                title="Meta"
                content={JSON.stringify(selectedEntry.meta, null, 2)}
              />
            ) : null}
            {selectedEntry.requestConfig?.systemPrompt ? (
              <DetailSection
                title="System Prompt"
                content={selectedEntry.requestConfig.systemPrompt}
              />
            ) : null}
            <DetailSection title="User Prompt" content={selectedEntry.prompt} />
            {selectedEntry.response ? (
              <DetailSection title="Response" content={selectedEntry.response} />
            ) : null}
            {selectedEntry.reasoning ? (
              <DetailSection title="Reasoning" content={selectedEntry.reasoning} />
            ) : null}
            {selectedEntry.errorMessage ? (
              <DetailSection title="Error" content={selectedEntry.errorMessage} />
            ) : null}
            {selectedEntry.responseBody ? (
              <DetailSection title="Response Body" content={selectedEntry.responseBody} />
            ) : null}
            {selectedEntry.requestConfig ? (
              <DetailSection
                title="Request Config"
                content={JSON.stringify(selectedEntry.requestConfig, null, 2)}
              />
            ) : null}
          </Space>
        ) : null}
      </Modal>
    </>
  );
}

function DetailSection({ title, content }: { title: string; content: string }) {
  return (
    <div>
      <Typography.Text strong>{title}</Typography.Text>
      <div className="mono-block" style={{ marginTop: 8 }}>
        {content}
      </div>
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
  meta?: {
    context?: Record<string, unknown>;
  };
}) {
  const context = entry.meta?.context;
  return {
    projectName:
      typeof context?.projectName === 'string' ? context.projectName : undefined,
    workspaceDir:
      typeof context?.workspaceDir === 'string' ? context.workspaceDir : undefined,
  };
}
