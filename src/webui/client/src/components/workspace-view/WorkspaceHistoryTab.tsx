import { useState } from 'react';
import {
  Button,
  Card,
  Descriptions,
  Empty,
  List,
  Modal,
  Space,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { LlmRequestHistoryEntry, LogEntry } from '../../app/types.ts';
import { logColor } from '../../app/ui-helpers.ts';

interface WorkspaceHistoryTabProps {
  logs: LogEntry[];
  history: LlmRequestHistoryEntry[];
  onClearLogs: () => void | Promise<void>;
}

export function WorkspaceHistoryTab({
  logs,
  history,
  onClearLogs,
}: WorkspaceHistoryTabProps) {
  return (
    <Tabs
      size="small"
      defaultActiveKey="runtime-logs"
      items={[
        {
          key: 'runtime-logs',
          label: '运行日志',
          children: (
            <LogsPanel
              logs={logs}
              onClearLogs={onClearLogs}
            />
          ),
        },
        {
          key: 'llm-history',
          label: 'LLM 请求历史',
          children: <LlmHistoryPanel history={history} />,
        },
      ]}
    />
  );
}

function LogsPanel({
  logs,
  onClearLogs,
}: {
  logs: LogEntry[];
  onClearLogs: () => void | Promise<void>;
}) {
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);

  return (
    <>
      <Card
        title="事件日志"
        extra={
          <Space>
            <Button onClick={() => void onClearLogs()}>清空</Button>
          </Space>
        }
      >
        {logs.length === 0 ? (
          <Empty description="暂无日志" />
        ) : (
          <List
            dataSource={[...logs].reverse()}
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
                    style={{ maxWidth: 520 }}
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
            <DetailSection title="消息" content={selectedLog.message} />
          </Space>
        ) : null}
      </Modal>
    </>
  );
}

function LlmHistoryPanel({ history }: { history: LlmRequestHistoryEntry[] }) {
  const [selectedEntry, setSelectedEntry] = useState<LlmRequestHistoryEntry | null>(null);

  return (
    <>
      <Card title="LLM 请求历史">
        {history.length === 0 ? (
          <Empty description="暂无请求历史" />
        ) : (
          <List
            dataSource={history}
            renderItem={(entry) => (
              <List.Item
                key={`${entry.source ?? 'llm'}-${entry.requestId}-${entry.timestamp}`}
                actions={[
                  <Button
                    key="detail"
                    type="link"
                    onClick={() => setSelectedEntry(entry)}
                  >
                    详情
                  </Button>,
                ]}
              >
                <Space wrap size={[8, 8]}>
                  <Tag color={entry.type === 'error' ? 'error' : 'success'}>
                    {entry.type === 'error' ? 'ERROR' : 'COMPLETION'}
                  </Tag>
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
                  <Typography.Text type="secondary">
                    {new Date(entry.timestamp).toLocaleString()}
                  </Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        )}
      </Card>
      <Modal
        open={selectedEntry !== null}
        title="LLM 请求详情"
        width={960}
        footer={<Button onClick={() => setSelectedEntry(null)}>关闭</Button>}
        onCancel={() => setSelectedEntry(null)}
      >
        {selectedEntry ? (
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
