import type { ScreenName } from './types.ts';

export interface ScreenDescriptor {
  title: string;
  subtitle: string;
  eyebrow: string;
  tone: 'cyan' | 'magenta' | 'green' | 'yellow' | 'blue';
  mdx: string;
}

export const screenDescriptors: Record<ScreenName, ScreenDescriptor> = {
  'main-menu': {
    eyebrow: 'HOME',
    title: 'SoloYakusha TUI',
    subtitle: '沉浸式控制台骨架，后续业务能力会逐步接入。',
    tone: 'cyan',
    mdx: String.raw`
## A better shell, before the real work

- 使用 **full-screen alternate screen** 独占终端
- 用 **MDX** 渲染说明、提示与空状态内容
- 保持 **键盘优先**，并为鼠标滚轮/点击预留支持

> 当前阶段只打磨 TUI 框架本身，业务动作仍保持占位。
`,
  },
  'workspace-menu': {
    eyebrow: 'WORKSPACE',
    title: '工作区流程',
    subtitle: '把工作区的创建、导入、配置与排序聚合在一个更清晰的入口里。',
    tone: 'green',
    mdx: String.raw`
## Workspace hub

这里会逐步承载工作区生命周期的主流程，包括：

- 创建或导入工程
- 检查配置完整性
- 调整章节顺序与任务状态
`,
  },
  'workspace-create': {
    eyebrow: 'WORKSPACE',
    title: '创建工作区',
    subtitle: '通过表单初始化新项目，或直接打开已经存在的工作区。',
    tone: 'green',
    mdx: String.raw`
## Create with confidence

现在这页已经承载真实初始化入口：

- 新建项目并初始化章节
- 打开已有工作区配置
- 为后续 TUI 项目控制台提供入口
`,
  },
  'workspace-progress': {
    eyebrow: 'PROGRESS',
    title: '项目主页',
    subtitle: '实时查看项目信息、翻译进度，并进入字典、日志和翻译控制功能。',
    tone: 'green',
    mdx: String.raw`
## Live project control

这里会持续展示：

- 当前项目生命周期状态
- 章节 / 文本块 / 步骤进度
- 开始、暂停、恢复、保存与中止动作
- 与项目控制相关的日志反馈
`,
  },
  'workspace-dictionary': {
    eyebrow: 'GLOSSARY',
    title: '字典编辑',
    subtitle: '浏览并编辑项目中的术语条目。',
    tone: 'yellow',
    mdx: String.raw`
## Glossary workspace

这里用于：

- 浏览术语条目及翻译状态
- 编辑术语、译文和说明
- 快速补充项目字典
`,
  },
  'workspace-history': {
    eyebrow: 'HISTORY',
    title: '历史日志',
    subtitle: '查看当前 TUI 事件日志，以及可用的 LLM 请求历史。',
    tone: 'blue',
    mdx: String.raw`
## History viewer

这里会展示：

- 当前会话内的项目事件日志
- 最近的 LLM 请求历史（如果存在）
- 便于排查的运行时间线
`,
  },
  'workspace-import': {
    eyebrow: 'IMPORT',
    title: '导入翻译文件',
    subtitle: '先把导入流程的界面引导和信息层次搭好。',
    tone: 'yellow',
    mdx: String.raw`
## Import staging

这一页会成为未来的导入向导：

- 识别输入路径
- 选择格式与编码
- 预览导入计划与校验结果
`,
  },
  'workspace-config': {
    eyebrow: 'CONFIG',
    title: '工作区配置',
    subtitle: '配置页先提供稳定、统一的表单体验。',
    tone: 'blue',
    mdx: String.raw`
## Config surface

此处目前聚焦于 **交互骨架**：

- 可读性更好的字段布局
- 一致的提交区域
- 明确的取消与返回反馈
`,
  },
  'workspace-sort': {
    eyebrow: 'SORT',
    title: '章节排序',
    subtitle: '通过更醒目的 grab 状态和动作提示，让排序交互更直观。',
    tone: 'magenta',
    mdx: String.raw`
## Reorder flow

排序列表已经预留：

- 抓取 / 放下状态
- 键盘排序操作
- 鼠标滚轮辅助浏览
`,
  },
  'settings-menu': {
    eyebrow: 'SETTINGS',
    title: '全局设置',
    subtitle: '把全局配置入口整理成更现代的导航界面。',
    tone: 'blue',
    mdx: String.raw`
## One place for preferences

这里会成为全局设置中心，后续将承载：

- LLM Profiles
- Translator presets
- CLI / TUI 行为偏好
`,
  },
  'settings-llm': {
    eyebrow: 'LLM',
    title: 'LLM 配置',
    subtitle: '当前优先打磨录入体验、状态提示与安全的编辑反馈。',
    tone: 'cyan',
    mdx: String.raw`
## Model profiles

在真正接入配置存储之前，这一页先验证：

- 字段层次是否清晰
- 敏感信息输入是否可扩展
- 保存动作是否易于理解
`,
  },
  'settings-translator': {
    eyebrow: 'TRANSLATOR',
    title: '翻译器配置',
    subtitle: '从类型选择到参数编辑，整个流程都使用统一的外观和节奏。',
    tone: 'magenta',
    mdx: String.raw`
## Configurable translators

这部分 UI 需要同时兼顾：

- 类型切换的可见性
- 参数表单的一致性
- 未来扩展更多翻译器的空间
`,
  },
  'workspace-plot-summary': {
    eyebrow: 'PLOT',
    title: '情节大纲总结',
    subtitle: '基于 LLM 自动生成情节大纲总结，支持多分线拓扑感知。',
    tone: 'magenta',
    mdx: String.raw`
## Plot summary generation

这里提供：

- 选择 LLM 预设开始生成情节大纲
- 按章节批量总结，实时显示进度
- 总结结果独立保存，不影响翻译文件
`,
  },
};
