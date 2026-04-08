import {
  Button,
  Card,
  Col,
  Empty,
  Popconfirm,
  Progress,
  Row,
  Space,
  Statistic,
  Tag,
  Typography,
} from 'antd';
import {
  PauseCircleOutlined,
  PlayCircleOutlined,
  RobotOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { statusColor } from '../../app/ui-helpers.ts';
import type { ProjectStatus, TranslationProjectSnapshot } from '../../app/types.ts';
import { TaskActivityPanels } from './TaskActivityPanels.tsx';
import type { ProjectCommand, TaskActivityKind } from './types.ts';

interface WorkspaceDashboardTabProps {
  snapshot: TranslationProjectSnapshot;
  projectStatus: ProjectStatus | null;
  onProjectCommand: (command: ProjectCommand) => void | Promise<void>;
  onDismissTaskActivity: (task: TaskActivityKind) => void | Promise<void>;
}

export function WorkspaceDashboardTab({
  snapshot,
  projectStatus,
  onProjectCommand,
  onDismissTaskActivity,
}: WorkspaceDashboardTabProps) {
  return (
    <div className="section-stack">
      <Card
        title={
          <Space>
            <RobotOutlined />
            {snapshot.projectName}
          </Space>
        }
        extra={
          <Tag color={statusColor(snapshot.lifecycle.status)}>
            {snapshot.lifecycle.status}
          </Tag>
        }
      >
        <Space wrap>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            disabled={!snapshot.lifecycle.canStart}
            onClick={() => void onProjectCommand('start')}
          >
            启动
          </Button>
          <Button
            icon={<PauseCircleOutlined />}
            disabled={!snapshot.lifecycle.canStop}
            onClick={() => void onProjectCommand('pause')}
          >
            暂停
          </Button>
          <Button
            icon={<PlayCircleOutlined />}
            disabled={!snapshot.lifecycle.canResume}
            onClick={() => void onProjectCommand('resume')}
          >
            恢复
          </Button>
          <Button
            danger
            icon={<StopOutlined />}
            disabled={!snapshot.lifecycle.canAbort}
            onClick={() => void onProjectCommand('abort')}
          >
            中止
          </Button>
          <Button onClick={() => void onProjectCommand('scan')}>扫描术语</Button>
          <Button onClick={() => void onProjectCommand('plot')}>生成情节大纲</Button>
          <Button onClick={() => void onProjectCommand('close')}>关闭工作区</Button>
          <Popconfirm
            title="确认删除当前工作区？"
            onConfirm={() => void onProjectCommand('remove')}
          >
            <Button danger>移除工作区</Button>
          </Popconfirm>
        </Space>
      </Card>

      <Row gutter={12}>
        <Col span={6}>
          <Card>
            <Statistic
              title="章节进度"
              value={snapshot.progress.chapterProgressRatio * 100}
              suffix="%"
              precision={1}
            />
            <Typography.Text type="secondary">
              {snapshot.progress.translatedChapters}/{snapshot.progress.totalChapters}
            </Typography.Text>
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="片段进度"
              value={snapshot.progress.fragmentProgressRatio * 100}
              suffix="%"
              precision={1}
            />
            <Typography.Text type="secondary">
              {snapshot.progress.translatedFragments}/{snapshot.progress.totalFragments}
            </Typography.Text>
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="排队/运行"
              value={`${snapshot.lifecycle.queuedWorkItems}/${snapshot.lifecycle.activeWorkItems}`}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="术语表" value={snapshot.glossary?.totalTerms ?? 0} />
            <Typography.Text type="secondary">
              已译 {snapshot.glossary?.translatedTerms ?? 0}
            </Typography.Text>
          </Card>
        </Col>
      </Row>

      <TaskActivityPanels
        projectStatus={projectStatus}
        onDismissTaskActivity={onDismissTaskActivity}
      />

      <Card title="步骤队列">
        {snapshot.queueSnapshots.length === 0 ? (
          <Empty description="暂无步骤数据" />
        ) : (
          <div className="step-list">
            {snapshot.queueSnapshots.map((queue) => (
              <div className="step-card" key={queue.stepId}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <div>
                    <Typography.Text strong>{queue.description}</Typography.Text>
                    {queue.isFinalStep ? (
                      <Tag color="green" style={{ marginLeft: 8 }}>
                        最终步骤
                      </Tag>
                    ) : null}
                  </div>
                  <Typography.Text type="secondary">
                    {queue.progress.completedFragments}/{queue.progress.totalFragments}
                  </Typography.Text>
                </div>
                <Progress
                  percent={Number((queue.progress.completionRatio * 100).toFixed(1))}
                  status={queue.progress.completionRatio >= 1 ? 'success' : 'active'}
                />
                <Space wrap size={[8, 8]}>
                  <Tag>ready {queue.progress.readyFragments}</Tag>
                  <Tag>queued {queue.progress.queuedFragments}</Tag>
                  <Tag>running {queue.progress.runningFragments}</Tag>
                  <Tag>waiting {queue.progress.waitingFragments}</Tag>
                </Space>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
