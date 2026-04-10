import { useState } from 'react';
import { Alert, Tabs } from 'antd';
import { WorkspaceChaptersTab } from './workspace-view/WorkspaceChaptersTab.tsx';
import { WorkspaceConfigTab } from './workspace-view/WorkspaceConfigTab.tsx';
import { WorkspaceConsistencyTab } from './workspace-view/WorkspaceConsistencyTab.tsx';
import { WorkspaceDashboardTab } from './workspace-view/WorkspaceDashboardTab.tsx';
import { WorkspaceDictionaryTab } from './workspace-view/WorkspaceDictionaryTab.tsx';
import { WorkspaceHistoryTab } from './workspace-view/WorkspaceHistoryTab.tsx';
import type { WorkspaceViewProps } from './workspace-view/types.ts';

export type { ProjectCommand, TaskActivityKind } from './workspace-view/types.ts';

export function WorkspaceView({
  snapshot,
  projectStatus,
  sseConnected,
  dictionary,
  repeatedPatterns,
  chapters,
  topology,
  workspaceForm,
  defaultImportFormat,
  translatorOptions,
  onRefreshProjectStatus,
  onRefreshDictionary,
  onRefreshRepeatedPatterns,
  onSaveRepeatedPatternTranslation,
  onLoadRepeatedPatternContext,
  onRefreshChapters,
  onRefreshTopology,
  onRefreshWorkspaceConfig,
  onProjectCommand,
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
  onClearLogs,
  onDismissTaskActivity,
}: WorkspaceViewProps) {
  const [activeTabKey, setActiveTabKey] = useState('dashboard');

  if (!snapshot) {
    return (
      <Alert
        type="info"
        showIcon
        message="当前没有打开的工作区"
        description="请前往“创建工作区”或“最近工作区”页面创建 / 打开项目。"
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
                onRefreshProjectStatus={onRefreshProjectStatus}
                onProjectCommand={onProjectCommand}
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
                onOpenDictionaryEditor={onOpenDictionaryEditor}
                onDeleteDictionary={onDeleteDictionary}
                onImportDictionaryFromContent={onImportDictionaryFromContent}
                onDismissTaskActivity={onDismissTaskActivity}
              />
            ),
          },
          {
            key: 'chapters',
            label: '章节管理',
            children: (
              <WorkspaceChaptersTab
                active={activeTabKey === 'chapters'}
                chapters={chapters}
                topology={topology}
                defaultImportFormat={defaultImportFormat}
                onRefreshChapters={onRefreshChapters}
                onRefreshTopology={onRefreshTopology}
                onClearChapterTranslations={onClearChapterTranslations}
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
                chapters={chapters}
                onRefreshWorkspaceConfig={onRefreshWorkspaceConfig}
                onRefreshPreviewChapters={onRefreshChapters}
                onWorkspaceConfigSave={onWorkspaceConfigSave}
                onDownloadExport={onDownloadExport}
                onResetProject={onResetProject}
              />
            ),
          },
          {
            key: 'history',
            label: '历史与日志',
            children: (
              <WorkspaceHistoryTab
                active={activeTabKey === 'history'}
                workspaceKey={snapshot.projectName}
                onClearLogs={onClearLogs}
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
                onRefreshRepeatedPatterns={onRefreshRepeatedPatterns}
                onSaveRepeatedPatternTranslation={onSaveRepeatedPatternTranslation}
                onLoadRepeatedPatternContext={onLoadRepeatedPatternContext}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
