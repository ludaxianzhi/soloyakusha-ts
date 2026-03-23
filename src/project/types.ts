/**
 * 定义翻译项目域模型中的核心类型与数据结构。
 *
 * 本模块包含：
 * - 翻译单元与片段的层级结构定义
 * - 章节与项目的配置接口
 * - 上下文与任务的数据结构
 * - 进度统计类
 *
 * 类型层次：
 * TranslationProject → Chapter → Fragment → TranslationUnit
 */

import type { TranslationContextView } from "./context-view.ts";

export type TranslationUnitMetadata = Record<string, string> | string | null;

export type TranslationUnit = {
  source: string;
  target: string[];
  metadata?: TranslationUnitMetadata;
};

export type TranslationUnitWindow = {
  units: TranslationUnit[];
  originalUnitIndexes?: number[];
  windowStartUnitIndex?: number;
  windowEndUnitIndex?: number;
};

export type TextFragment = {
  lines: string[];
};

export type FragmentMeta = {
  metadataList: TranslationUnitMetadata[];
  targetGroups?: string[][];
  originalUnitIndexes?: number[];
  windowStartUnitIndex?: number;
  windowEndUnitIndex?: number;
};

export type FragmentEntry = {
  source: TextFragment;
  translation: TextFragment;
  stageValues: Record<string, TextFragment>;
  meta?: FragmentMeta;
  isTranslated: boolean;
  hash: string;
};

export type ChapterEntry = {
  id: number;
  filePath: string;
  fragments: FragmentEntry[];
};

export type Chapter = {
  id: number;
  filePath: string;
};

export type ContextSettings = {
  includeEarlierFragments?: number;
};

export type GlossarySettings = {
  path?: string;
  autoFilter?: boolean;
};

export type TranslationProjectConfig = {
  projectName: string;
  projectDir: string;
  chapters: Chapter[];
  context?: ContextSettings;
  glossary?: GlossarySettings;
  customRequirements?: string[];
};

export type TranslationUnitParser = (content: string) => TranslationUnit[];

export type TranslationUnitSplitter = {
  split(units: TranslationUnit[]): Array<TranslationUnit[] | TranslationUnitWindow>;
};

export type TranslationResult = {
  chapterId: number;
  fragmentIndex: number;
  translatedText?: string;
  success?: boolean;
  errorMessage?: string;
};

export type ContextPair = {
  chapterId: number;
  fragmentIndex: number;
  fragmentHash: string;
  sourceText: string;
  translatedText: string;
};

export type TranslationContextType = "glossary" | "precedingTranslation";

export type GlossaryContextEntry = {
  type: "glossary";
  description: string;
  priority: number;
  content: string;
};

export type PairContextEntry = {
  type: "precedingTranslation";
  description: string;
  priority: number;
  pairs: ContextPair[];
};

export type TranslationContextEntry = GlossaryContextEntry | PairContextEntry;

export type TranslationTask = {
  chapterId: number;
  fragmentIndex: number;
  sourceText: string;
  contextView: TranslationContextView;
  requirements: string[];
};

export type ProjectCursor = {
  chapterId?: number;
  fragmentIndex?: number;
};

/**
 * 项目进度对象，统计翻译完成度。
 *
 * 提供章节级与片段级的完成比例计算，用于进度展示与断点恢复。
 */
export class ProjectProgress {
  constructor(
    readonly totalChapters = 0,
    readonly translatedChapters = 0,
    readonly totalFragments = 0,
    readonly translatedFragments = 0,
    readonly currentChapterId?: number,
    readonly currentFragmentIndex?: number,
  ) {}

  get fragmentProgressRatio(): number {
    if (this.totalFragments === 0) {
      return 0;
    }

    return this.translatedFragments / this.totalFragments;
  }

  get chapterProgressRatio(): number {
    if (this.totalChapters === 0) {
      return 0;
    }

    return this.translatedChapters / this.totalChapters;
  }
}

export function createTextFragment(input: string | string[]): TextFragment {
  return {
    lines: Array.isArray(input) ? input : input.split("\n"),
  };
}

export function fragmentToText(fragment: TextFragment): string {
  return fragment.lines.join("\n");
}
