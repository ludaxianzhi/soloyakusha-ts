import { access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { TranslationProject } from '../../project/translation-project.ts';
import type { TranslationProjectSnapshot } from '../../project/types.ts';
import { useLog } from './log.tsx';

export interface InitializeProjectInput {
  projectName: string;
  projectDir: string;
  chapterPaths: string[];
  glossaryPath?: string;
  srcLang?: string;
  tgtLang?: string;
}

interface ProjectContextValue {
  project: TranslationProject | null;
  snapshot: TranslationProjectSnapshot | null;
  isBusy: boolean;
  initializeProject: (input: InitializeProjectInput) => Promise<boolean>;
  refreshSnapshot: () => Promise<void>;
  startTranslation: () => Promise<void>;
  pauseTranslation: () => Promise<void>;
  resumeTranslation: () => Promise<void>;
  saveProgress: () => Promise<void>;
  abortTranslation: () => Promise<void>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

const POLL_INTERVAL_MS = 1000;

export function ProjectProvider({ children }: { children: ReactNode }) {
  const { addLog } = useLog();
  const [project, setProject] = useState<TranslationProject | null>(null);
  const [snapshot, setSnapshot] = useState<TranslationProjectSnapshot | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const previousSnapshotRef = useRef<TranslationProjectSnapshot | null>(null);

  const refreshSnapshot = useCallback(async () => {
    if (!project) {
      setSnapshot(null);
      previousSnapshotRef.current = null;
      return;
    }

    setSnapshot(project.getProjectSnapshot());
  }, [project]);

  useEffect(() => {
    if (!project) {
      return undefined;
    }

    const timer = setInterval(() => {
      try {
        setSnapshot(project.getProjectSnapshot());
      } catch (error) {
        addLog('error', `刷新项目快照失败: ${toErrorMessage(error)}`);
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [addLog, project]);

  useEffect(() => {
    if (!snapshot) {
      previousSnapshotRef.current = null;
      return;
    }

    const previous = previousSnapshotRef.current;
    if (previous) {
      if (previous.lifecycle.status !== snapshot.lifecycle.status) {
        addLog(
          'info',
          `项目状态已切换为 ${formatRunStatus(snapshot.lifecycle.status)}`,
        );
      }

      if (
        previous.progress.translatedFragments !== snapshot.progress.translatedFragments ||
        previous.progress.totalFragments !== snapshot.progress.totalFragments
      ) {
        addLog(
          'success',
          `翻译进度 ${snapshot.progress.translatedFragments}/${snapshot.progress.totalFragments} 文本块`,
        );
      } else if (
        previous.lifecycle.queuedWorkItems !== snapshot.lifecycle.queuedWorkItems ||
        previous.lifecycle.activeWorkItems !== snapshot.lifecycle.activeWorkItems
      ) {
        addLog(
          'info',
          `队列更新：排队 ${snapshot.lifecycle.queuedWorkItems} / 运行中 ${snapshot.lifecycle.activeWorkItems}`,
        );
      }
    }

    previousSnapshotRef.current = snapshot;
  }, [addLog, snapshot]);

  const runAction = useCallback(
    async (label: string, action: () => Promise<void>) => {
      if (isBusy) {
        addLog('warning', `正在执行其他项目操作，请稍候后再试：${label}`);
        return;
      }

      setIsBusy(true);
      addLog('info', `${label}...`);
      try {
        await action();
      } catch (error) {
        addLog('error', `${label}失败：${toErrorMessage(error)}`);
      } finally {
        setIsBusy(false);
      }
    },
    [addLog, isBusy],
  );

  const initializeProject = useCallback(
    async (input: InitializeProjectInput): Promise<boolean> => {
      if (isBusy) {
        addLog('warning', '正在执行其他项目操作，请稍候后再试');
        return false;
      }

      const normalizedDir = input.projectDir.trim();
      if (!normalizedDir) {
        addLog('warning', '工作区路径不能为空');
        return false;
      }

      setIsBusy(true);
      try {
        const hasWorkspaceConfig = await fileExists(
          join(normalizedDir, 'Data', 'workspace-config.json'),
        );

        let nextProject: TranslationProject;
        if (hasWorkspaceConfig) {
          addLog('info', `检测到已有工作区，正在打开：${normalizedDir}`);
          nextProject = await TranslationProject.openWorkspace(normalizedDir);
        } else {
          const chapterPaths = input.chapterPaths
            .map((item) => item.trim())
            .filter(Boolean);

          if (!input.projectName.trim()) {
            addLog('warning', '新建项目时，工作区名称不能为空');
            return false;
          }

          if (chapterPaths.length === 0) {
            addLog('warning', '新建项目时，至少需要提供一个章节文件路径');
            return false;
          }

          addLog('info', `正在初始化项目：${input.projectName.trim()}`);
          nextProject = new TranslationProject({
            projectName: input.projectName.trim(),
            projectDir: normalizedDir,
            chapters: chapterPaths.map((filePath, index) => ({
              id: index + 1,
              filePath,
            })),
            glossary: input.glossaryPath?.trim()
              ? {
                  path: input.glossaryPath.trim(),
                  autoFilter: true,
                }
              : undefined,
            customRequirements: [
              input.srcLang?.trim() ? `源语言: ${input.srcLang.trim()}` : undefined,
              input.tgtLang?.trim() ? `目标语言: ${input.tgtLang.trim()}` : undefined,
            ].filter((value): value is string => Boolean(value)),
          });
          await nextProject.initialize();
        }

        const nextSnapshot = nextProject.getProjectSnapshot();
        previousSnapshotRef.current = nextSnapshot;
        setProject(nextProject);
        setSnapshot(nextSnapshot);
        addLog(
          'success',
          `${hasWorkspaceConfig ? '已打开工作区' : '已初始化项目'}：${nextSnapshot.projectName}`,
        );
        return true;
      } catch (error) {
        addLog('error', `初始化项目失败：${toErrorMessage(error)}`);
        return false;
      } finally {
        setIsBusy(false);
      }
    },
    [addLog, isBusy],
  );

  const startTranslation = useCallback(
    async () =>
      runAction('启动翻译流程', async () => {
        if (!project) {
          throw new Error('当前没有已初始化的项目');
        }
        const lifecycle = await project.startTranslation();
        setSnapshot(project.getProjectSnapshot());
        addLog(
          'success',
          `翻译流程已启动，当前状态：${formatRunStatus(lifecycle.status)}`,
        );
      }),
    [addLog, project, runAction],
  );

  const pauseTranslation = useCallback(
    async () =>
      runAction('暂停翻译流程', async () => {
        if (!project) {
          throw new Error('当前没有已初始化的项目');
        }
        const lifecycle = await project.stopTranslation();
        setSnapshot(project.getProjectSnapshot());
        addLog(
          'success',
          `已提交暂停请求，当前状态：${formatRunStatus(lifecycle.status)}`,
        );
      }),
    [addLog, project, runAction],
  );

  const resumeTranslation = useCallback(
    async () =>
      runAction('恢复翻译流程', async () => {
        if (!project) {
          throw new Error('当前没有已初始化的项目');
        }
        const lifecycle = await project.startTranslation();
        setSnapshot(project.getProjectSnapshot());
        addLog(
          'success',
          `翻译流程已恢复，当前状态：${formatRunStatus(lifecycle.status)}`,
        );
      }),
    [addLog, project, runAction],
  );

  const saveProgress = useCallback(
    async () =>
      runAction('保存项目进度', async () => {
        if (!project) {
          throw new Error('当前没有已初始化的项目');
        }
        await project.saveProgress();
        setSnapshot(project.getProjectSnapshot());
        addLog('success', '项目进度已保存');
      }),
    [addLog, project, runAction],
  );

  const abortTranslation = useCallback(
    async () =>
      runAction('中止翻译流程', async () => {
        if (!project) {
          throw new Error('当前没有已初始化的项目');
        }
        const lifecycle = await project.abortTranslation('tui_abort_requested');
        setSnapshot(project.getProjectSnapshot());
        addLog(
          'warning',
          `翻译流程已中止，当前状态：${formatRunStatus(lifecycle.status)}`,
        );
      }),
    [addLog, project, runAction],
  );

  const value = useMemo<ProjectContextValue>(
    () => ({
      project,
      snapshot,
      isBusy,
      initializeProject,
      refreshSnapshot,
      startTranslation,
      pauseTranslation,
      resumeTranslation,
      saveProgress,
      abortTranslation,
    }),
    [
      abortTranslation,
      initializeProject,
      isBusy,
      pauseTranslation,
      project,
      refreshSnapshot,
      resumeTranslation,
      saveProgress,
      snapshot,
      startTranslation,
    ],
  );

  return <ProjectContext value={value}>{children}</ProjectContext>;
}

export function useProject() {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error('useProject must be used within ProjectProvider');
  }
  return ctx;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
