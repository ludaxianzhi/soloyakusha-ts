import type { ReactNode } from 'react';
import { Alert, Button, Card, Col, Popconfirm, Progress, Row, Space, Tag } from 'antd';
import {
  CloseOutlined,
  DeleteOutlined,
  MinusCircleOutlined,
  PlayCircleOutlined,
  StopOutlined,
} from '@ant-design/icons';
import type { ProjectStatus } from '../../app/types.ts';
import type { TaskActivityKind } from './types.ts';

interface TaskActivityPanelsProps {
  projectStatus: ProjectStatus | null;
  tasks?: TaskActivityKind[];
  onAbortTaskActivity: (task: TaskActivityKind) => void | Promise<void>;
  onForceAbortTaskActivity: (task: TaskActivityKind) => void | Promise<void>;
  onRemoveTaskActivity: (task: TaskActivityKind) => void | Promise<void>;
  onResumeTaskActivity: (task: TaskActivityKind) => void | Promise<void>;
  onDismissTaskActivity: (task: TaskActivityKind) => void | Promise<void>;
}

export function TaskActivityPanels({
  projectStatus,
  tasks = ['scan', 'plot', 'proofread'],
  onAbortTaskActivity,
  onForceAbortTaskActivity,
  onRemoveTaskActivity,
  onResumeTaskActivity,
  onDismissTaskActivity,
}: TaskActivityPanelsProps) {
  const visibleTasks: Array<{
    key: TaskActivityKind;
    title: string;
    progress:
      | NonNullable<ProjectStatus['scanDictionaryProgress']>
      | NonNullable<ProjectStatus['plotSummaryProgress']>
      | NonNullable<ProjectStatus['proofreadProgress']>;
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
            {projectStatus.scanDictionaryProgress.currentBatchIndex != null ? (
              <Tag color="processing">{`下一批次 ${projectStatus.scanDictionaryProgress.currentBatchIndex}`}</Tag>
            ) : null}
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
      continue;
    }

    if (task === 'proofread' && projectStatus?.proofreadProgress) {
      const proofreadProgress = projectStatus.proofreadProgress;
      visibleTasks.push({
        key: 'proofread',
        title: '章节校对',
        progress: proofreadProgress,
        details: (
          <Space direction="vertical" style={{ width: '100%' }} size={8}>
            <Progress
              percent={toPercent(
                proofreadProgress.completedChapters,
                proofreadProgress.totalChapters,
                proofreadProgress.status,
              )}
              status={toProgressStatus(proofreadProgress.status)}
              format={() =>
                `${proofreadProgress.completedChapters}/${proofreadProgress.totalChapters} 章节`
              }
            />
            <Space wrap>
              <Tag>{proofreadProgress.mode === 'linear' ? '线性校对' : '同时校对'}</Tag>
              <Tag>{`选中 ${proofreadProgress.chapterIds.length} 章节`}</Tag>
              <Tag>{`警告 ${proofreadProgress.warningCount}`}</Tag>
              {proofreadProgress.currentChapterId != null ? (
                <Tag color="processing">{`当前章节 ${proofreadProgress.currentChapterId}`}</Tag>
              ) : null}
            </Space>
            {proofreadProgress.lastWarningMessage ? (
              <Alert type="warning" showIcon message={proofreadProgress.lastWarningMessage} />
            ) : null}
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
            onAbort={() => void onAbortTaskActivity(task.key)}
            onForceAbort={
              task.key === 'proofread'
                ? () => void onForceAbortTaskActivity(task.key)
                : undefined
            }
            onRemove={
              task.key === 'proofread'
                ? () => void onRemoveTaskActivity(task.key)
                : undefined
            }
            onResume={() => void onResumeTaskActivity(task.key)}
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
  onAbort,
  onForceAbort,
  onRemove,
  onResume,
  onDismiss,
}: {
  task: TaskActivityKind;
  title: string;
  progress:
    | NonNullable<ProjectStatus['scanDictionaryProgress']>
    | NonNullable<ProjectStatus['plotSummaryProgress']>
    | NonNullable<ProjectStatus['proofreadProgress']>;
  details: ReactNode;
  onAbort: () => void;
  onForceAbort?: () => void;
  onRemove?: () => void;
  onResume: () => void;
  onDismiss: () => void;
}) {
  const isRunning = progress.status === 'running';
  const isDone = progress.status === 'done';
  const isProofread = task === 'proofread';
  const isDismissable = !isProofread && progress.status !== 'running';

  return (
    <Card
      size="small"
      title={title}
      extra={
        <Space size="small">
          <Tag color={toTaskStatusColor(progress.status)}>
            {toTaskStatusLabel(progress.status)}
          </Tag>
          {isRunning ? (
            <Button
              type="text"
              size="small"
              icon={<MinusCircleOutlined />}
              onClick={onAbort}
              aria-label={`中止${task}任务`}
            />
          ) : null}
          {isProofread && isRunning && onForceAbort ? (
            <Popconfirm
              title="确认强行中止校对任务？"
              description="当前正在处理的片段结果会被丢弃，任务会保留为暂停状态，可稍后继续。"
              okText="强行中止"
              cancelText="取消"
              onConfirm={onForceAbort}
            >
              <Button
                danger
                type="text"
                size="small"
                icon={<StopOutlined />}
                aria-label="强行中止校对任务"
              />
            </Popconfirm>
          ) : null}
          {!isRunning && !isDone ? (
            <Button
              type="text"
              size="small"
              icon={<PlayCircleOutlined />}
              onClick={onResume}
              aria-label={`继续${task}任务`}
            />
          ) : null}
          {isProofread && onRemove ? (
            <Popconfirm
              title={isRunning ? '确认移除正在运行的校对任务？' : '确认移除校对任务？'}
              description={
                isRunning
                  ? '当前正在处理的片段结果会被丢弃，且该校对任务会从项目状态中删除。'
                  : '移除后将删除该校对任务的持久化状态与进度卡片。'
              }
              okText="移除任务"
              cancelText="取消"
              onConfirm={onRemove}
            >
              <Button
                danger
                type="text"
                size="small"
                icon={<DeleteOutlined />}
                aria-label="移除校对任务"
              />
            </Popconfirm>
          ) : null}
          {isDismissable ? (
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
  status: 'running' | 'paused' | 'done' | 'error',
): number {
  if (total <= 0) {
    return status === 'done' ? 100 : 0;
  }
  return Number(((completed / total) * 100).toFixed(1));
}

function toProgressStatus(
  status: 'running' | 'paused' | 'done' | 'error',
): 'active' | 'success' | 'exception' {
  switch (status) {
    case 'done':
      return 'success';
    case 'error':
    case 'paused':
      return 'exception';
    default:
      return 'active';
  }
}

function toTaskStatusColor(status: 'running' | 'paused' | 'done' | 'error'): string {
  switch (status) {
    case 'done':
      return 'success';
    case 'error':
      return 'error';
    case 'paused':
      return 'warning';
    default:
      return 'processing';
  }
}

function toTaskStatusLabel(status: 'running' | 'paused' | 'done' | 'error'): string {
  switch (status) {
    case 'done':
      return '已完成';
    case 'error':
      return '失败';
    case 'paused':
      return '已中止';
    default:
      return '进行中';
  }
}
