/**
 * 定义翻译项目域模型中的核心类型与数据结构。
 *
 * 本模块包含：
 * - 翻译单元与片段的层级结构定义
 * - Pipeline 步骤状态
 * - 章节与项目的配置接口
 * - 上下文与进度统计类
 */

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

export type PipelineStepStatus = "queued" | "running" | "completed";

export type FragmentPipelineStepState = {
  status: PipelineStepStatus;
  queueSequence: number;
  output?: TextFragment;
  errorMessage?: string;
};

export type FragmentEntry = {
  source: TextFragment;
  translation: TextFragment;
  pipelineStates: Record<string, FragmentPipelineStepState>;
  meta?: FragmentMeta;
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

export type GlossarySettings = {
  path?: string;
  autoFilter?: boolean;
};

export type TranslationProjectConfig = {
  projectName: string;
  projectDir: string;
  chapters: Chapter[];
  glossary?: GlossarySettings;
  customRequirements?: string[];
};

export type TranslationUnitParser = (content: string) => TranslationUnit[];

export type TranslationUnitSplitter = {
  split(units: TranslationUnit[]): Array<TranslationUnit[] | TranslationUnitWindow>;
};

export type ContextPair = {
  chapterId: number;
  fragmentIndex: number;
  fragmentHash: string;
  sourceText: string;
  translatedText: string;
};

export type TranslationDependencyMode = "previousTranslations" | "glossaryTerms";

export type TranslationContextType = "glossary" | "dependencyTranslation";

export type GlossaryContextEntry = {
  type: "glossary";
  description: string;
  priority: number;
  content: string;
};

export type DependencyPairContextEntry = {
  type: "dependencyTranslation";
  description: string;
  priority: number;
  pairs: ContextPair[];
};

export type TranslationContextEntry = GlossaryContextEntry | DependencyPairContextEntry;

export type ProjectCursor = {
  chapterId?: number;
  fragmentIndex?: number;
};

/**
 * 项目进度对象，统计最终翻译步骤的完成度。
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
