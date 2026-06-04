---
name: optimize-editor-page-layout
description: CodeMirror 编辑器页面布局：外层容器滚动方案、滚动条诊断标记、flex 高度链修复
source: auto-skill
extracted_at: '2026-06-04T13:41:25.150Z'
---

# 优化编辑器页面布局：页滚转编辑器内滚 + 控件集成

当 `ChapterTranslationEditorPage.tsx`（或其他类似 CodeMirror + Ant Card 页面）存在以下问题时使用此模式：
- 页面整体滚动，编辑器未充分利用窗口高度
- 提示性 Alert / Typography 占用编辑空间
- 控件（Select、Tag、Switch）分散在 body 中，未集中在顶端

## 步骤 1：移除干扰性提示区块

删除 `<Alert type="info">`（如"这是独立编辑模块"）和 `<Typography.Text type="secondary">`（如"提示：Ctrl+S..."）等非关键说明文字。这些信息可以用更简洁的方式存在，或者用户已经熟悉。

## 步骤 2：将全部控件合并到 Card extra

将以下内容从 Card body 移到 `extra` 属性：

```
extra={
  <Space wrap size={[4, 4]}>
    {/* Select controls first（用户最常操作的） */}
    <Select ...章节 />
    <Select ...格式 />
    <Select ...模型 />
    {/* 操作按钮 */}
    <Button>返回</Button>
    <Button>重新生成</Button>
    <Button>校验</Button>
    <Button type="primary">提交</Button>
    {/* 状态标签 */}
    <Tag ... />
    <Tag ... />
    <Switch 预处理 />
  </Space>
}
```

关键点：
- 使用 `Space wrap` 而非 `Space`，确保在窗口缩窄时自动换行
- 设置 `size={[4, 4]}` 紧凑间距
- 最频繁使用的 Select 放在最前

## 步骤 3：构建 flex 布局实现编辑器内滚动

### JSX 结构

Card body 中移除 `<Space direction="vertical">` 包装器，替换为 flex 容器：

```tsx
<Card title="..." className="chapter-editor-page-card" extra={...}>
  {/* 错误/加载/空状态保持原有逻辑 */}
  {errorMessage ? <Alert ... /> : null}

  {loading ? <Spin /> : !selectedChapterId ? <Empty /> : draft ? (
    <div className="chapter-editor-page-body">
      {/* 可选的基线信息标签行（flex-shrink: 0，不伸缩） */}
      <Space wrap size={[8, 8]}>
        <Tag>基线单元</Tag>
        <Tag>基线行数</Tag>
      </Space>

      {/* 编辑器主体（flex: 1，占满剩余空间，内部 .cm-scroller 滚动） */}
      <div className="chapter-editor-shell" ref={editorShellRef}>
        <CodeMirror value={content} height="100%" ... />
      </div>

      {/* 校验结果卡片（flex-shrink: 0，固定在底部） */}
      <Card size="small" title="校验结果">...</Card>
    </div>
  ) : null}

  {/* Modal 保持在 Card 内（使用 portal 渲染，位置不受布局影响） */}
  <Modal ...>...</Modal>
</Card>
```

### CSS 链

```css
/* 页面容器占满父高度 */
.section-stack {
  height: 100%;
}

/* Card 本身 flex 占满，overflow hidden */
.chapter-editor-page-card {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* Card body 继承 flex 布局 */
.chapter-editor-page-card > .ant-card-body {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* body 内部的滚动容器 */
.chapter-editor-page-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  gap: 10px;
}

/* 编辑器外壳 flex 占满剩余空间 */
.chapter-editor-shell {
  flex: 1;
  overflow: hidden;
}

/* cm-editor 填满外壳（移除 min-height，由 flex 决定高度） */
.chapter-editor-shell .cm-editor {
  height: 100%;
}
```

同时移除 `EditorView.theme` 中的 `minHeight: '62vh'`（如果存在）：

```typescript
// EditorView.theme 中的 & 块
'&': {
  fontSize: '14px',
  backgroundColor: 'var(--editor-bg)',
  color: 'var(--editor-text)',
  // 删除 minHeight: '62vh',
},
```

## 步骤 4（可选）：在滚动条上添加诊断标记（替代 minimap）

> **不推荐使用 `@replit/codemirror-minimap`**：该库的内置 Theme 在 `.cm-editor` 上设置 `overflow-y: auto`，与 `.cm-scroller` 产生滚动容器冲突，导致滚轮失效、滚动条缺失。`overflow: hidden !important` 覆盖方案在部分场景下无效。推荐使用滚动条标记替代。

在 `editorExtensions` 数组中添加自定义 `ViewPlugin`：

