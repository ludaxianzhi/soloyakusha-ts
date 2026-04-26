import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Tabs } from 'antd';
import { useLocation } from 'react-router-dom';
import { WorkspaceChaptersTab } from './workspace-view/WorkspaceChaptersTab.tsx';
import { WorkspaceConfigTab } from './workspace-view/WorkspaceConfigTab.tsx';
import { WorkspaceConsistencyTab } from './workspace-view/WorkspaceConsistencyTab.tsx';
import { WorkspaceDashboardTab } from './workspace-view/WorkspaceDashboardTab.tsx';
import { WorkspaceDictionaryTab } from './workspace-view/WorkspaceDictionaryTab.tsx';
import type { WorkspaceViewProps } from './workspace-view/types.ts';

export type { ProjectCommand, TaskActivityKind } from './workspace-view/types.ts';

export function WorkspaceView({
  snapshot,
  projectStatus,
  pipelineStrategy,
  mobileMode = false,
  sseConnected,
  dictionary,
  repeatedPatterns,
  chapters,
  topology,
  workspaceForm,
  defaultImportFormat,
  translatorOptions,
  llmProfileOptions,
  defaultLlmProfileName,
  onRefreshProjectStatus,
  onRefreshDictionary,
  onRefreshRepeatedPatterns,
  onScanRepeatedPatterns,
  onHydrateRepeatedPatterns,
  onSaveRepeatedPatternTranslation,
  onLoadRepeatedPatternContext,
  onStartRepeatedPatternConsistencyFix,
  onGetRepeatedPatternConsistencyFixStatus,
  onClearRepeatedPatternConsistencyFixStatus,
  onRefreshChapters,
  onRefreshTopology,
  onRefreshWorkspaceConfig,
  onProjectCommand,
  onBuildContextNetwork,
  onStartProofread,
  onOpenDictionaryEditor,
  onDeleteDictionary,
  onImportDictionaryFromContent,
  onWorkspaceConfigSave,
  onClearChapterTranslations,
  onRemoveChapters,
  onCreateStoryBranch,
  onUpdateStoryRoute,
  onReorderStoryRouteChapters,
  onMoveChapterToRoute,
  onRemoveStoryRoute,
  onImportChapterArchive,
  onDownloadExport,
  onResetProject,
  onAbortTaskActivity,
  onForceAbortTaskActivity,
  onRemoveTaskActivity,
  onResumeTaskActivity,
  onDismissTaskActivity,
}: WorkspaceViewProps) {
  const location = useLocation();
  const [activeTabKey, setActiveTabKey] = useState('dashboard');
  const prefetchedWorkspaceKeyRef = useRef<string | null>(null);
  const availableTabKeys = useMemo(
    () =>
      mobileMode
        ? ['dashboard', 'chapters']
        : ['dashboard', 'dictionary', 'chapters', 'workspace-config', 'consistency-analysis'],
    [mobileMode],
  );

  useEffect(() => {
    const tab = new URLSearchParams(location.search).get('tab');
    if (tab && availableTabKeys.includes(tab)) {
      setActiveTabKey(tab);
    }
  }, [availableTabKeys, location.search]);

  useEffect(() => {
    if (!availableTabKeys.includes(activeTabKey)) {
      setActiveTabKey(availableTabKeys[0] ?? 'dashboard');
    }
  }, [activeTabKey, availableTabKeys]);

  useEffect(() => {
    if (!snapshot) {
      prefetchedWorkspaceKeyRef.current = null;
      return;
    }

    if (prefetchedWorkspaceKeyRef.current === snapshot.projectName) {
      return;
    }

    prefetchedWorkspaceKeyRef.current = snapshot.projectName;
    void Promise.all(mobileMode ? [onRefreshChapters()] : [onRefreshChapters(), onRefreshTopology()]);
  }, [mobileMode, onRefreshChapters, onRefreshTopology, snapshot?.projectName]);

  if (!snapshot) {
    return (
      <Alert
        type="info"
        showIcon
        message="当前没有打开的工作区"
        description={
          mobileMode
            ? '移动端仅提供已打开工作区的进度查询、控制、日志与章节预览，请先在桌面端创建或打开项目。'
            : '请前往“创建工作区”或“最近工作区”页面创建 / 打开项目。'
        }
      />
    );
  }

  return (
    <div className="section-stack">
      <Tabs
        size="small"
        activeKey={activeTabKey}
        onChange={setActiveTabKey}
        items={[
          {
            key: 'dashboard',
            label: '项目总览',
            children: (
              <WorkspaceDashboardTab
                active={activeTabKey === 'dashboard'}
                sseConnected={sseConnected}
                snapshot={snapshot}
                projectStatus={projectStatus}
                pipelineStrategy={pipelineStrategy}
                mobileMode={mobileMode}
                onRefreshProjectStatus={onRefreshProjectStatus}
                onProjectCommand={onProjectCommand}
                onBuildContextNetwork={onBuildContextNetwork}
                onAbortTaskActivity={onAbortTaskActivity}
                onForceAbortTaskActivity={onForceAbortTaskActivity}
                onRemoveTaskActivity={onRemoveTaskActivity}
                onResumeTaskActivity={onResumeTaskActivity}
                onDismissTaskActivity={onDismissTaskActivity}
              />
            ),
          },
          {
            key: 'dictionary',
            label: '术语表',
            children: (
              <WorkspaceDictionaryTab
                active={activeTabKey === 'dictionary'}
                dictionary={dictionary}
                projectStatus={projectStatus}
                onRefreshProjectStatus={onRefreshProjectStatus}
                onRefreshDictionary={onRefreshDictionary}
                onProjectCommand={onProjectCommand}
                onAbortTaskActivity={onAbortTaskActivity}
                onForceAbortTaskActivity={onForceAbortTaskActivity}
                onRemoveTaskActivity={onRemoveTaskActivity}
                onResumeTaskActivity={onResumeTaskActivity}
                onOpenDictionaryEditor={onOpenDictionaryEditor}
                onDeleteDictionary={onDeleteDictionary}
                onImportDictionaryFromContent={onImportDictionaryFromContent}
                onDismissTaskActivity={onDismissTaskActivity}
              />
            ),
          },
          {
            key: 'chapters',
            label: mobileMode ? '章节预览' : '章节管理',
            children: (
              <WorkspaceChaptersTab
                active={activeTabKey === 'chapters'}
                mobileMode={mobileMode}
                chapters={chapters}
                topology={topology}
                defaultImportFormat={defaultImportFormat}
                onRefreshChapters={onRefreshChapters}
                onClearChapterTranslations={onClearChapterTranslations}
                onStartProofread={onStartProofread}
                onRemoveChapters={onRemoveChapters}
                onCreateStoryBranch={onCreateStoryBranch}
                onUpdateStoryRoute={onUpdateStoryRoute}
                onReorderStoryRouteChapters={onReorderStoryRouteChapters}
                onMoveChapterToRoute={onMoveChapterToRoute}
                onRemoveStoryRoute={onRemoveStoryRoute}
                onImportChapterArchive={onImportChapterArchive}
              />
            ),
          },
          {
            key: 'workspace-config',
            label: '工作区配置',
            children: (
              <WorkspaceConfigTab
                active={activeTabKey === 'workspace-config'}
                workspaceForm={workspaceForm}
                translatorOptions={translatorOptions}
                onRefreshWorkspaceConfig={onRefreshWorkspaceConfig}
                onWorkspaceConfigSave={onWorkspaceConfigSave}
                onDownloadExport={onDownloadExport}
                onResetProject={onResetProject}
              />
            ),
          },
          {
            key: 'consistency-analysis',
            label: '一致性分析',
            children: (
              <WorkspaceConsistencyTab
                active={activeTabKey === 'consistency-analysis'}
                repeatedPatterns={repeatedPatterns}
                chapters={chapters}
                topology={topology}
                llmProfileOptions={llmProfileOptions}
                defaultLlmProfileName={defaultLlmProfileName}
                onRefreshRepeatedPatterns={onRefreshRepeatedPatterns}
                onScanRepeatedPatterns={onScanRepeatedPatterns}
                onHydrateRepeatedPatterns={onHydrateRepeatedPatterns}
                onSaveRepeatedPatternTranslation={onSaveRepeatedPatternTranslation}
                onLoadRepeatedPatternContext={onLoadRepeatedPatternContext}
                onRefreshProjectStatus={onRefreshProjectStatus}
                onStartRepeatedPatternConsistencyFix={onStartRepeatedPatternConsistencyFix}
                onGetRepeatedPatternConsistencyFixStatus={onGetRepeatedPatternConsistencyFixStatus}
                onClearRepeatedPatternConsistencyFixStatus={onClearRepeatedPatternConsistencyFixStatus}
              />
            ),
          },
        ].filter((item) => !mobileMode || ['dashboard', 'chapters'].includes(item.key))}
      />
    </div>
  );
}
