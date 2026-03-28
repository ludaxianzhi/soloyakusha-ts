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
import { GlobalConfigManager } from '../../config/manager.ts';
import { FullTextGlossaryScanner } from '../../glossary/index.ts';
import type { GlossaryTermCategory } from '../../glossary/glossary.ts';
import { FileRequestHistoryLogger } from '../../llm/history.ts';
import { TranslationGlobalConfig } from '../../project/config.ts';
import type { TranslationProcessorConfig } from '../../project/config.ts';
import type { Logger } from '../../project/logger.ts';
import { PlotSummarizer } from '../../project/plot-summarizer.ts';
import { StoryTopology, MAIN_ROUTE_ID } from '../../project/story-topology.ts';
import { TranslationProject } from '../../project/translation-project.ts';
import type { TranslationProcessorResult } from '../../project/translation-processor.ts';
import type { TranslationProjectSnapshot, ProjectExportResult, WorkspaceChapterDescriptor, WorkspaceConfig, WorkspaceConfigPatch } from '../../project/types.ts';
import { useLog } from './log.tsx';

export interface BranchImportInput {
  routeId: string;
  routeName: string;
  forkAfterChapterId: number;
  chapterPaths: string[];
}

export interface InitializeProjectInput {
  projectName: string;
  projectDir: string;
  chapterPaths: string[];
  glossaryPath?: string;
  srcLang?: string;
  tgtLang?: string;
  importFormat?: string;
  translatorName?: string;
  branches?: BranchImportInput[];
}

export type PlotSummaryProgress = {
  status: 'running' | 'done' | 'error';
  totalChapters: number;
  completedChapters: number;
  totalBatches: number;
  completedBatches: number;
  currentChapterId?: number;
  errorMessage?: string;
};

export type ScanDictionaryProgress = {
  status: 'running' | 'done' | 'error';
  totalBatches: number;
  completedBatches: number;
  totalLines: number;
  errorMessage?: string;
};

