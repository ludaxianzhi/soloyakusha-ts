import { useEffect, useMemo, useState } from 'react';
import { Text, useInput } from 'ink';
import { GlobalConfigManager } from '../../config/manager.ts';
import { Panel } from '../components/panel.tsx';
import { Select } from '../components/select.tsx';
import { SafeBox } from '../components/safe-box.tsx';
import { LogPanel } from '../components/log-panel.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import { useProject } from '../context/project.tsx';
import type { SelectItem } from '../types.ts';

type ProfileOption = {
  label: string;
  value: string;
};

type ScreenPhase = 'select-profile' | 'running' | 'done' | 'error';

export function WorkspacePlotSummaryScreen() {
  const { goBack } = useNavigation();
  const { addLog } = useLog();
  const { project, isBusy, startPlotSummary, plotSummaryProgress } = useProject();
  const [profileOptions, setProfileOptions] = useState<ProfileOption[]>([]);
  const [phase, setPhase] = useState<ScreenPhase>('select-profile');

  useInput((_input, key) => {
    if (key.escape && phase !== 'running') {
      goBack();
    }
  });

  useEffect(() => {
    void (async () => {
      try {
        const manager = new GlobalConfigManager();
        const profileNames = await manager.listLlmProfileNames();
        const defaultProfile = await manager.getDefaultLlmProfileName();
        const options = profileNames.map((name) => ({
          label: name === defaultProfile ? `${name} (默认)` : name,
          value: name,
        }));
        setProfileOptions(options);
      } catch (error) {
        addLog('warning', `读取 LLM 配置失败：${toErrorMessage(error)}`);
      }
    })();
  }, [addLog]);

  // Watch for progress completion
  useEffect(() => {
    if (phase === 'running' && plotSummaryProgress) {
      if (plotSummaryProgress.status === 'done') {
        setPhase('done');
      } else if (plotSummaryProgress.status === 'error') {
        setPhase('error');
      }
    }
  }, [phase, plotSummaryProgress]);

  const selectItems = useMemo<SelectItem<string>[]>(() => {
    const items: SelectItem<string>[] = profileOptions.map((option) => ({
      label: `🤖 ${option.label}`,
      value: option.value,
      description: `使用 ${option.value} 生成情节大纲总结`,
      meta: 'profile',
    }));

    items.push({
      label: '↩️ 返回',
      value: '__back__',
      description: '回到项目主页。',
      meta: 'esc',
    });

    return items;
  }, [profileOptions]);

  if (!project) {
    return (
      <SafeBox flexDirection="column" gap={1}>
        <Panel title="情节大纲总结" tone="magenta">
          <Text dimColor>当前没有已初始化的项目，请先创建或打开项目。</Text>
        </Panel>
      </SafeBox>
    );
  }

  if (phase === 'select-profile') {
    return (
      <SafeBox flexDirection="column" gap={1}>
        <Panel
          title="情节大纲总结"
          subtitle="选择一个 LLM 预设来生成情节大纲总结。"
          tone="magenta"
        >
          <SafeBox flexDirection="column">
            <Text>
              项目：<Text color="cyan">{project.getWorkspaceConfig().projectName}</Text>
            </Text>
            <Text dimColor>
              总结将基于源语言文本，按章节批量生成结构化情节摘要。
            </Text>
          </SafeBox>
        </Panel>

        <Select
          title="选择 LLM 预设"
          description={
            profileOptions.length > 0
              ? '选定后将立即开始生成。'
              : '未找到可用的 LLM Profile，请先在全局配置中添加。'
          }
          items={selectItems}
          isActive={!isBusy}
          onSelect={(item) => {
            if (item.value === '__back__') {
              goBack();
              return;
            }

            setPhase('running');
            void startPlotSummary(item.value);
          }}
        />
      </SafeBox>
    );
  }

  // Running / Done / Error phases
  const progress = plotSummaryProgress;
  const progressText = progress
    ? `${progress.completedChapters}/${progress.totalChapters} 章节 · ${progress.completedBatches}/${progress.totalBatches} 批次`
    : '准备中...';

  const statusColor = phase === 'done' ? 'green' : phase === 'error' ? 'red' : 'yellow';
  const statusLabel = phase === 'done' ? '已完成' : phase === 'error' ? '出错' : '总结中';

  const doneItems: SelectItem<string>[] = [
    {
      label: '↩️ 返回项目主页',
      value: '__back__',
      description: '回到项目主页。',
      meta: 'esc',
    },
  ];

  return (
    <SafeBox flexDirection="column" gap={1}>
      <Panel
        title="情节大纲总结"
        subtitle={progressText}
        tone={phase === 'done' ? 'green' : phase === 'error' ? 'yellow' : 'magenta'}
      >
        <SafeBox flexDirection="column">
          <Text>
            状态：<Text color={statusColor}>{statusLabel}</Text>
          </Text>
          {progress ? (
            <>
              <Text>
                章节进度：{renderProgressBar(progress.totalChapters > 0 ? progress.completedChapters / progress.totalChapters : 0)}{' '}
                {progress.completedChapters}/{progress.totalChapters}
              </Text>
              <Text>
                批次进度：{renderProgressBar(progress.totalBatches > 0 ? progress.completedBatches / progress.totalBatches : 0)}{' '}
                {progress.completedBatches}/{progress.totalBatches}
              </Text>
              {progress.currentChapterId != null ? (
                <Text dimColor>
                  当前章节：Chapter {progress.currentChapterId}
                </Text>
              ) : null}
            </>
          ) : null}
        </SafeBox>
      </Panel>

      <LogPanel />

      {phase !== 'running' ? (
        <Select
          title="操作"
          description={phase === 'done' ? '情节大纲总结已完成。' : '总结过程中出现错误。'}
          items={doneItems}
          isActive
          onSelect={() => goBack()}
        />
      ) : null}
    </SafeBox>
  );
}

function renderProgressBar(value: number): string {
  const width = 20;
  const filled = Math.max(0, Math.min(width, Math.round(value * width)));
  return `[${'='.repeat(filled)}${'-'.repeat(width - filled)}]`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
