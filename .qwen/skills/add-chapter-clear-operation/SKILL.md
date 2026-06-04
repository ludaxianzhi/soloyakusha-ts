---
name: add-chapter-clear-operation
description: 在翻译项目管理系统中添加章节级清除类操作（后端+前端全链路）
source: auto-skill
extracted_at: '2026-06-04T11:11:21.999Z'
---

# 添加章节级清除类操作

在翻译项目系统的章节管理中新增一个清除类功能按钮（如"清除评审结果"、"清空译文"等）时，遵循以下全链路实施模式。

## 后端链路（从存储到服务）

### 1. Document Manager 层 (`src/project/document/translation-document-manager.ts`)
新增批量操作方法，遍历章节的所有片段，修改内存中的对应字段，然后调用 `this.saveChapter(chapter)` 持久化。

```typescript
async clearChapterXxx(chapterIds: number[]): Promise<void> {
  const affectedIds = [...new Set(chapterIds)];
  for (const chapterId of affectedIds) {
    const chapter = this.getChapterById(chapterId);
    if (!chapter) continue;
    for (const fragment of chapter.fragments) {
      // 修改 fragment 的对应字段
      fragment.meta ??= { metadataList: [] };
      // ... 修改逻辑
    }
    await this.saveChapter(chapter);
  }
}
```

**关键注意**：`saveChapter` 最终调用 `replaceChapter`，该方法会 `DELETE` 并重新 `INSERT` fragment_lines。如果新增的字段在 `replaceChapter` 的 INSERT 语句中被硬编码为空值（例如当前的 `comment` 列），那么内存修改 + saveChapter 就足以完成清除。如果字段被正确持久化，则需要通过对应的更新方法（如 `updateFragmentLineComment`）或批量 SQL 操作。

### 2. TranslationProject 层 (`src/project/pipeline/translation-project.ts`)
封装 document manager 调用，确保初始化检查。

```typescript
async clearChapterXxx(chapterIds: number[]): Promise<void> {
  this.ensureInitialized();
  const normalizedChapterIds = [...new Set(chapterIds)];
  await this.documentManager.clearChapterXxx(normalizedChapterIds);
}
```

### 3. ProjectService 层 (`src/webui/services/project-service.ts`)
遵循 `runAction` 模式，包装业务逻辑、刷新快照、记录日志。

```typescript
async clearChapterXxx(chapterIds: number[]): Promise<void> {
  const { runtime, state, project } = this.getActiveWorkspaceContext();
  await this.runAction('操作名称', async () => {
    if (!project) throw new Error('当前没有已初始化的项目');
    await project.clearChapterXxx(chapterIds);
    this.refreshSnapshot(runtime ?? undefined);
    this.markChaptersChanged(state);
    this.log('success', `已清除 ${chapterIds.length} 个章节的xxx`);
  }, state);
}
```

### 4. IPC 路由 (`src/webui/routes/project.ts`)
新增 POST 端点。

```typescript
app.post('/chapters/clear-xxx', async (c) => {
  const body = await c.req.json<{ chapterIds: number[] }>();
  await projectService.clearChapterXxx(body.chapterIds);
  return c.json({ ok: true });
});
```

## 前端链路（从 API 到 UI）

### 5. API 层 (`src/webui/client/src/app/api.ts`)
按现有模式添加 API 函数。

```typescript
clearChapterXxx: (chapterIds: number[], workspaceId?: string) =>
  request(`/api/project/chapters/clear-xxx${buildWorkspaceQueryString(workspaceId)}`, {
    method: 'POST',
    body: { chapterIds },
  }),
```

### 6. App.tsx — 添加回调
新增 `handleClearChapterXxx`，使用 `runAction` + `refreshChapters()` + `refreshProjectStatus()` 模式。

**注意**：与清除译文不同，清除其他字段（如评论）通常不需要重建翻译队列，因此无需调用 `requeue` 相关逻辑。

### 7. 类型定义 (`src/webui/client/src/components/workspace-view/types.ts`)
在 `WorkspaceViewProps` 中添加新的回调属性。

### 8. WorkspaceView.tsx — 透传 prop
在 props 解构中增加新属性，并传递给 `<WorkspaceChaptersTab>`。

### 9. WorkspaceChaptersTab.tsx — 菜单按钮
需要在**两处**同时添加菜单项：
- **列表视图**：`ChapterTableSection` 组件的每行 Dropdown menu items
- **看板视图**：`ChapterKanbanBoard.tsx` → `KanbanColumn` → `KanbanCard` 的卡片菜单

菜单项位置参照现有"清空译文"按钮，在其**下方**添加新按钮。

确认对话框使用 `Modal.confirm`，附带 `content` 说明操作影响范围（如"译文不受影响"）以避免用户误操作。

### 10. ChapterKanbanBoard.tsx — 贯穿属性
需要更新 4 处：
- `ChapterKanbanBoardProps` 接口
- `ChapterKanbanBoard` 组件解构 + 传递到 `<KanbanColumn>`
- `KanbanColumnProps` 接口 + 传递到 `<KanbanCard>`
- `KanbanCardProps` 接口 + `useMemo` 依赖数组 + 菜单 items

## 关键注意事项

- **清理译文 vs 清理其他字段**：清除译文需要调用 `resetTranslationsAndRebuildQueues` 重建流水线队列；清除评论等非翻译字段只需要 document manager 操作，不需要重建队列。
- **`saveChapter` 的行为**：`replaceChapter` 方法会 DELETE 并重新 INSERT fragment_lines，其中 `comment` 列硬编码为 `""`。如果新增的字段在 `replaceChapter` 中未被正确持久化，则需要通过对应的逐行更新方法（如 `updateFragmentLineComment`）或修改 `replaceChapter` 的 INSERT 语句来正确保留数据。
- **按钮文本一致性**：建议使用「清除评审结果」这类明确的措辞，并在确认对话框中描述影响范围，避免用户混淆。
- **多视图同步**：列表和看板两个视图的菜单都需要添加对应按钮。