interface ProjectContextValue {
  project: TranslationProject | null;
  snapshot: TranslationProjectSnapshot | null;
  isBusy: boolean;
  topology: StoryTopology | null;
  plotSummaryProgress: PlotSummaryProgress | null;
  plotSummaryReady: boolean;
  scanDictionaryProgress: ScanDictionaryProgress | null;
  initializeProject: (input: InitializeProjectInput) => Promise<boolean>;
  refreshSnapshot: () => Promise<void>;
  startTranslation: () => Promise<void>;
  pauseTranslation: () => Promise<void>;
  resumeTranslation: () => Promise<void>;
  saveProgress: () => Promise<void>;
  abortTranslation: () => Promise<void>;
  scanDictionary: () => Promise<void>;
  startPlotSummary: () => Promise<void>;
  exportProject: (formatName: string) => Promise<ProjectExportResult | null>;
  updateDictionaryTerm: (args: {
    originalTerm?: string;
    term: string;
    translation: string;
    description?: string;
    category?: string;
    status?: 'translated' | 'untranslated';
  }) => Promise<void>;
  getWorkspaceConfig: () => WorkspaceConfig | null;
  getChapterDescriptors: () => WorkspaceChapterDescriptor[];
  reorderChapters: (chapterIds: number[]) => Promise<void>;
  removeChapter: (chapterId: number) => Promise<void>;
  updateWorkspaceConfig: (patch: WorkspaceConfigPatch) => Promise<void>;
  importGlossary: (filePath: string) => Promise<void>;
  exportGlossary: (outputPath: string) => Promise<void>;
  closeWorkspace: () => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

const POLL_INTERVAL_MS = 1000;

export function ProjectProvider({ children }: { children: ReactNode }) {
  const { addLog } = useLog();
  const [project, setProject] = useState<TranslationProject | null>(null);
  const [snapshot, setSnapshot] = useState<TranslationProjectSnapshot | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [topology, setTopology] = useState<StoryTopology | null>(null);
  const [plotSummaryProgress, setPlotSummaryProgress] = useState<PlotSummaryProgress | null>(null);
  const [plotSummaryReady, setPlotSummaryReady] = useState(false);
  const [scanDictionaryProgress, setScanDictionaryProgress] = useState<ScanDictionaryProgress | null>(null);
  const previousSnapshotRef = useRef<TranslationProjectSnapshot | null>(null);
  const processingTokenRef = useRef(0);

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
        addLog('info', `项目状态已切换为 ${formatRunStatus(snapshot.lifecycle.status)}`);
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

  useEffect(() => {
    return () => {
      processingTokenRef.current += 1;
    };
  }, []);

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
      processingTokenRef.current += 1;
      try {
        const hasWorkspaceConfig = await fileExists(join(normalizedDir, 'Data', 'workspace-config.json'));

        let nextProject: TranslationProject;
        let nextTopology: StoryTopology | null = null;

        if (hasWorkspaceConfig) {
          addLog('info', `检测到已有工作区，正在打开：${normalizedDir}`);
          nextProject = await TranslationProject.openWorkspace(normalizedDir);
          nextTopology = nextProject.getStoryTopology() ?? null;
          if (nextTopology) {
            addLog('info', `已加载剧情拓扑（${nextTopology.getAllRoutes().length} 条路线）`);
          }
          setPlotSummaryReady(nextProject.hasPlotSummaries());
        } else {
          const chapterPaths = input.chapterPaths.map((item) => item.trim()).filter(Boolean);
          if (!input.projectName.trim()) {
            addLog('warning', '新建项目时，项目名称不能为空');
            return false;
          }
          if (chapterPaths.length === 0) {
            addLog('warning', '新建项目时，至少需要提供一个章节文件');
            return false;
          }

          // Collect all chapter paths (main + branches)
          const allChapterPaths = [...chapterPaths];
          const branches = input.branches ?? [];
          for (const branch of branches) {
            allChapterPaths.push(...branch.chapterPaths);
          }

          addLog('info', `正在初始化项目：${input.projectName.trim()}`);
          nextProject = new TranslationProject({
            projectName: input.projectName.trim(),
            projectDir: normalizedDir,
            chapters: allChapterPaths.map((filePath, index) => ({
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

          // Build topology from main + branches
          if (branches.length > 0) {
            nextTopology = StoryTopology.createEmpty();
            const mainChapterIds = chapterPaths.map((_, index) => index + 1);
            nextTopology.setMainRouteChapters(mainChapterIds);

            let chapterIdOffset = chapterPaths.length;
            for (const branch of branches) {
              const branchChapterIds = branch.chapterPaths.map(
                (_, index) => chapterIdOffset + index + 1,
              );
              chapterIdOffset += branch.chapterPaths.length;
              nextTopology.addBranch({
                id: branch.routeId,
                name: branch.routeName,
                forkAfterChapterId: branch.forkAfterChapterId,
                chapters: branchChapterIds,
              });
              addLog('info', `已添加支线"${branch.routeName}"（${branchChapterIds.length} 章节，从章节 ${branch.forkAfterChapterId} 分叉）`);
            }

            await nextProject.saveStoryTopology(nextTopology);
            addLog('success', '剧情拓扑已保存');
          }

          setPlotSummaryReady(false);
        }

        await applyWorkspacePreferences(nextProject, {
          importFormat: input.importFormat,
          translatorName: input.translatorName,
        });

        const nextSnapshot = nextProject.getProjectSnapshot();
        previousSnapshotRef.current = nextSnapshot;
        setProject(nextProject);
        setSnapshot(nextSnapshot);
        setTopology(nextTopology);
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

  const startTranslationLoop = useCallback(
    (currentProject: TranslationProject) => {
      const token = processingTokenRef.current + 1;
      processingTokenRef.current = token;

      void (async () => {
        try {
          const processor = await createProcessorForProject(currentProject, addLog);
          addLog('info', '翻译处理器已就绪，开始调度队列');

          while (processingTokenRef.current === token) {
            const lifecycle = currentProject.getLifecycleSnapshot();
            if (lifecycle.status !== 'running' && lifecycle.status !== 'stopping') {
              break;
            }

            let workItems = [] as Awaited<ReturnType<TranslationProject['dispatchReadyWorkItems']>>;
            try {
              workItems = await currentProject.dispatchReadyWorkItems();
            } catch (error) {
              const message = toErrorMessage(error);
              if (message.includes('停止中') || message.includes('尚未启动')) {
                break;
              }
              throw error;
            }

            if (workItems.length === 0) {
              await delay(400);
              setSnapshot(currentProject.getProjectSnapshot());
              continue;
            }

            for (const item of workItems) {
              if (processingTokenRef.current !== token) {
                return;
              }

              addLog(
                'info',
                `开始处理 ${item.stepId} · Chapter ${item.chapterId} / Fragment ${item.fragmentIndex + 1}`,
              );

              try {
                const result = await processor.processWorkItem(item, {
                  glossary: currentProject.getGlossary(),
                  documentManager: currentProject.getDocumentManager(),
                });
                if (processingTokenRef.current !== token) {
                  return;
                }

                await currentProject.submitWorkResult({
                  runId: item.runId,
                  stepId: item.stepId,
                  chapterId: item.chapterId,
                  fragmentIndex: item.fragmentIndex,
                  outputText: result.outputText,
                });
                await maybePersistProgress(currentProject, result);
                setSnapshot(currentProject.getProjectSnapshot());
                addLog(
                  'success',
                  `已完成 ${item.stepId} · Chapter ${item.chapterId} / Fragment ${item.fragmentIndex + 1}`,
                );
              } catch (error) {
                const message = toErrorMessage(error);
                if (processingTokenRef.current !== token) {
                  return;
                }

                try {
                  await currentProject.submitWorkResult({
                    runId: item.runId,
                    stepId: item.stepId,
                    chapterId: item.chapterId,
                    fragmentIndex: item.fragmentIndex,
                    success: false,
                    errorMessage: message,
                  });
                } catch (submitError) {
                  addLog('warning', `工作项回写失败：${toErrorMessage(submitError)}`);
                }

                setSnapshot(currentProject.getProjectSnapshot());
                addLog(
                  'error',
                  `处理失败 ${item.stepId} · Chapter ${item.chapterId} / Fragment ${item.fragmentIndex + 1}：${message}`,
                );
              }
            }
          }

          setSnapshot(currentProject.getProjectSnapshot());
        } catch (error) {
          addLog('error', `翻译执行循环异常：${toErrorMessage(error)}`);
          setSnapshot(currentProject.getProjectSnapshot());
        }
      })();
    },
    [addLog],
  );

  const startTranslation = useCallback(
    async () =>
      runAction('启动翻译流程', async () => {
        if (!project) {
          throw new Error('当前没有已初始化的项目');
        }

        if (!project.hasPlotSummaries()) {
          addLog('warning', '当前项目尚未生成情节大纲，将继续翻译，但可能影响上下文理解与翻译效果');
        }

        const lifecycle = await project.startTranslation();
        setSnapshot(project.getProjectSnapshot());
        addLog('success', `翻译流程已启动，当前状态：${formatRunStatus(lifecycle.status)}`);
        if (lifecycle.status === 'running') {
          startTranslationLoop(project);
        }
      }),
    [addLog, project, runAction, startTranslationLoop],
  );

  const pauseTranslation = useCallback(
    async () =>
      runAction('暂停翻译流程', async () => {
        if (!project) {
          throw new Error('当前没有已初始化的项目');
        }

        const lifecycle = await project.stopTranslation();
        setSnapshot(project.getProjectSnapshot());
        addLog('success', `已提交暂停请求，当前状态：${formatRunStatus(lifecycle.status)}`);
      }),
    [addLog, project, runAction],
  );

  const resumeTranslation = useCallback(
    async () =>
      runAction('恢复翻译流程', async () => {
        if (!project) {
          throw new Error('当前没有已初始化的项目');
        }

        if (!project.hasPlotSummaries()) {
          addLog('warning', '当前项目尚未生成情节大纲，将继续翻译，但可能影响上下文理解与翻译效果');
        }

        const lifecycle = await project.startTranslation();
        setSnapshot(project.getProjectSnapshot());
        addLog('success', `翻译流程已恢复，当前状态：${formatRunStatus(lifecycle.status)}`);
        if (lifecycle.status === 'running') {
          startTranslationLoop(project);
        }
      }),
    [addLog, project, runAction, startTranslationLoop],
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

        processingTokenRef.current += 1;
        const lifecycle = await project.abortTranslation('tui_abort_requested');
        setSnapshot(project.getProjectSnapshot());
        addLog('warning', `翻译流程已中止，当前状态：${formatRunStatus(lifecycle.status)}`);
      }),
    [addLog, project, runAction],
  );

  const scanDictionary = useCallback(
    async () => {
      if (isBusy) {
        addLog('warning', '正在执行其他项目操作，请稍候后再试：扫描项目字典');
        return;
      }
      if (!project) {
        addLog('warning', '当前没有已初始化的项目');
        return;
      }

      setIsBusy(true);
      setScanDictionaryProgress({
        status: 'running',
        totalBatches: 0,
        completedBatches: 0,
        totalLines: 0,
      });
      addLog('info', '扫描项目字典...');

      void (async () => {
        try {
          const manager = new GlobalConfigManager();
          const globalConfig = await manager.getTranslationGlobalConfig();
          const glossaryExtractorConfig = globalConfig.getGlossaryExtractorConfig();
          if (!glossaryExtractorConfig?.modelName) {
            throw new Error('未配置术语提取使用的 LLM，请先在翻译器配置中设置术语提取模型');
          }

          const provider = new TranslationGlobalConfig({ llm: globalConfig.llm }).createProvider();
          const projectDir = project.getWorkspaceFileManifest().projectDir;
          provider.setHistoryLogger(
            new FileRequestHistoryLogger(join(projectDir, 'logs'), 'glossary_scan_requests'),
          );

          const scanner = new FullTextGlossaryScanner(
            provider.getChatClient(glossaryExtractorConfig.modelName),
            createTuiLogger(addLog),
          );

          // Pre-calculate batches to show accurate total progress
          const lines = scanner.collectLinesFromDocumentManager(project.getDocumentManager());
          const batches = scanner.buildBatches(lines, {
            maxCharsPerBatch: glossaryExtractorConfig.maxCharsPerBatch,
          });

          addLog('info', `术语扫描开始，共 ${lines.length} 行，分 ${batches.length} 个批次`);
          setScanDictionaryProgress({
            status: 'running',
            totalBatches: batches.length,
            completedBatches: 0,
            totalLines: lines.length,
          });

          const result = await scanner.scanLines(lines, {
            maxCharsPerBatch: glossaryExtractorConfig.maxCharsPerBatch,
            occurrenceTopK: glossaryExtractorConfig.occurrenceTopK,
            occurrenceTopP: glossaryExtractorConfig.occurrenceTopP,
            requestOptions: glossaryExtractorConfig.requestOptions,
            seedTerms: project.getGlossary()?.getAllTerms(),
            onBatchProgress: (completed, total) => {
              setScanDictionaryProgress((prev) =>
                prev ? { ...prev, completedBatches: completed } : prev,
              );
              addLog('info', `术语扫描批次 ${completed}/${total} 完成`);
            },
          });

          project.replaceGlossary(result.glossary);
          await project.saveProgress();
          setSnapshot(project.getProjectSnapshot());
          setScanDictionaryProgress({
            status: 'done',
            totalBatches: batches.length,
            completedBatches: batches.length,
            totalLines: lines.length,
          });
          addLog(
            'success',
            `术语提取完成，共识别 ${result.glossary.getAllTerms().length} 个条目（${result.batches.length} 批）`,
          );
        } catch (error) {
          addLog('error', `扫描项目字典失败：${toErrorMessage(error)}`);
          setScanDictionaryProgress((prev) =>
            prev
              ? { ...prev, status: 'error', errorMessage: toErrorMessage(error) }
              : { status: 'error', totalBatches: 0, completedBatches: 0, totalLines: 0, errorMessage: toErrorMessage(error) },
          );
        } finally {
          setIsBusy(false);
        }
      })();
    },
    [addLog, isBusy, project],
  );

  const startPlotSummary = useCallback(
    async () => {
      if (isBusy) {
        addLog('warning', '正在执行其他项目操作，请稍候后再试');
        return;
      }
      if (!project) {
        addLog('warning', '当前没有已初始化的项目');
        return;
      }

      setIsBusy(true);
      setPlotSummaryProgress({
        status: 'running',
        totalChapters: 0,
        completedChapters: 0,
        totalBatches: 0,
        completedBatches: 0,
      });

      void (async () => {
        try {
          const manager = new GlobalConfigManager();
          const globalConfig = await manager.getTranslationGlobalConfig();
          const plotSummaryConfig = globalConfig.getPlotSummaryConfig();
          if (!plotSummaryConfig?.modelName) {
            throw new Error('未配置情节总结使用的 LLM，请先在翻译器配置中设置情节总结模型');
          }

          const runtimeConfig = new TranslationGlobalConfig({ llm: globalConfig.llm });
          const provider = runtimeConfig.createProvider();
          const documentManager = project.getDocumentManager();
          const projectDir = project.getWorkspaceFileManifest().projectDir;

          const historyLogger = new FileRequestHistoryLogger(
            join(projectDir, 'logs'),
            'plot_summary_requests',
          );
          provider.setHistoryLogger(historyLogger);

          const summaryPath = join(projectDir, 'Data', 'plot-summaries.json');
          const currentTopology = project.getStoryTopology();

          const summarizer = new PlotSummarizer(
            { provider, modelName: plotSummaryConfig.modelName },
            documentManager,
            summaryPath,
            {
              fragmentsPerBatch: plotSummaryConfig.fragmentsPerBatch,
              maxContextSummaries: plotSummaryConfig.maxContextSummaries,
              requestOptions: plotSummaryConfig.requestOptions,
              logger: createTuiLogger(addLog),
              topology: currentTopology,
            },
          );
          await summarizer.loadSummaries();

          const chapters = documentManager.getAllChapters();
          const totalChapters = chapters.length;

          // Estimate total batches
          let totalBatches = 0;
          const fragmentsPerBatch = plotSummaryConfig.fragmentsPerBatch ?? 5;
          for (const chapter of chapters) {
            totalBatches += Math.ceil(chapter.fragments.length / fragmentsPerBatch);
          }

          let completedChapters = 0;
          let completedBatches = 0;

          setPlotSummaryProgress({
            status: 'running',
            totalChapters,
            completedChapters: 0,
            totalBatches,
            completedBatches: 0,
          });

          for (const chapter of chapters) {
            addLog('info', `开始总结章节 ${chapter.id}（${chapter.fragments.length} 个文本块）`);
            setPlotSummaryProgress((prev) =>
              prev
                ? { ...prev, currentChapterId: chapter.id }
                : prev,
            );

            const chapterFragments = chapter.fragments.length;
            let fragmentIndex = 0;
            while (fragmentIndex < chapterFragments) {
              const count = Math.min(fragmentsPerBatch, chapterFragments - fragmentIndex);
              await summarizer.summarizeFragments(chapter.id, fragmentIndex, count);
              fragmentIndex += count;
              completedBatches += 1;

              setPlotSummaryProgress((prev) =>
                prev
                  ? { ...prev, completedBatches, completedChapters }
                  : prev,
              );
            }

            completedChapters += 1;
            addLog('success', `章节 ${chapter.id} 总结完成`);
            setPlotSummaryProgress((prev) =>
              prev
                ? { ...prev, completedChapters }
                : prev,
            );
          }

          setPlotSummaryProgress({
            status: 'done',
            totalChapters,
            completedChapters,
            totalBatches,
            completedBatches,
          });
          await project.reloadNarrativeArtifacts();
          setTopology(project.getStoryTopology() ?? null);
          setPlotSummaryReady(project.hasPlotSummaries());
          addLog('success', `情节大纲总结完成（共 ${totalChapters} 个章节，${completedBatches} 个批次）`);
        } catch (error) {
          addLog('error', `情节总结失败：${toErrorMessage(error)}`);
          setPlotSummaryProgress((prev) =>
            prev
              ? { ...prev, status: 'error', errorMessage: toErrorMessage(error) }
              : { status: 'error', totalChapters: 0, completedChapters: 0, totalBatches: 0, completedBatches: 0, errorMessage: toErrorMessage(error) },
          );
        } finally {
          setIsBusy(false);
        }
      })();
    },
    [addLog, isBusy, project],
  );

  const exportProject = useCallback(
    async (formatName: string): Promise<ProjectExportResult | null> => {
      if (!project) {
        addLog('warning', '当前没有已初始化的项目');
        return null;
      }

      let result: ProjectExportResult | null = null;
      await runAction('导出翻译文件', async () => {
        const exported = await project.exportProject(formatName);
        result = exported;
        addLog(
          'success',
          `导出完成：共 ${exported.totalChapters} 个章节，${exported.totalUnits} 个翻译单元 → ${exported.exportDir}`,
        );
      });
      return result;
    },
    [addLog, project, runAction],
  );

  const updateDictionaryTerm = useCallback(
    async ({
      originalTerm,
      term,
      translation,
      description,
      category,
      status,
    }: {
      originalTerm?: string;
      term: string;
      translation: string;
      description?: string;
      category?: string;
      status?: 'translated' | 'untranslated';
    }) =>
      runAction('保存字典条目', async () => {
        if (!project) {
          throw new Error('当前没有已初始化的项目');
        }

        const glossary = project.getGlossary();
        if (!glossary) {
          throw new Error('当前项目还没有可编辑的字典，请先执行字典扫描');
        }

        const existing = originalTerm ? glossary.getTerm(originalTerm) : glossary.getTerm(term);
        const nextTerm = {
          term,
          translation,
          description,
          category: normalizeGlossaryCategory(category),
          status: status ?? (translation.trim() ? 'translated' : 'untranslated'),
          totalOccurrenceCount: existing?.totalOccurrenceCount ?? 0,
          textBlockOccurrenceCount: existing?.textBlockOccurrenceCount ?? 0,
        };

        if (existing) {
          glossary.updateTerm(originalTerm ?? term, nextTerm);
        } else {
          glossary.addTerm(nextTerm);
        }

        await project.saveProgress();
        setSnapshot(project.getProjectSnapshot());
        addLog('success', `字典条目已保存：${term}`);
      }),
    [addLog, project, runAction],
  );

  const getWorkspaceConfig = useCallback(
    (): WorkspaceConfig | null => project?.getWorkspaceConfig() ?? null,
    [project],
  );

  const getChapterDescriptors = useCallback(
    (): WorkspaceChapterDescriptor[] => project?.getChapterDescriptors() ?? [],
    [project],
  );

  const reorderChapters = useCallback(
    async (chapterIds: number[]): Promise<void> => {
      if (!project) {
        addLog('warning', '当前没有已初始化的项目');
        return;
      }
      await runAction('保存章节排序', async () => {
        await project.reorderChapters(chapterIds);
      });
    },
    [addLog, project, runAction],
  );

  const removeChapter = useCallback(
    async (chapterId: number): Promise<void> => {
      if (!project) {
        addLog('warning', '当前没有已初始化的项目');
        return;
      }
      await runAction('删除章节', async () => {
        await project.removeChapter(chapterId);
        setSnapshot(project.getProjectSnapshot());
        setTopology(project.getStoryTopology() ?? null);
        addLog('success', `章节 ${chapterId} 已从工作区移除`);
      });
    },
    [addLog, project, runAction],
  );

  const updateWorkspaceConfig = useCallback(
    async (patch: WorkspaceConfigPatch): Promise<void> => {
      if (!project) {
        addLog('warning', '当前没有已初始化的项目');
        return;
      }
      await runAction('保存工作区配置', async () => {
        await project.updateWorkspaceConfig(patch);
        setSnapshot(project.getProjectSnapshot());
      });
    },
    [addLog, project, runAction],
  );

  const importGlossary = useCallback(
    async (filePath: string): Promise<void> => {
      if (!project) {
        addLog('warning', '当前没有已初始化的项目');
        return;
      }
      await runAction('导入术语表', async () => {
        const result = await project.importGlossary(filePath);
        await project.saveProgress();
        setSnapshot(project.getProjectSnapshot());
        addLog(
          'success',
          `术语表导入完成：${result.termCount} 项（新增 ${result.newTermCount}，更新 ${result.updatedTermCount}）`,
        );
      });
    },
    [addLog, project, runAction],
  );

  const exportGlossary = useCallback(
    async (outputPath: string): Promise<void> => {
      if (!project) {
        addLog('warning', '当前没有已初始化的项目');
        return;
      }
      await runAction('导出术语表', async () => {
        await project.exportGlossary(outputPath);
        addLog('success', `术语表已导出到：${outputPath}`);
      });
    },
    [addLog, project, runAction],
  );

  const closeWorkspace = useCallback(() => {
    processingTokenRef.current += 1;
    previousSnapshotRef.current = null;
    setProject(null);
    setSnapshot(null);
    setTopology(null);
    setPlotSummaryProgress(null);
    setPlotSummaryReady(false);
    setScanDictionaryProgress(null);
    setIsBusy(false);
    addLog('info', '已关闭当前工作区');
  }, [addLog]);

  const value = useMemo<ProjectContextValue>(
    () => ({
      project,
      snapshot,
      isBusy,
      topology,
      plotSummaryProgress,
      plotSummaryReady,
      scanDictionaryProgress,
      initializeProject,
      refreshSnapshot,
      startTranslation,
      pauseTranslation,
      resumeTranslation,
      saveProgress,
      abortTranslation,
      scanDictionary,
      startPlotSummary,
      exportProject,
      updateDictionaryTerm,
      getWorkspaceConfig,
      getChapterDescriptors,
      reorderChapters,
      removeChapter,
      updateWorkspaceConfig,
      importGlossary,
      exportGlossary,
      closeWorkspace,
    }),
    [
      abortTranslation,
      closeWorkspace,
      exportProject,
      exportGlossary,
      getChapterDescriptors,
      getWorkspaceConfig,
      importGlossary,
      initializeProject,
      isBusy,
      pauseTranslation,
      plotSummaryProgress,
      plotSummaryReady,
      project,
      refreshSnapshot,
      removeChapter,
      reorderChapters,
      resumeTranslation,
      saveProgress,
      scanDictionary,
      scanDictionaryProgress,
      snapshot,
      startPlotSummary,
      startTranslation,
      topology,
      updateDictionaryTerm,
      updateWorkspaceConfig,
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

async function applyWorkspacePreferences(
  project: TranslationProject,
  options: {
    importFormat?: string;
    translatorName?: string;
  },
): Promise<void> {
  const patch: Parameters<TranslationProject['updateWorkspaceConfig']>[0] = {};
  if (options.importFormat) {
    patch.defaultImportFormat = options.importFormat;
  }
  if (options.translatorName) {
    patch.translator = { translatorName: options.translatorName };
  }

  if (Object.keys(patch).length > 0) {
    await project.updateWorkspaceConfig(patch);
  }
}

async function createProcessorForProject(
  project: TranslationProject,
  addLog: (level: 'error' | 'warning' | 'info' | 'success', message: string) => void,
) {
  const manager = new GlobalConfigManager();
  const globalConfig = await manager.getTranslationGlobalConfig();
  const workspaceConfig = project.getWorkspaceConfig();

  let processorConfig: TranslationProcessorConfig;

  const translatorName = workspaceConfig.translator.translatorName;
  if (translatorName) {
    const translatorEntry = await manager.getTranslator(translatorName);
    if (!translatorEntry) {
      throw new Error(`未在翻译器目录中找到翻译器「${translatorName}」，请检查全局配置`);
    }
    processorConfig = {
      workflow: translatorEntry.type,
      modelName: translatorEntry.modelName,
      slidingWindow: translatorEntry.slidingWindow,
      requestOptions: translatorEntry.requestOptions,
    };
  } else {
    // 兼容旧版工作区：使用 workspace 内联 modelName 或全局 translationProcessor
    const baseProcessorConfig = await manager.getTranslationProcessorConfig().catch(() => undefined);
    const translatorModelName =
      workspaceConfig.translator.modelName ?? baseProcessorConfig?.modelName;

    if (!translatorModelName) {
      throw new Error(
        '未找到可用翻译器。请在「设置 → 翻译器目录」中创建翻译器，并在项目配置中选择。',
      );
    }

    addLog('warning', '当前项目使用旧版翻译器配置，建议在「工作区配置」中选择命名翻译器');
    processorConfig = {
      modelName: translatorModelName,
      workflow: workspaceConfig.translator.workflow ?? baseProcessorConfig?.workflow ?? 'default',
      slidingWindow: baseProcessorConfig?.slidingWindow,
      requestOptions: baseProcessorConfig?.requestOptions,
    };
  }

  const runtimeConfig = new TranslationGlobalConfig({
    llm: globalConfig.llm,
    translation: {
      translationProcessor: processorConfig,
      glossaryUpdater: globalConfig.getGlossaryUpdaterConfig(),
    },
  });

  const historyLogger = new FileRequestHistoryLogger(
    join(project.getWorkspaceFileManifest().projectDir, 'logs'),
    'llm_requests',
  );

  return runtimeConfig.createTranslationProcessor({
    hooks: { historyLogger },
    logger: createTuiLogger(addLog),
  });
}

async function maybePersistProgress(
  project: TranslationProject,
  result: TranslationProcessorResult,
): Promise<void> {
  if (result.glossaryUpdates.length > 0) {
    await project.saveProgress();
    return;
  }

  const snapshot = project.getProjectSnapshot();
  if (
    snapshot.progress.translatedFragments === snapshot.progress.totalFragments ||
    snapshot.progress.translatedFragments % 5 === 0
  ) {
    await project.saveProgress();
  }
}

function createTuiLogger(
  addLog: (level: 'error' | 'warning' | 'info' | 'success', message: string) => void,
): Logger {
  return {
    debug(message, metadata) {
      addLog('info', appendMetadata(message, metadata));
    },
    info(message, metadata) {
      addLog('info', appendMetadata(message, metadata));
    },
    warn(message, metadata) {
      addLog('warning', appendMetadata(message, metadata));
    },
    error(message, metadata) {
      addLog('error', appendMetadata(message, metadata));
    },
  };
}

function appendMetadata(message: string, metadata?: Record<string, unknown>): string {
  if (!metadata || Object.keys(metadata).length === 0) {
    return message;
  }

  return `${message} ${JSON.stringify(metadata)}`;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeGlossaryCategory(value?: string): GlossaryTermCategory | undefined {
  switch (value) {
    case 'personName':
    case 'placeName':
    case 'properNoun':
    case 'personTitle':
    case 'catchphrase':
      return value;
    default:
      return undefined;
  }
}
