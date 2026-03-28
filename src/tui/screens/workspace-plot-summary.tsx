import { useEffect, useMemo, useState } from 'react';
import { Text, useInput } from 'ink';
import { GlobalConfigManager } from '../../config/manager.ts';
import { Select } from '../components/select.tsx';
import { SafeBox } from '../components/safe-box.tsx';
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
<SafeBox flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
          <Text bold color="magenta">情节大纲总结</Text>
          <Text dimColor>当前没有已初始化的项目，请先创建或打开项目。</Text>
        </SafeBox>
      </SafeBox>
    );
  }

  if (phase === 'select-profile') {
    return (
      <SafeBox flexDirection="column" gap={1}>
        <SafeBox flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
          <Text bold color="magenta">情节大纲总结</Text>
          <Text>项目：<Text color="cyan">{project.getWorkspaceConfig().projectName}</Text></Text>
        </SafeBox>

        <Select
          title="选择 LLM 预设"
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
      <SafeBox flexDirection="column" borderStyle="round" borderColor={phase === 'done' ? 'green' : phase === 'error' ? 'yellow' : 'magenta'} paddingX={1}>
        <Text bold color={phase === 'done' ? 'green' : phase === 'error' ? 'yellow' : 'magenta'}>情节大纲总结</Text>
        <Text dimColor>{progressText}</Text>
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
      </SafeBox>

      {phase !== 'running' ? (
        <Select
          title="操作"
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
