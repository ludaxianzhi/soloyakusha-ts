---
name: codemirror-scrollbar-and-extensions
description: CodeMirror 编辑器的外层滚动容器方案 + 自定义滚动条标记 + 防扩展重建导致滚动丢失
source: auto-skill
extracted_at: '2026-06-04T14:09:57.405Z'
---

当 CodeMirror 编辑器的内部 `.cm-scroller` 滚动不可用（如 minimap 插件干扰、CSS 高度链断裂、`overflow: hidden` 父容器裁剪滚动条）时，改用外层容器托管滚动：

## 1. 外层滚动容器方案

替换 `height="100%"` 的紧缩模式为容器包裹 + CodeMirror 自然撑开：

```tsx
// 组件中
<div className="cm-editor-scroll-container">
  <CodeMirror
    value={content}
    // 移除 height prop → CodeMirror 自然撑开到内容高度
    basicSetup={{ ... }}
    extensions={editorExtensions}
    ...
  />
</div>
```

```css
.cm-editor-scroll-container {
  height: 100%;
  overflow: auto;          /* 外层容器接管滚动 */
  position: relative;
}
.cm-editor-scroll-container .cm-editor {
  min-height: 100%;        /* 内容不足时仍填满容器 */
}
.cm-editor-scroll-container .cm-scroller {
  overflow: visible !important;  /* 禁用 CodeMirror 内部滚动 */
  min-height: 0;
}
```

**原理**：`.cm-theme-light`（`@uiw/react-codemirror` 的 wrapper）在 shell 和 editor 之间插了一层，其没有显式高度，导致 `height: 100%` 链断裂。改用外部容器控制高度 + 内部自然撑开，避免任何中间层的高度约束传递。需确认 `.cm-theme-light` 及其祖先无 `overflow: hidden` 裁剪滚动条。

## 2. 自定义滚动条诊断标记（Warning/Error 指示器）

**不要用 `ViewPlugin`**。从 `@codemirror/lint` 导入 `forEachDiagnostic`、`setDiagnosticsEffect`，或从 `@codemirror/view` 导入 `ViewUpdate`，会在 Vite 打包时引发模块级 Temporal Dead Zone 错误（`Cannot access 'at' before initialization`），因为 `@codemirror/lint` 内部模块之间有循环依赖。

**正确方案**：在 React 组件中用 `useEffect` 管理标记：

```tsx
// 在组件中
useEffect(() => {
  const shell = editorShellRef.current;
  // 清理旧的 overlay
  const existing = document.querySelector('.cm-scrollbar-diagnostic-markers');
  existing?.remove();

  if (!shell || !mergedLintDiagnostics.length) return;

  const scrollContainer = shell.querySelector('.cm-editor-scroll-container');
  if (!scrollContainer) return;
  const { clientHeight, scrollHeight } = scrollContainer;
  if (clientHeight <= 0 || scrollHeight <= clientHeight) return;

  const overlay = document.createElement('div');
  overlay.className = 'cm-scrollbar-diagnostic-markers';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.height = clientHeight + 'px';
  shell.appendChild(overlay);

  const markers: Array<{ ratio: number; color: string }> = [];
  for (const d of mergedLintDiagnostics) {
    // content.length 近似文档长度
    const ratio = content.length > 0 ? d.from / content.length : 0;
    markers.push({ ratio: Math.min(1, Math.max(0, ratio)), color: d.severity === 'error' ? '#ff4d4f' : '#faad14' });
  }

  const minGapPx = 3;
  markers.sort((a, b) => a.ratio - b.ratio);
  let lastPx = -Infinity;
  for (const m of markers) {
    const idealPx = m.ratio * clientHeight;
    const top = idealPx - lastPx < minGapPx ? lastPx + minGapPx : idealPx;
    if (top >= clientHeight) break;
    lastPx = top;
    const el = document.createElement('div');
    el.className = 'cm-scrollbar-diagnostic-marker';
    el.style.top = top + 'px';
    el.style.backgroundColor = m.color;
    overlay.appendChild(el);
  }
}, [mergedLintDiagnostics, content]);
```

