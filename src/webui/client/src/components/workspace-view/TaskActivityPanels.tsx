import type { ReactNode } from 'react';
import { Alert, Button, Card, Col, Progress, Row, Space, Tag } from 'antd';
import type { ProjectStatus } from '../../app/types.ts';
import { CloseOutlined } from '@ant-design/icons';
import type { TaskActivityKind } from './types.ts';

interface TaskActivityPanelsProps {
  projectStatus: ProjectStatus | null;
  tasks?: TaskActivityKind[];
  onDismissTaskActivity: (task: TaskActivityKind) => void | Promise<void>;
}

export function TaskActivityPanels({
  projectStatus,
  tasks = ['scan', 'plot'],
  onDismissTaskActivity,
}: TaskActivityPanelsProps) {
  const visibleTasks: Array<{
    key: TaskActivityKind;
    title: string;
    progress:
      | NonNullable<ProjectStatus['scanDictionaryProgress']>
      | NonNullable<ProjectStatus['plotSummaryProgress']>;
    details: ReactNode;
  }> = [];

  for (const task of tasks) {
    if (task === 'scan' && projectStatus?.scanDictionaryProgress) {
      visibleTasks.push({
        key: 'scan',
        title: '术语扫描',
        progress: projectStatus.scanDictionaryProgress,
        details: (
          <Space wrap>
            <Tag>{`批次 ${projectStatus.scanDictionaryProgress.completedBatches}/${projectStatus.scanDictionaryProgress.totalBatches}`}</Tag>
            <Tag>{`总行数 ${projectStatus.scanDictionaryProgress.totalLines}`}</Tag>
          </Space>
        ),
      });
      continue;
    }

    if (task === 'plot' && projectStatus?.plotSummaryProgress) {
      const plotProgress = projectStatus.plotSummaryProgress;
      visibleTasks.push({
        key: 'plot',
        title: '情节大纲',
        progress: plotProgress,
        details: (
          <Space direction="vertical" style={{ width: '100%' }} size={8}>
            <Progress
              percent={toPercent(
                plotProgress.completedChapters,
                plotProgress.totalChapters,
                plotProgress.status,
              )}
              status={toProgressStatus(plotProgress.status)}
              format={() =>
                `${plotProgress.completedChapters}/${plotProgress.totalChapters} 章节`
              }
            />
            <Space wrap>
              <Tag>{`批次 ${plotProgress.completedBatches}/${plotProgress.totalBatches}`}</Tag>
              {plotProgress.currentChapterId != null ? (
                <Tag color="processing">{`当前章节 ${plotProgress.currentChapterId}`}</Tag>
              ) : null}
            </Space>
          </Space>
        ),
      });
    }
  }

  if (visibleTasks.length === 0) {
    return null;
  }

  const colSpan = visibleTasks.length === 1 ? 24 : 12;

  return (
    <Row gutter={[16, 16]}>
      {visibleTasks.map((task) => (
        <Col key={task.key} span={colSpan}>
          <TaskActivityCard
            task={task.key}
            title={task.title}
            progress={task.progress}
            details={task.details}
            onDismiss={() => void onDismissTaskActivity(task.key)}
          />
        </Col>
      ))}
    </Row>
  );
}

function TaskActivityCard({
  task,
  title,
  progress,
  details,
  onDismiss,
}: {
  task: TaskActivityKind;
  title: string;
  progress:
    | NonNullable<ProjectStatus['scanDictionaryProgress']>
    | NonNullable<ProjectStatus['plotSummaryProgress']>;
  details: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <Card
      size="small"
      title={title}
      extra={
        <Space size="small">
          <Tag color={toTaskStatusColor(progress.status)}>
            {toTaskStatusLabel(progress.status)}
          </Tag>
          {progress.status !== 'running' ? (
            <Button
              type="text"
              size="small"
              icon={<CloseOutlined />}
              onClick={onDismiss}
              aria-label={`关闭${task}进度卡片`}
            />
          ) : null}
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Progress
          percent={toPercent(
            progress.completedBatches,
            progress.totalBatches,
            progress.status,
          )}
          status={toProgressStatus(progress.status)}
          format={() => `${progress.completedBatches}/${progress.totalBatches} 批`}
        />
        {details}
        {progress.errorMessage ? (
          <Alert type="error" showIcon message={progress.errorMessage} />
        ) : null}
      </Space>
    </Card>
  );
}

function toPercent(
  completed: number,
  total: number,
  status: 'running' | 'done' | 'error',
): number {
  if (total <= 0) {
    return status === 'done' ? 100 : 0;
  }
  return Number(((completed / total) * 100).toFixed(1));
}

function toProgressStatus(
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

function toTaskStatusColor(status: 'running' | 'done' | 'error'): string {
  switch (status) {
    case 'done':
      return 'success';
    case 'error':
      return 'error';
    default:
      return 'processing';
  }
}

function toTaskStatusLabel(status: 'running' | 'done' | 'error'): string {
  switch (status) {
    case 'done':
      return '已完成';
    case 'error':
      return '失败';
    default:
      return '进行中';
  }
}
