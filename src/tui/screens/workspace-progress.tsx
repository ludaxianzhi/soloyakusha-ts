import { Text, useInput } from 'ink';
import type { TranslationProjectSnapshot, TranslationStepQueueSnapshot } from '../../project/types.ts';
import { Panel } from '../components/panel.tsx';
import { Select } from '../components/select.tsx';
import { SafeBox } from '../components/safe-box.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useProject } from '../context/project.tsx';
import type { SelectItem } from '../types.ts';

type ActionValue =
  | 'start'
  | 'pause'
  | 'resume'
  | 'save'
  | 'abort'
  | 'refresh'
  | 'open'
  | 'back';

export function WorkspaceProgressScreen() {
  const { goBack, navigate } = useNavigation();
  const {
    project,
    snapshot,
    isBusy,
    startTranslation,
    pauseTranslation,
    resumeTranslation,
    saveProgress,
    abortTranslation,
    refreshSnapshot,
  } = useProject();

  useInput((_input, key) => {
    if (key.escape) {
      goBack();
    }
  });

  const items = buildActionItems(snapshot, Boolean(project));

  return (
    <SafeBox flexDirection="column" gap={1}>
      <Panel
        title="项目进度总览"
        subtitle={project ? '实时读取当前项目快照。' : '请先创建或打开一个工作区。'}
        tone="green"
      >
        {!snapshot ? (
          <SafeBox flexDirection="column">
            <Text dimColor>当前还没有激活的项目实例。</Text>
            <Text dimColor>请先进入“创建工作区”完成初始化或打开已有工作区。</Text>
          </SafeBox>
        ) : (
          <SafeBox flexDirection="column">
            <Text>
              项目：<Text color="cyan">{snapshot.projectName}</Text>
            </Text>
            <Text>
              状态：<Text color={getStatusColor(snapshot.lifecycle.status)}>{formatRunStatus(snapshot.lifecycle.status)}</Text>
              {snapshot.lifecycle.lastSavedAt ? (
                <Text dimColor> · 最近保存：{snapshot.lifecycle.lastSavedAt}</Text>
              ) : null}
            </Text>
            <Text>
              章节：{snapshot.progress.translatedChapters}/{snapshot.progress.totalChapters} ·
              文本块：{snapshot.progress.translatedFragments}/{snapshot.progress.totalFragments}
            </Text>
            <Text>
              总进度：{formatPercent(snapshot.progress.fragmentProgressRatio)} ·
              队列：排队 {snapshot.lifecycle.queuedWorkItems} / 运行中 {snapshot.lifecycle.activeWorkItems}
            </Text>
            <Text dimColor>
              当前游标：
              {snapshot.currentCursor.chapterId
                ? ` Chapter ${snapshot.currentCursor.chapterId} / Fragment ${snapshot.currentCursor.fragmentIndex ?? 0}`
                : ' 暂无'}
            </Text>
          </SafeBox>
        )}
      </Panel>

      <Panel title="步骤进度" subtitle="逐步查看当前 Pipeline 的排队与完成情况。" tone="blue">
        {!snapshot ? (
          <Text dimColor>项目初始化后，这里会显示每个步骤的实时进度。</Text>
        ) : (
          <SafeBox flexDirection="column">
            {snapshot.queueSnapshots.map((queueSnapshot: TranslationStepQueueSnapshot) => (
              <SafeBox key={queueSnapshot.stepId} flexDirection="column" marginBottom={1}>
                <Text bold>
                  {queueSnapshot.description} ({queueSnapshot.stepId})
                  {queueSnapshot.isFinalStep ? ' · final' : ''}
                </Text>
                <Text dimColor>
                  {renderProgressBar(queueSnapshot.progress.completionRatio)}{' '}
                  {formatPercent(queueSnapshot.progress.completionRatio)}
                </Text>
                <Text dimColor>
                  ready {queueSnapshot.progress.readyFragments} · queued {queueSnapshot.progress.queuedFragments} ·
                  running {queueSnapshot.progress.runningFragments} · completed {queueSnapshot.progress.completedFragments}
                </Text>
              </SafeBox>
            ))}
          </SafeBox>
        )}
      </Panel>

      <Select<ActionValue>
        title={isBusy ? '项目控制动作（处理中）' : '项目控制动作'}
        description="选择要执行的项目控制动作。"
        items={items}
        onSelect={(item) => {
          switch (item.value) {
            case 'open':
              navigate('workspace-create');
              return;
            case 'start':
              void startTranslation();
              return;
            case 'pause':
              void pauseTranslation();
              return;
            case 'resume':
              void resumeTranslation();
              return;
            case 'save':
              void saveProgress();
              return;
            case 'abort':
              void abortTranslation();
              return;
            case 'refresh':
              void refreshSnapshot();
              return;
            case 'back':
              goBack();
              return;
          }
        }}
        isActive={!isBusy}
      />
    </SafeBox>
  );
}

