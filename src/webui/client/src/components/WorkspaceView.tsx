import { Alert, Tabs } from 'antd';
import { WorkspaceChaptersTab } from './workspace-view/WorkspaceChaptersTab.tsx';
import { WorkspaceConfigTab } from './workspace-view/WorkspaceConfigTab.tsx';
import { WorkspaceDashboardTab } from './workspace-view/WorkspaceDashboardTab.tsx';
import { WorkspaceDictionaryTab } from './workspace-view/WorkspaceDictionaryTab.tsx';
import { WorkspaceHistoryTab } from './workspace-view/WorkspaceHistoryTab.tsx';
import type { WorkspaceViewProps } from './workspace-view/types.ts';

export type { ProjectCommand, TaskActivityKind } from './workspace-view/types.ts';

export function WorkspaceView({
  snapshot,
  projectStatus,
  dictionary,
  chapters,
  topology,
  logs,
  history,
  workspaceForm,
  defaultImportFormat,
  translatorOptions,
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
        defaultActiveKey="dashboard"
        items={[
          {
            key: 'dashboard',
            label: '项目总览',
            children: (
              <WorkspaceDashboardTab
                snapshot={snapshot}
                projectStatus={projectStatus}
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
                dictionary={dictionary}
                projectStatus={projectStatus}
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
                chapters={chapters}
                topology={topology}
                defaultImportFormat={defaultImportFormat}
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
                workspaceForm={workspaceForm}
                translatorOptions={translatorOptions}
                chapters={chapters}
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
                logs={logs}
                history={history}
                onClearLogs={onClearLogs}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
