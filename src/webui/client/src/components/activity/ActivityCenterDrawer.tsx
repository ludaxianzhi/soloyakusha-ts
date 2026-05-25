import { useCallback, useEffect, useRef, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Drawer,
  Empty,
  Space,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { LogEntry, LogSession } from '../../app/types.ts';
import { api } from '../../app/api.ts';
import { logColor, toErrorMessage } from '../../app/ui-helpers.ts';
import { UsageStatsPanel } from './UsageStatsPanel.tsx';

const LOG_PAGE_SIZE = 50;
const MAX_LOG_COUNT = 500;

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

interface ActivityCenterDrawerProps {
  open: boolean;
  onClose: () => void;
  mobileMode?: boolean;
}

export function ActivityCenterDrawer({
  open,
  onClose,
  mobileMode = false,
}: ActivityCenterDrawerProps) {
  const [activeTabKey, setActiveTabKey] = useState('runtime-logs');

  useEffect(() => {
    if (mobileMode && activeTabKey !== 'runtime-logs') {
      setActiveTabKey('runtime-logs');
    }
  }, [activeTabKey, mobileMode]);

  return (
    <Drawer
      title={mobileMode ? '运行日志' : '活动中心'}
      placement={mobileMode ? 'bottom' : 'right'}
      width={mobileMode ? undefined : 960}
      height={mobileMode ? '100%' : undefined}
      open={open}
      onClose={onClose}
      destroyOnClose
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
            key: 'usage-stats',
            label: '使用统计',
            children: <UsageStatsPanel active={open && activeTabKey === 'usage-stats'} />,
          },
        ].filter((item) => !mobileMode || item.key === 'runtime-logs')}
      />
    </Drawer>
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
  const [expandedMetaIds, setExpandedMetaIds] = useState<Set<number>>(new Set());

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
          <Button size="small" onClick={() => void handleExport()}>导出</Button>
          <Button size="small" onClick={() => void handleClear()}>清空</Button>
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
          {logs.map((entry) => {
            const hasMeta =
              entry.metadata && Object.keys(entry.metadata).length > 0;
            const isExpanded = expandedMetaIds.has(entry.id);
            return (
              <div key={entry.id}>
                <div className={`runtime-log-line runtime-log-line--${entry.level}`}>
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
                  {hasMeta ? (
                    <button
                      type="button"
                      className="runtime-log-meta-toggle"
                      onClick={() => {
                        setExpandedMetaIds((prev) => {
                          const next = new Set(prev);
                          if (isExpanded) next.delete(entry.id);
                          else next.add(entry.id);
                          return next;
                        });
                      }}
                    >
                      {isExpanded ? '▾' : '▸'} meta
                    </button>
                  ) : null}
                </div>
                {hasMeta && isExpanded ? (
                  <pre className="runtime-log-meta-content">
                    {JSON.stringify(entry.metadata, null, 2)}
                  </pre>
                ) : null}
              </div>
            );
          })}
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

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