```typescript
import { forEachDiagnostic, setDiagnosticsEffect } from '@codemirror/lint';
import { ViewPlugin, type ViewUpdate } from '@codemirror/view';

const scrollbarDiagnosticMarkers = ViewPlugin.fromClass(
  class {
    overlay: HTMLDivElement;
    markers: HTMLDivElement[] = [];

    constructor(view: EditorView) {
      this.overlay = document.createElement('div');
      this.overlay.className = 'cm-scrollbar-diagnostic-markers';
      this.overlay.setAttribute('aria-hidden', 'true');
      view.dom.appendChild(this.overlay);
      this.render(view);
    }

    update(update: ViewUpdate) {
      if (update.geometryChanged || update.viewportChanged) {
        this.render(update.view);
        return;
      }
      for (const tr of update.transactions) {
        if (tr.effects.some((e) => e.is(setDiagnosticsEffect)) || tr.docChanged) {
          this.render(update.view);
          return;
        }
      }
    }

    render(view: EditorView) {
      const { scrollDOM } = view;
      const { scrollHeight, clientHeight } = scrollDOM;
      if (clientHeight <= 0 || scrollHeight <= clientHeight) {
        this.clearMarkers();
        return;
      }

      const markers: Array<{ ratio: number; color: string }> = [];
      forEachDiagnostic(view.state, (d) => {
        const line = view.state.doc.lineAt(d.from);
        const ratio = line.from / (scrollHeight - clientHeight);
        markers.push({
          ratio: Math.min(1, Math.max(0, ratio)),
          color: d.severity === 'error' ? '#ff4d4f' : '#faad14',
        });
      });

      const minGapPx = 3;
      markers.sort((a, b) => a.ratio - b.ratio);

      if (this.overlay.parentElement !== scrollDOM) {
        scrollDOM.appendChild(this.overlay);
      }

      this.clearMarkers();
      this.overlay.style.height = clientHeight + 'px';

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
        this.overlay.appendChild(el);
        this.markers.push(el);
      }
    }

    clearMarkers() {
      for (const el of this.markers) el.remove();
      this.markers = [];
    }

    destroy() {
      this.overlay.remove();
    }
  },
);
```

在 `editorExtensions` 数组中添加：

```typescript
scrollbarDiagnosticMarkers,
```

配套 CSS（放在 `.chapter-editor-shell .cm-scroller` 规则之后）：

