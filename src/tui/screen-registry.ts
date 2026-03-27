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
    subtitle: '先完善表单体验和视觉反馈，再接入真正的项目创建逻辑。',
    tone: 'green',
    mdx: String.raw`
## Create with confidence

表单区现在强调：

- 清晰的焦点态
- 更完整的字段说明
- 更稳定的提交/取消交互
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
};