function buildActionItems(
  snapshot: TranslationProjectSnapshot | null,
  hasProject: boolean,
): SelectItem<ActionValue>[] {
  if (!snapshot || !hasProject) {
    return [
      {
        label: '📁 初始化 / 打开工作区',
        value: 'open',
        description: '进入工作区表单，初始化新项目或打开已有工作区。',
        meta: 'init',
      },
      {
        label: '↩️ 返回',
        value: 'back',
        description: '回到工作区菜单。',
        meta: 'esc',
      },
    ];
  }

  const items: SelectItem<ActionValue>[] = [];
  if (snapshot.lifecycle.canStart && snapshot.lifecycle.status !== 'stopped' && snapshot.lifecycle.status !== 'aborted' && snapshot.lifecycle.status !== 'interrupted') {
    items.push({
      label: '▶️ 开始翻译',
      value: 'start',
      description: '启动翻译流程并进入运行状态。',
      meta: 'start',
    });
  }

  if (snapshot.lifecycle.canResume) {
    items.push({
      label: '⏯️ 恢复翻译',
      value: 'resume',
      description: '从暂停、中断或中止后的状态恢复翻译流程。',
      meta: 'resume',
    });
  }

  if (snapshot.lifecycle.canStop) {
    items.push({
      label: '⏸️ 暂停翻译',
      value: 'pause',
      description: '提交温和暂停请求，停止继续调度新的工作项。',
      meta: 'pause',
    });
  }

  if (snapshot.lifecycle.canSave) {
    items.push({
      label: '💾 保存进度',
      value: 'save',
      description: '持久化当前章节状态、术语表和项目生命周期信息。',
      meta: 'save',
    });
  }

  if (snapshot.lifecycle.canAbort) {
    items.push({
      label: '🛑 中止翻译',
      value: 'abort',
      description: '立即中止当前翻译流程，并把运行项重新回队。',
      meta: 'abort',
    });
  }

  items.push({
    label: '🔄 刷新快照',
    value: 'refresh',
    description: '立即重新读取项目快照和当前进度信息。',
    meta: 'refresh',
  });
  items.push({
    label: '↩️ 返回',
    value: 'back',
    description: '回到工作区菜单。',
    meta: 'esc',
  });
  return items;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function renderProgressBar(value: number): string {
  const width = 20;
  const filled = Math.max(0, Math.min(width, Math.round(value * width)));
  return `[${'='.repeat(filled)}${'-'.repeat(width - filled)}]`;
}

function getStatusColor(status: string): 'yellow' | 'green' | 'red' | 'blue' | 'magenta' | 'cyan' {
  switch (status) {
    case 'running':
      return 'green';
    case 'completed':
      return 'cyan';
    case 'stopped':
      return 'yellow';
    case 'stopping':
      return 'magenta';
    case 'aborted':
      return 'red';
    case 'interrupted':
      return 'yellow';
    default:
      return 'blue';
  }
}

function formatRunStatus(status: string): string {
  switch (status) {
    case 'idle':
      return '未启动';
    case 'running':
      return '运行中';
    case 'stopping':
      return '停止中';
    case 'stopped':
      return '已暂停';
    case 'aborted':
      return '已中止';
    case 'completed':
      return '已完成';
    case 'interrupted':
      return '中断待恢复';
    default:
      return status;
  }
}
