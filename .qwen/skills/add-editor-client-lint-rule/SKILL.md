---
name: add-editor-client-lint-rule
description: 在 ChapterTranslationEditorPage 的 CodeMirror 编辑器中新增客户端侧 lint 诊断规则（自定义正则/逻辑 + 黄色或红色波浪线标注）
source: auto-skill
extracted_at: '2026-06-04T11:53:27.098Z'
---

# 在章节翻译编辑器中新增客户端 lint 诊断规则

当需要在 `ChapterTranslationEditorPage.tsx` 的 CodeMirror 编辑器中添加**客户端侧**的检测规则（如夹生文本检测、格式校验等），遵循以下模式。

## 整体架构

```
后端 diagnostics (API 校验) ─┐
                              ├── mergedLintDiagnostics ──→ linter() ──→ 编辑器波浪线 + lint gutter
客户端 garbledDiagnostics ───┘
```

客户端诊断只出现在编辑器中（波浪线 + hover 提示 + 边栏 lint gutter），不会出现在下方的"校验结果"卡片列表中。

## 实施步骤

### 1. 创建诊断生成函数

仿照 `buildCommentLineDecorations` 同级位置添加独立的 `buildXxxDiagnostics` 函数：

```typescript
function buildXxxDiagnostics(
  content: string,
  format: EditableTranslationFormat,
): Array<{ from: number; to: number; severity: 'warning' | 'error'; message: string }> {
  const lines = classifyEditorLines(content, format);
  const result: Array<{ from: number; to: number; severity: 'warning' | 'error'; message: string }> = [];

  for (const line of lines) {
    // 只检查译文行（target）—— 源文行（source）不应被检测
    if (line.kind !== 'target') continue;

    const body = line.body;

    // 使用正则遍历行体，记录匹配位置
    const re = /你的正则/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(body)) !== null) {
      result.push({
        from: line.bodyFrom + match.index,
        to: line.bodyFrom + match.index + match[0].length,
        severity: 'warning',   // warning = 黄色波浪线, error = 红色波浪线
        message: 'hover 提示文本',
      });
    }
  }

  return result;
}
```

关键字段：
- `from` / `to`：绝对文档偏移（文档起始到字符的距离），必须加上 `line.bodyFrom` 偏移量。
- `severity`：`'warning'` → 黄色波浪线；`'error'` → 红色波浪线。

### 2. 添加 useMemo + 合并

在组件中 `commentLineDecorations` useMemo 之后添加：

```typescript
const garbledDiagnostics = useMemo(
  () => buildXxxDiagnostics(content, format),
  [content, format],
);

const mergedLintDiagnostics = useMemo(
  () => [
    ...diagnostics.map((d) => ({
      from: d.from,
      to: d.to,
      severity: d.severity as 'error' | 'warning',
      message: d.message,
    })),
    ...garbledDiagnostics,
  ],
  [diagnostics, garbledDiagnostics],
);
```

### 3. 更新 linter 使用合并数组

在 `editorExtensions` useMemo 中替换原始的 linter 调用：

```typescript
// 修改前：
linter(() =>
  diagnostics.map((diagnostic) => ({
    from: diagnostic.from,
    to: diagnostic.to,
    severity: diagnostic.severity,
    message: diagnostic.message,
  })),
),

// 修改后：
linter(() => mergedLintDiagnostics),
```

同时更新依赖数组，将 `diagnostics` 替换为 `mergedLintDiagnostics`。

## 常用模式

### 模式 A：基于 `classifyEditorLines` 的逐行检查

利用现有的 `classifyEditorLines` 解析内容格式后，可以：
- 只检查 `target` 行（译文）
- 只检查 `source` 行（源文）
- 根据行类型应用不同规则

### 模式 B：基于 regex 的检测

对 `line.body`（去掉行前缀标记后的纯文本）应用正则。

注意：`line.bodyFrom` 是 body 内容在文档中的起始偏移，检测到的 `match.index` 需要加上此偏移。

### 模式 C：非 CJK 字符检测（使用 negated 字符类）

对于"检测所有非预期字符"的场景，使用 negated 字符类 `[^允许范围]+`：

```typescript
// 允许范围：ASCII、CJK 统一表意文字、CJK 标点等
const suspiciousRe = /[^\u0000-\u007F\u00A0-\u00FF\u2000-\u206F\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\uD800-\uDFFF]+/g;
```

如需避免与另一条规则重复检测同一字符（如避免与 kanaRe 同时匹配假名字符），将对应范围也加入允许列表。

## 已知约束

- 客户端诊断**不**出现在下方的"校验结果"卡片中（`diagnostics` 状态仅存储服务端诊断）。这是有意为之：客户端诊断是实时轻量的，服务端诊断是持久校验的。
- 标签栏中的 `errorCount` / `warningCount` 默认只统计服务端诊断。如需将客户端诊断也纳入计数，需额外计算。
- `classifyEditorLines` 依赖 `EditableTranslationFormat`（`'naturedialog'` 或 `'m3t'`），不同格式的行分类逻辑不同。
