import { Text, useInput } from 'ink';
import type { TranslationProjectSnapshot, TranslationStepQueueSnapshot } from '../../project/types.ts';
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
  | 'scan-dictionary'
  | 'dictionary'
  | 'history'
  | 'plot-summary'
  | 'refresh'
  | 'open'
  | 'back';

export function WorkspaceProgressScreen() {
  const { goBack, navigate } = useNavigation();
  const {
    project,
    snapshot,
    isBusy,
    plotSummaryReady,
    startTranslation,
    pauseTranslation,
    resumeTranslation,
    saveProgress,
    abortTranslation,
    scanDictionary,
    refreshSnapshot,
  } = useProject();

  useInput((_input, key) => {
    if (key.escape) {
      goBack();
    }
  });

  const workspaceConfig = project?.getWorkspaceConfig();
  const glossaryTerms = project?.getGlossary()?.getAllTerms().length ?? 0;
  const items = buildActionItems(snapshot, Boolean(project), glossaryTerms > 0, plotSummaryReady);

  return (
    <SafeBox flexDirection="column" gap={1}>
      <SafeBox flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
        <Text bold color="green">项目信息</Text>
        {!snapshot ? (
          <Text dimColor>尚无激活项目，请先创建或打开工作区。</Text>
        ) : (
          <SafeBox flexDirection="column">
            <Text>
              <Text color="cyan" bold>{snapshot.projectName}</Text>
              <Text dimColor> · </Text>
              <Text color={getStatusColor(snapshot.lifecycle.status)}>{formatRunStatus(snapshot.lifecycle.status)}</Text>
              {isBusy ? <Text color="yellow"> · 处理中</Text> : null}
              {snapshot.lifecycle.lastSavedAt ? <Text dimColor> · 保存于 {snapshot.lifecycle.lastSavedAt}</Text> : null}
            </Text>
            <Text>
              章节 {snapshot.progress.translatedChapters}/{snapshot.progress.totalChapters}
              {' · '}文本块 {snapshot.progress.translatedFragments}/{snapshot.progress.totalFragments}
              {' · '}进度 {formatPercent(snapshot.progress.fragmentProgressRatio)}
              {' · '}队列 {snapshot.lifecycle.queuedWorkItems}排队 / {snapshot.lifecycle.activeWorkItems}运行
            </Text>
            <Text>
              翻译器：{workspaceConfig?.translator.modelName ? (
                <Text color="magenta">{workspaceConfig.translator.modelName}</Text>
              ) : <Text dimColor>未设置</Text>}
              {' / '}{workspaceConfig?.translator.workflow || 'default'}
              {' · '}字典：{snapshot.glossary ? (
                <Text color="yellow">{snapshot.glossary.totalTerms}项（已翻译 {snapshot.glossary.translatedTerms}）</Text>
              ) : <Text dimColor>未扫描</Text>}
              {' · '}大纲：{plotSummaryReady ? <Text color="green">已就绪</Text> : <Text dimColor>未生成</Text>}
            </Text>
          </SafeBox>
        )}
      </SafeBox>

      {snapshot && snapshot.queueSnapshots.length > 0 ? (
        <SafeBox flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
          <Text bold color="blue">步骤进度</Text>
          {snapshot.queueSnapshots.map((qs: TranslationStepQueueSnapshot) => (
            <Text key={qs.stepId} wrap="truncate-end">
              <Text bold>{qs.description}</Text>
              <Text dimColor> {qs.stepId}{qs.isFinalStep ? '·final' : ''} </Text>
              <Text>{renderProgressBar(qs.progress.completionRatio)} {formatPercent(qs.progress.completionRatio)}</Text>
              <Text dimColor> R{qs.progress.readyFragments} Q{qs.progress.queuedFragments} A{qs.progress.runningFragments} D{qs.progress.completedFragments}</Text>
            </Text>
          ))}
        </SafeBox>
      ) : null}

      <Select<ActionValue>
        title={isBusy ? '项目菜单（处理中）' : '项目菜单'}
        items={items}
        onSelect={(item) => {
          switch (item.value) {
            case 'open': navigate('workspace-create'); return;
            case 'start': void startTranslation(); return;
            case 'pause': void pauseTranslation(); return;
            case 'resume': void resumeTranslation(); return;
            case 'save': void saveProgress(); return;
            case 'abort': void abortTranslation(); return;
            case 'scan-dictionary': void scanDictionary(); return;
            case 'dictionary': navigate('workspace-dictionary'); return;
            case 'history': navigate('workspace-history'); return;
            case 'plot-summary': navigate('workspace-plot-summary'); return;
            case 'refresh': void refreshSnapshot(); return;
            case 'back': goBack(); return;
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
  hasDictionary: boolean,
  plotSummaryReady: boolean,
): SelectItem<ActionValue>[] {
  if (!snapshot || !hasProject) {
    return [
      {
        label: '📁 初始化项目工作流',
        value: 'open',
        description: '进入多步骤项目初始化向导。',
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

  if (snapshot.lifecycle.canStart && !snapshot.lifecycle.canResume) {
    items.push({
      label: '▶️ 开始翻译',
      value: 'start',
      description: '启动翻译流程并开始实际处理队列。',
      meta: 'start',
    });
  }

  if (snapshot.lifecycle.canResume) {
    items.push({
      label: '⏯️ 恢复翻译',
      value: 'resume',
      description: '从暂停、中断或中止状态恢复翻译处理。',
      meta: 'resume',
    });
  }

  if (snapshot.lifecycle.canStop) {
    items.push({
      label: '⏸️ 暂停翻译',
      value: 'pause',
      description: '停止继续调度新的工作项，等待当前项自然完成。',
      meta: 'pause',
    });
  }

  items.push({
    label: hasDictionary ? '📚 字典编辑' : '🔍 开始扫描字典',
    value: hasDictionary ? 'dictionary' : 'scan-dictionary',
    description: hasDictionary
      ? '浏览并编辑当前项目字典。'
      : '基于项目内容执行字典扫描，生成候选术语。',
    meta: hasDictionary ? 'glossary' : 'scan',
  });

  items.push({
    label: plotSummaryReady ? '📝 情节大纲（已就绪）' : '📝 总结情节大纲',
    value: 'plot-summary',
    description: plotSummaryReady
      ? '查看或重新生成情节大纲总结。'
      : '选择 LLM 预设开始生成情节大纲总结。',
    meta: 'plot',
  });

  if (snapshot.lifecycle.canSave) {
    items.push({
      label: '💾 保存项目进度',
      value: 'save',
      description: '持久化项目、章节与字典状态。',
      meta: 'save',
    });
  }

  if (snapshot.lifecycle.canAbort) {
    items.push({
      label: '🛑 中止翻译',
      value: 'abort',
      description: '立即中止当前翻译流程，并使工作项回队。',
      meta: 'abort',
    });
  }

  items.push({
    label: '🕘 查看历史日志',
    value: 'history',
    description: '查看当前事件日志以及可用的 LLM 请求历史。',
    meta: 'logs',
  });
  items.push({
    label: '🔄 刷新项目状态',
    value: 'refresh',
    description: '立即刷新当前项目快照。',
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
