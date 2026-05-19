# 预处理器 id 字段缺失问题

## 问题描述

预处理器步骤的 `id` 字段在表单保存时丢失，导致预处理在编辑器、翻译器、校对器等所有场景中都不生效。

### 表现形式

- 工作区配置中已配置预处理步骤（`preProcessors` 数组有内容）
- 数据库中的 `workspace_config` 字段已正常写入
- 但预处理开关开启后原文没有任何变化
- 翻译流水线、校对处理等同样不应用预处理

### 根因分析

问题根因在 `PreProcessPipelineBuilder` 组件的表单渲染中：

**`src/webui/client/src/components/workspace-view/PreProcessPipelineBuilder.tsx`**

```typescript
// renderParamField 只渲染了 params 下的子字段
<Form.Item
  name={[fieldPrefix, 'params', def.key]}  // → [0, 'params', 'matchRegex']
  ...
>
  <Input ... />
</Form.Item>
```

Ant Design 的 `Form.List` + `Form.Item` 机制：只有拥有对应 `Form.Item` 的字段才会被纳入 `form.getFieldsValue()` 的返回值。由于 `PreProcessPipelineBuilder` 没有为 `id` 字段渲染 `Form.Item`，该字段在表单提交时被静默丢弃。

**用户通过 Form.List 的 `add()` 初始化步骤时确实传入了 `id`：**

```typescript
add({
  id: 'text-replace',
  params: { matchRegex: '', replacement: '', filterRegex: '' },
})
```

但 Ant Design 只保留有 `Form.Item` 的字段，无对应 `Form.Item` 的 `id` 在表单取值时丢失。

**提交时 `App.tsx` 的保存处理：**

```typescript
const pp = values.preProcessors as Array<{ id: string; params: ... }> | undefined;
return pp ?? null;
```

此时 `pp` 中的每一项已丢失 `id`，只剩 `params`。

**该数据经 `updateWorkspaceConfig` 存入 SQLite，后续所有读取路径都拿到无 `id` 的数据。**

### 影响范围

缺失 `id` 的预处理步骤会在以下位置被静默跳过：

| 位置 | 代码 | 行为 |
|------|------|------|
| 客户端编辑器切换 | `clientSidePreProcess()` | `step.id !== 'text-replace'` 为 true，跳过 |
| 服务端构建流水线 | `TextPreProcessorRegistry.createPipeline()` | `registrations.find(r => r.id === step.id)` 找不到注册项 |
| 翻译/校对请求 | `applyPreProcessingToLines()` | 间接通过 `createPipeline`，同样跳过 |

### 相关文件

| 文件 | 作用 |
|------|------|
| `src/webui/client/src/components/workspace-view/PreProcessPipelineBuilder.tsx` | 表单渲染，缺少 `id` 字段的 Form.Item |
| `src/webui/client/src/app/App.tsx` | 表单提交处理，未补全 `id` |
| `src/webui/client/src/features/chapter-editor/chapter-editor-assistant.ts` | 客户端 `clientSidePreProcess`，缺少 `id` 容错 |
| `src/utils/text-pre-processor.ts` | 服务端 `createPipeline`，缺少 `id` 容错 |
| `src/webui/services/project-service.ts` | `validatePreProcessorSteps`，未校验 `id` 存在性 |

## 解决方案

### 方案一：表单保存时注入 id（已实施）

在 `App.tsx` 的 `onFinish` 处理器中，对提交的预处理步骤补全 `id`：

```typescript
const pp = values.preProcessors as Array<{ params: Record<string, unknown> }> | undefined;
const normalized = (pp ?? []).map((item) => ({
  id: 'text-replace',  // 补全 id
  params: item.params,
}));
```

优点：侵入性最小，不修改表单组件。  
缺点：硬编码了 `text-replace`，新增预处理器类型时需要同步修改。

### 方案二：容错处理（已实施）

在消费者端添加对缺失 `id` 的兼容：

**客户端 `clientSidePreProcess`：**
```typescript
// 原条件跳过所有无 id 的步骤
if (step.id && step.id !== 'text-replace') continue;
// 改为：只跳过明确指向其他类型的步骤，无 id 时默认 text-replace
```

**服务端 `TextPreProcessorRegistry.createPipeline`：**
```typescript
const effectiveId = step.id || 'text-replace';
```

### 方案三：修复表单组件（理想方案）

在 `PreProcessPipelineBuilder` 中添加隐藏的 `id` 字段：

```typescript
<Form.Item name={[fieldPrefix, 'id']} initialValue="text-replace" hidden>
  <Input type="hidden" />
</Form.Item>
```

这样 Ant Design 会正确追踪 `id` 字段。当前未采用此方案是因为保持对其他预处理器类型的可扩展性。

## 验证方法

1. 打开浏览器开发者工具（F12）
2. 在工作区设置中配置预处理步骤（如 `matchRegex: "て"`、`replacement: "111"`）
3. 保存配置
4. 打开章节编辑器
5. 开启"预处理"开关
6. 观察原文中包含 `て` 的行是否被替换为 `111`

## 预防措施

- 新增预处理器类型时，务必在表单组件中添加对应的 `Form.Item`
- 在 `validatePreProcessorSteps` 中增加对 `id` 字段的校验
- 消费者端始终保持对缺失字段的容错处理，作为最后一道防线