```css
.cm-scrollbar-diagnostic-markers {
  position: absolute;   /* 相对于 shell 定位，不随内容滚动 */
  top: 0;
  right: 0;
  width: 14px;          /* 覆盖浏览器原生滚动条宽度 */
  pointer-events: none; /* 不拦截滚动事件 */
  z-index: 10;
}
.cm-scrollbar-diagnostic-marker {
  position: absolute;
  width: 100%;
  height: 2px;
  left: 0;
  opacity: 0.85;
}
```

**关键**：overlay 必须挂载到**不滚动的父容器**（shell，有 `overflow: hidden`），而非滚动容器内部。`position: absolute` 相对于 shell 固定，scrollbar markers 始终与原生滚动条对齐。挂载到滚动容器内则 markers 会随内容滚动而错位。

## 3. 诊断变化导致扩展重建 → 滚动丢失

`editorExtensions` 的 `useMemo` 中 `linter(() => mergedLintDiagnostics)` 直接使用诊断数据。当 `mergedLintDiagnostics` 作为 useMemo 依赖时，每次诊断变化（如保存后 `setDiagnostics([])`）都会重建 extensions 数组，触发 `@uiw/react-codemirror` 重新配置编辑器 → 外层滚动容器 `scrollTop` 被重置。

**不要用 ViewPlugin 或 ref 绕路**——这些方法引发了 module-level TDZ 错误。实际可行的方案：

### 3.1 诊断标记交给 useEffect

将 `mergedLintDiagnostics` 放回 `useMemo` 依赖，让 extensions 在诊断变化时重建（接受短暂的滚动重置）。scrollbar markers 用 `useEffect` 独立管理（见第 2 节），不依赖 ViewPlugin。

### 3.2 保存操作时恢复滚动

Ctrl+S（`handleApply`）后虽然 `setDiagnostics([])` 导致 extensions 重建，但此时 `content` 不变，所以 `useLayoutEffect([content])` 不触发。需要用 `requestAnimationFrame` 在下一个渲染帧中恢复：

```tsx
// 在 handleApply 最后（setDirty/setDiagnostics 调用之后）：
requestAnimationFrame(() => {
  const scrollContainer = document.querySelector('.cm-editor-scroll-container');
  if (scrollContainer) {
    scrollContainer.scrollTop = pendingEditorScrollRef.current?.top ?? 0;
    scrollContainer.scrollLeft = pendingEditorScrollRef.current?.left ?? 0;
  }
  pendingEditorScrollRef.current = null;
});
```

### 3.3 避免额外导入

永远不要在 `@codemirror/lint` 中添加 `forEachDiagnostic`、`setDiagnosticsEffect` 等额外导入，也不要从 `@codemirror/view` 添加 `ViewPlugin`、`ViewUpdate`。这些导入在同一模块中组合时会导致 Vite 打包时的 TDZ 错误 (`Cannot access 'at' before initialization`)。只保留 `lintGutter` 和 `linter` 两个导入。

## 4. 滚动位置恢复（content 变更时）

当 `loadDraft` 等操作通过 `setContent` 改变内容时，在外层容器上保存/恢复滚动：

```tsx
const pendingEditorScrollRef = useRef<{ top: number; left: number } | null>(null);

// 在 setContent 前保存
const prevScrollContainer = document.querySelector('.cm-editor-scroll-container');
if (prevScrollContainer) {
  pendingEditorScrollRef.current = {
    top: prevScrollContainer.scrollTop,
    left: prevScrollContainer.scrollLeft,
  };
}

// 用 useLayoutEffect 在 content 变更后恢复（DOM 已更新，滚动尚未发生）
useLayoutEffect(() => {
  const scrollPosition = pendingEditorScrollRef.current;
  if (!scrollPosition) return;
  const scrollContainer = document.querySelector('.cm-editor-scroll-container') as HTMLElement | null;
  if (!scrollContainer) return;
  scrollContainer.scrollTop = scrollPosition.top;
  scrollContainer.scrollLeft = scrollPosition.left;
  pendingEditorScrollRef.current = null;
}, [content]);
```