```css
.chapter-editor-shell .cm-scroller {
  font-family: var(--font-family);
  overflow: auto !important;
  position: relative;   /* ← 为 overlay 定位提供参照 */
}

.cm-scrollbar-diagnostic-markers {
  position: absolute;
  top: 0;
  right: 0;
  width: 14px;           /* 覆盖滚动条宽度 */
  pointer-events: none;
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

### 工作原理

- `forEachDiagnostic` 读取 linter StateField 中的所有诊断（包含后端 + 客户端 garbled 检测）
- 每个诊断的 `from` 位置映射为 `scrollTop / (scrollHeight - clientHeight)` 比率，再乘以 `clientHeight` 得到像素偏移
- overlay 挂载在 `.cm-scroller` 上（`position: absolute`），随 scroller 滚动但标记位置固定
- `minGapPx = 3` 防止相邻标记重叠
- 监听 `setDiagnosticsEffect`、`docChanged`、`geometryChanged`、`viewportChanged` 自动刷新

## 注意事项

- **flex 链完整性**：从 `.section-stack` 到 `.chapter-editor-page-body` 的每一层都需要正确设置 `flex: 1` 和 `overflow: hidden`，缺少任何一层都会导致布局断裂。
- **`.ant-card-body` 的 flex 覆盖**：Ant Design 的 Card body 默认是普通块级元素，必须额外用 CSS 指定 `flex: 1; display: flex; flex-direction: column; overflow: hidden;`。
- **Modal 不受影响**：Modal 使用 React Portal 渲染到 `document.body`，其在 Card body 中的 DOM 位置不影响视觉表现。
- **空状态处理**：当没有草稿时（`draft === null`），不应渲染 `.chapter-editor-page-body`，否则会产生空的 flex 空间。
- **`.chapter-editor-toolbar` 清理**：将控件移出 body 后，原来的 `.chapter-editor-toolbar` 类名在 JSX 中不再使用，可以安全删除对应的 CSS 规则以避免死代码。

## 常见问题：编辑器不滚动（滚轮失效 + 缩略图异常）

### 现象
- CodeMirror 编辑器无法用鼠标滚轮滚动
- 缩略图（minimap）与代码区以相同高度同步滚动，而非按比例缩放

### 根因

有两种独立的根因可能单独或同时出现：

**根因 A：flex 高度链断裂**
flex 高度链未正确地传递「确定高度」，导致 `.cm-editor` 的计算高度等于内容高度（无溢出），`.cm-scroller` 无需触发滚动。缩略图的缩放比例也因此计算为 1:1。

**根因 B：`@replit/codemirror-minimap` 的 Theme 在 `.cm-editor` 上设置 `overflow-y: auto`**
minimap 库的内置 Theme 会给 `.cm-editor`（即 `&` 选择器）设置 `overflow-y: auto`，使 `.cm-editor` 本身成为滚动容器。这与 `.cm-scroller` 的 `overflow: auto` 产生冲突，导致：
- 鼠标滚轮事件被 `.cm-editor` 捕获而非 `.cm-scroller` → 滚动条缺失、滚轮不工作
- minimap 的 scroll 事件处理器挂在 `.cm-scroller` 上，但实际滚动发生在 `.cm-editor` → minimap 滚动同步失效，缩略图以 1:1 速度跟随而非按比例

### 修复步骤

#### 0. 移除 `@replit/codemirror-minimap`（根因 B）

> **`overflow: hidden !important` 覆盖方案在部分场景下无效**，推荐直接移除 minimap，改用滚动条诊断标记（见步骤 4）。

```bash
# 移除 import 和 showMinimap.of(...) 配置
# 不需要 bun remove，只需删除代码引用
```

在组件代码中：
1. 删除 `import { showMinimap } from '@replit/codemirror-minimap';`
2. 从 `editorExtensions` 数组中删除 `showMinimap.of({...})`
3. 如果之前添加了 `overflow: 'hidden !important'`，也一并移除（不再需要）

#### 1. 确保每一层 flex 子项都有 `min-height: 0`

flex 子项默认 `min-height: auto`，这意味着它们不会收缩到内容高度以下。当内容很高时，flex 子项的最终高度 >= 内容高度 → 父容器无法约束 → 编辑器得不到确定高度。

```css
.chapter-editor-page-card > .ant-card-body {
  flex: 1;
  min-height: 0;          /* ← 关键 */
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.chapter-editor-page-body {
  flex: 1;
  min-height: 0;          /* ← 关键 */
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.chapter-editor-shell {
  flex: 1;
  min-height: 0;          /* ← 关键 */
  overflow: hidden;
}
```

#### 2. 确保父容器（`.ant-layout-content`）有确定高度

章节翻译编辑器页面位于 **React Router Route** 下，直接渲染在 `Layout.Content` 内（而非在 `WorkspaceView` 的 TabPane 内）。作为 Route 的直接子元素，`.section-stack` 的父容器是 `Content`。

**方案 A**（推荐）：用 `body:has()` 选择器仅在编辑器页面使 Content 变为 flex 容器：

```css
body:has(.chapter-editor-page-card) .ant-layout-content {
  display: flex;
  flex-direction: column;
}
body:has(.chapter-editor-page-card) .section-stack {
  flex: 1;
  min-height: 0;
  height: auto;
  overflow: hidden;
}
```

这样 `.section-stack` 通过 `flex: 1` 获得 Content 的剩余空间作为确定高度，而非依赖 `height: 100%` 的百分比链。

**为什么不能用 `height: 100%`**：当编辑器通过 Route 直接渲染时，父 `Content` 有 `flex: auto` 和 `min-height: 0`（来自 Ant Design），但 `height` 不是显式固定的百分比值。`height: 100%` 在大部分现代浏览器中对 flex 父级是有效的，但如果中间有其他非 flex 包装元素（如 Suspense、Routes），`height: 100%` 的百分比链可能断裂。

**方案 B**（备选）：使用 `100vh` 减去已知的页面外壳高度：

```css
.chapter-editor-page-body {
  max-height: calc(100vh - 180px); /* header + padding + card header + tags */
}
```

此方案脆弱，不推荐用于长期维护。

#### 3. 确保 `.cm-scroller` 有 `overflow: auto`

CodeMirror 6 默认 `overflow: auto`，但某些情况下可能被 CSS 覆盖或计算为 `overflow: visible`：

```css
.chapter-editor-shell .cm-scroller {
  overflow: auto !important;
}
```

#### 4. 移除干扰性的固定最小高度

如果有 `min-height: 62vh` 等固定高度设定，移除它让高度完全由 flex 布局决定：

```typescript
// EditorView.theme
'&': {
  fontSize: '14px',
  // 删除 minHeight: '62vh',
},
```

同时：

```css
/* 删除或替换 */
.chapter-editor-shell .cm-editor {
  height: 100%;   /* 替代 min-height */
}
```

### 验证方法

在浏览器 DevTools 中检查 `.cm-editor` 的计算高度和 `.cm-scroller` 的 `scrollHeight`：
- `.cm-editor` 的高度应远小于其内容（文档行数越多差异越明显）
- `.cm-scroller` 的 `overflow` 应为 `auto`
- 确认 `@replit/codemirror-minimap` 的 import 和 `showMinimap.of(...)` 已完全移除
- 如果使用了滚动条诊断标记，确认 `.cm-scrollbar-diagnostic-markers` overlay 出现在 `.cm-scroller` 内部

如果问题仍然存在，检查渲染的 DOM 层级，确认 `:has()` 选择器是否命中（DevTools 中确认 `body` 下有 `.chapter-editor-page-card`）。
