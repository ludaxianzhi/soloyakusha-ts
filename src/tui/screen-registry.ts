import type { ScreenName } from './types.ts';

export interface ScreenDescriptor {
  title: string;
  subtitle: string;
  eyebrow: string;
  tone: 'cyan' | 'magenta' | 'green' | 'yellow' | 'blue';
}

export const screenDescriptors: Record<ScreenName, ScreenDescriptor> = {
  'main-menu': {
    eyebrow: 'HOME',
    title: 'SoloYakusha TUI',
    subtitle: '沉浸式控制台骨架',
    tone: 'cyan',
  },
  'workspace-menu': {
    eyebrow: 'WORKSPACE',
    title: '工作区流程',
    subtitle: '工作区生命周期管理',
    tone: 'green',
  },
  'workspace-create': {
    eyebrow: 'WORKSPACE',
    title: '创建工作区',
    subtitle: '初始化新项目或打开已有工作区',
    tone: 'green',
  },
  'workspace-progress': {
    eyebrow: 'PROGRESS',
    title: '项目主页',
    subtitle: '实时查看翻译进度与项目控制',
    tone: 'green',
  },
  'workspace-dictionary': {
    eyebrow: 'GLOSSARY',
    title: '字典编辑',
    subtitle: '浏览并编辑术语条目',
    tone: 'yellow',
  },
  'workspace-history': {
    eyebrow: 'HISTORY',
    title: '历史日志',
    subtitle: '事件日志与 LLM 请求历史',
    tone: 'blue',
  },
  'workspace-import': {
    eyebrow: 'IMPORT',
    title: '导入翻译文件',
    subtitle: '导入向导',
    tone: 'yellow',
  },
  'workspace-export': {
    eyebrow: 'EXPORT',
    title: '导出翻译文件',
    subtitle: '批量导出已翻译章节',
    tone: 'green',
  },
  'workspace-config': {
    eyebrow: 'CONFIG',
    title: '工作区配置',
    subtitle: '编辑工作区参数',
    tone: 'blue',
  },
  'workspace-sort': {
    eyebrow: 'SORT',
    title: '章节排序',
    subtitle: '调整章节顺序',
    tone: 'magenta',
  },
  'settings-menu': {
    eyebrow: 'SETTINGS',
    title: '全局设置',
    subtitle: '全局配置中心',
    tone: 'blue',
  },
  'settings-llm': {
    eyebrow: 'LLM',
    title: 'LLM 配置',
    subtitle: '模型配置管理',
    tone: 'cyan',
  },
  'settings-translator': {
    eyebrow: 'TRANSLATOR',
    title: '翻译器配置',
    subtitle: '翻译处理器参数',
    tone: 'magenta',
  },
  'workspace-plot-summary': {
    eyebrow: 'PLOT',
    title: '情节大纲总结',
    subtitle: 'LLM 自动生成情节大纲',
    tone: 'magenta',
  },
};
