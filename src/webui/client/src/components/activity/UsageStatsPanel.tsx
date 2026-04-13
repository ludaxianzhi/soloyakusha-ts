import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntdApp, Card, Col, Empty, Row, Space, Statistic, Tag, Typography } from 'antd';
import type { UsageStatsDailyPoint, UsageStatsSnapshot } from '../../app/types.ts';
import { api } from '../../app/api.ts';
import { usePollingTask } from '../../app/usePollingTask.ts';
import { toErrorMessage } from '../../app/ui-helpers.ts';

const DEFAULT_DAYS = 30;

interface UsageStatsPanelProps {
  active: boolean;
}

export function UsageStatsPanel({ active }: UsageStatsPanelProps) {
  const { message } = AntdApp.useApp();
  const [snapshot, setSnapshot] = useState<UsageStatsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    try {
      setSnapshot(await api.getUsageStats(DEFAULT_DAYS));
      setInitialized(true);
    } catch (error) {
      message.error(toErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    if (!active) {
      setInitialized(false);
      return;
    }
    if (!active || initialized) {
      return;
    }
    void loadSnapshot();
  }, [active, initialized, loadSnapshot]);

  usePollingTask({
    enabled: active,
    intervalMs: 15_000,
    task: loadSnapshot,
  });

  const dailyPoints = snapshot?.dailyPoints ?? [];
  const latestPoint = dailyPoints[dailyPoints.length - 1];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        title="使用统计"
        extra={latestPoint ? <Tag>{`最新日期 ${latestPoint.date}`}</Tag> : null}
        loading={loading && !snapshot}
      >
        {snapshot ? (
          <Row gutter={[12, 12]}>
            <Col xs={12} sm={12} md={6}>
              <Statistic title="已翻译原文字符" value={snapshot.summary.translatedCharacters} />
            </Col>
            <Col xs={12} sm={12} md={6}>
              <Statistic title="文本块" value={snapshot.summary.translatedBlocks} />
            </Col>
            <Col xs={12} sm={12} md={6}>
              <Statistic title="模型调用" value={snapshot.summary.modelCalls} />
            </Col>
            <Col xs={12} sm={12} md={6}>
              <Statistic title="Token" value={snapshot.summary.totalTokens} />
            </Col>
            <Col xs={12} sm={12} md={6}>
              <Statistic title="失败调用" value={snapshot.summary.failedModelCalls} />
            </Col>
            <Col xs={12} sm={12} md={6}>
              <Statistic title="Prompt Token" value={snapshot.summary.promptTokens} />
            </Col>
            <Col xs={12} sm={12} md={6}>
              <Statistic title="Completion Token" value={snapshot.summary.completionTokens} />
            </Col>
          </Row>
        ) : (
          <Empty description="暂无使用统计" />
        )}
      </Card>

      <Card title="使用曲线">
        {dailyPoints.length > 0 ? (
          <UsageTrendChart points={dailyPoints} />
        ) : (
          <Empty description="暂无曲线数据" />
        )}
      </Card>

      <Card title="最近 30 天概览" loading={loading && !snapshot}>
        {dailyPoints.length > 0 ? (
          <div className="usage-point-list">
            {dailyPoints.slice(-8).map((point) => (
              <div key={point.date} className="usage-point-row">
                <Typography.Text type="secondary">{point.date}</Typography.Text>
                <Space wrap size={[8, 8]}>
                  <Tag color="blue">{`原文 ${point.translatedCharacters}`}</Tag>
                  <Tag color="green">{`块 ${point.translatedBlocks}`}</Tag>
                  <Tag>{`调用 ${point.modelCalls}`}</Tag>
                  <Tag color="orange">{`token ${point.totalTokens}`}</Tag>
                </Space>
              </div>
            ))}
          </div>
        ) : (
          <Empty description="暂无最近数据" />
        )}
      </Card>
    </Space>
  );
}

function UsageTrendChart({ points }: { points: UsageStatsDailyPoint[] }) {
  const { width, height, path, fillPath, labels, maxValue } = useMemo(() => {
    const chartWidth = 860;
    const chartHeight = 220;
    const paddingLeft = 48;
    const paddingRight = 16;
    const paddingTop = 16;
    const paddingBottom = 36;
    const plotWidth = chartWidth - paddingLeft - paddingRight;
    const plotHeight = chartHeight - paddingTop - paddingBottom;
    const values = points.map((point) => point.translatedCharacters);
    const max = Math.max(1, ...values);
    const step = points.length > 1 ? plotWidth / (points.length - 1) : 0;
    const linePoints = points.map((point, index) => {
      const x = paddingLeft + index * step;
      const ratio = point.translatedCharacters / max;
      const y = paddingTop + plotHeight - ratio * plotHeight;
      return { x, y, value: point.translatedCharacters, date: point.date };
    });
    const linePath = linePoints
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
      .join(' ');
    const areaPath = linePoints.length
      ? `${linePath} L ${linePoints[linePoints.length - 1]?.x ?? paddingLeft} ${paddingTop + plotHeight} L ${paddingLeft} ${paddingTop + plotHeight} Z`
      : '';
    const dayLabels = linePoints.map((point, index) => ({
      x: point.x,
      y: chartHeight - 12,
      label: point.date.slice(5),
      show: index === 0 || index === linePoints.length - 1 || index % 3 === 0,
    }));
    return {
      width: chartWidth,
      height: chartHeight,
      path: linePath,
      fillPath: areaPath,
      labels: dayLabels,
      maxValue: max,
    };
  }, [points]);

  return (
    <div className="usage-chart-wrap">
      <div style={{ marginBottom: 8 }}>
        <Typography.Text type="secondary">
          纵轴按原文字符数绘制，展示最近 {points.length} 天的使用走势
        </Typography.Text>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="usage-chart">
        <line x1="48" y1="16" x2="48" y2="184" className="usage-chart-axis" />
        <line x1="48" y1="184" x2="844" y2="184" className="usage-chart-axis" />
        {maxValue > 0 ? (
          <>
            <path d={fillPath} className="usage-chart-area" />
            <path d={path} className="usage-chart-line" />
            {points.map((point, index) => {
              const x = labels[index]?.x ?? 0;
              const y = 16 + 168 - (point.translatedCharacters / maxValue) * 168;
              return (
                <g key={point.date}>
                  <circle cx={x} cy={y} r="3.5" className="usage-chart-dot" />
                  {labels[index]?.show ? (
                    <text x={x} y={200} textAnchor="middle" className="usage-chart-label">
                      {labels[index]?.label}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </>
        ) : null}
      </svg>
    </div>
  );
}
