/**
 * 负责章节加载、文本切分、片段持久化、滑动窗口合并与翻译文档访问。
 *
 * 本模块是翻译项目的数据存储层核心，提供：
 * - 多格式文件的翻译单元解析
 * - 基于字符限制的文本切分策略
 * - 片段状态的内存索引与磁盘持久化
 * - 翻译结果合并导出
 *
 * 数据流向：
 * 原始文件 → TranslationUnit[] → FragmentEntry[] → JSON 持久化
 *
 * @module project/translation-document-manager
 */

import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  TranslationFileHandler,
  TranslationFileHandlerResolver,
} from "../file-handlers/base.ts";
import type {
  ChapterEntry,
  FragmentEntry,
  FragmentPipelineStepState,
  TextFragment,
  TranslationUnit,
  TranslationUnitParser,
  TranslationUnitSplitter,
  TranslationUnitWindow,
} from "./types.ts";
import {
  createTextFragment,
  fragmentToText,
} from "./types.ts";

/**
 * 默认文本切分器，按字符上限把翻译单元划分为互不重叠的片段。
 *
 * 该切分器按顺序遍历翻译单元，累积字符数，当超过 maxChars 时开始新片段。
 * 每个片段包含连续的翻译单元，无重叠区间。
 *
 * 适用场景：
 * - 原文长度相对均匀
 * - 无需上下文重叠
 * - 简单的分批翻译处理
 */
export class DefaultTextSplitter implements TranslationUnitSplitter {
  constructor(private readonly maxChars = 2000) {}

  split(units: TranslationUnit[]): TranslationUnit[][] {
    if (units.length === 0) {
      return [];
    }

    const fragments: TranslationUnit[][] = [];
    let currentFragment: TranslationUnit[] = [];
    let currentLength = 0;

    for (const unit of units) {
      const unitLength = unit.source.length;
      if (currentLength + unitLength > this.maxChars && currentFragment.length > 0) {
        fragments.push(currentFragment);
        currentFragment = [];
        currentLength = 0;
      }

      currentFragment.push(unit);
      currentLength += unitLength;
    }

    if (currentFragment.length > 0) {
      fragments.push(currentFragment);
    }

    return fragments;
  }
}

/**
 * 滑动窗口切分器，按字符长度生成带重叠区间的翻译窗口。
 *
 * 每个窗口包含不超过 maxChars 字符的翻译单元，相邻窗口之间有 overlapChars 的重叠。
 * 重叠区域用于提供上下文信息，帮助翻译模型理解衔接关系。
 *
 * 适用场景：
 * - 需要保持翻译上下文连贯性
 * - 处理长文本章节
 * - 翻译模型需要更多上下文信息
 *
 * 窗口元数据：
 * - originalUnitIndexes: 窗口内翻译单元在原文中的索引
 * - windowStartUnitIndex / windowEndUnitIndex: 窗口边界
 */
export class SlidingWindowTextSplitter implements TranslationUnitSplitter {
  constructor(
    private readonly maxChars = 2000,
    private readonly overlapChars = 400,
  ) {
    if (maxChars <= 0) {
      throw new Error("maxChars 必须大于 0");
    }

    if (overlapChars < 0) {
      throw new Error("overlapChars 不能小于 0");
    }
  }

  split(units: TranslationUnit[]): TranslationUnitWindow[] {
    if (units.length === 0) {
      return [];
    }

    const fragments: TranslationUnitWindow[] = [];
    let startIndex = 0;

    while (startIndex < units.length) {
      let endIndex = startIndex;
      let currentLength = 0;

      while (endIndex < units.length) {
        const unitLength = units[endIndex]?.source.length ?? 0;
        if (currentLength + unitLength > this.maxChars && endIndex > startIndex) {
          break;
        }

        currentLength += unitLength;
        endIndex += 1;
      }

      const originalUnitIndexes = createSequentialUnitIndexes(
        startIndex,
        endIndex - startIndex,
      );
      fragments.push({
        units: units.slice(startIndex, endIndex),
        originalUnitIndexes,
        windowStartUnitIndex: startIndex,
        windowEndUnitIndex: endIndex,
      });

      if (endIndex >= units.length) {
        break;
      }

      startIndex = this.getNextStartIndex(units, startIndex, endIndex);
    }

    return fragments;
  }

  private getNextStartIndex(
    units: TranslationUnit[],
    startIndex: number,
    endIndex: number,
  ): number {
    if (this.overlapChars === 0) {
      return endIndex;
    }

    let nextStartIndex = endIndex;
    let overlapLength = 0;

    while (nextStartIndex > startIndex && overlapLength < this.overlapChars) {
      nextStartIndex -= 1;
      overlapLength += units[nextStartIndex]?.source.length ?? 0;
    }

    return Math.max(startIndex + 1, nextStartIndex);
  }
}

type NormalizedSplitFragment = {
  units: TranslationUnit[];
  originalUnitIndexes: number[];
  windowStartUnitIndex: number;
  windowEndUnitIndex: number;
};

/**
 * 翻译文档管理器，负责章节读写、片段持久化、哈希索引与导出合并。
 *
 * 核心职责：
 * - 章节加载：从原始文件读取翻译单元，应用切分策略，生成片段条目
 * - 持久化：将章节状态保存为 JSON 文件，支持断点恢复
 * - 翻译更新：接收翻译结果，更新片段状态，触发落盘
 * - 导出合并：将所有片段的翻译结果按原顺序合并为完整译文
 *
 * 哈希索引用于快速定位片段，支持跨章节引用（如上下文构建）。
 *
 * 数据目录结构：
 * projectDir/Data/Chapters/{chapterId}.json
 */
export class TranslationDocumentManager {
  readonly projectDir: string;
  readonly dataDir: string;
  private readonly textSplitter: TranslationUnitSplitter;
  private readonly parseUnits: TranslationUnitParser;
  private readonly chapters = new Map<number, ChapterEntry>();
  private readonly hashIndex = new Map<string, { chapterId: number; fragmentIndex: number }>();

  constructor(
    projectDir: string,
    options: {
      textSplitter?: TranslationUnitSplitter;
      parseUnits?: TranslationUnitParser;
      chapterDataDir?: string;
      fileHandlerResolver?: TranslationFileHandlerResolver;
    } = {},
  ) {
    this.projectDir = resolve(projectDir);
    this.dataDir = resolve(
      options.chapterDataDir ?? join(this.projectDir, "Data", "Chapters"),
    );
    this.textSplitter = options.textSplitter ?? new DefaultTextSplitter();
    this.parseUnits = options.parseUnits ?? defaultUnitParser;
    this.fileHandlerResolver = options.fileHandlerResolver;
  }

  private readonly fileHandlerResolver?: TranslationFileHandlerResolver;

  async loadChapters(
    chapterFiles: Array<{ chapterId: number; filePath: string }>,
  ): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });

    for (const { chapterId, filePath } of chapterFiles) {
      const persistedChapter = await this.loadChapterFromDisk(chapterId);
      if (persistedChapter) {
        this.chapters.set(chapterId, persistedChapter);
        this.rebuildHashIndexForChapter(persistedChapter);
        continue;
      }

      await this.loadAndInitializeChapter(chapterId, filePath);
    }
  }

  async saveChapters(): Promise<void> {
    await Promise.all(
      this.getAllChapters().map((chapter) => this.saveChapterToDisk(chapter)),
    );
  }

  async updateTranslation(
    chapterId: number,
    fragmentIndex: number,
    translation: TextFragment | string | string[],
  ): Promise<void> {
    const fragment = this.getRequiredFragment(chapterId, fragmentIndex);
    fragment.translation = normalizeFragment(translation);
    await this.saveChapterById(chapterId);
  }

  async updatePipelineStepState(
    chapterId: number,
    fragmentIndex: number,
    stepId: string,
    state: FragmentPipelineStepState,
  ): Promise<void> {
    const fragment = this.getRequiredFragment(chapterId, fragmentIndex);
    fragment.pipelineStates[stepId] = state;
    await this.saveChapterById(chapterId);
  }

  async updatePipelineStepStates(
    steps: Array<{
      chapterId: number;
      fragmentIndex: number;
      stepId: string;
      state: FragmentPipelineStepState;
    }>,
  ): Promise<void> {
    const affectedChapterIds = new Set<number>();
    for (const stepRef of steps) {
      const fragment = this.getRequiredFragment(stepRef.chapterId, stepRef.fragmentIndex);
      fragment.pipelineStates[stepRef.stepId] = stepRef.state;
      affectedChapterIds.add(stepRef.chapterId);
    }

    await Promise.all(
      [...affectedChapterIds].map((chapterId) => this.saveChapterById(chapterId)),
    );
  }

  getPipelineStepState(
    chapterId: number,
    fragmentIndex: number,
    stepId: string,
  ): FragmentPipelineStepState | undefined {
    return this.getRequiredFragment(chapterId, fragmentIndex).pipelineStates[stepId];
  }

  getFragmentById(
    chapterId: number,
    fragmentIndex: number,
  ): FragmentEntry | undefined {
    const chapter = this.chapters.get(chapterId);
    return chapter?.fragments[fragmentIndex];
  }

  getFragmentByHash(
    hash: string,
  ): { chapterId: number; fragmentIndex: number; fragment: FragmentEntry } | undefined {
    const indexed = this.hashIndex.get(hash);
    if (!indexed) {
      return undefined;
    }

    const fragment = this.getFragmentById(indexed.chapterId, indexed.fragmentIndex);
    if (!fragment) {
      return undefined;
    }

    return {
      chapterId: indexed.chapterId,
      fragmentIndex: indexed.fragmentIndex,
      fragment,
    };
  }

  getChapterById(chapterId: number): ChapterEntry | undefined {
    return this.chapters.get(chapterId);
  }

  getAllChapters(): ChapterEntry[] {
    return Array.from(this.chapters.values());
  }

  getSourceText(chapterId: number, fragmentIndex: number): string {
    return fragmentToText(this.getRequiredFragment(chapterId, fragmentIndex).source);
  }

  getTranslatedText(chapterId: number, fragmentIndex: number): string {
    return fragmentToText(this.getRequiredFragment(chapterId, fragmentIndex).translation);
  }

  getChapterSourceText(chapterId: number): string {
    return this.getChapterTranslationUnits(chapterId).map((unit) => unit.source).join("\n");
  }

  getChapterTranslatedText(chapterId: number): string {
    return this.getChapterTranslationUnits(chapterId)
      .map((unit) => unit.target.at(-1) ?? "")
      .join("\n");
  }

  getChapterTranslationUnits(chapterId: number): TranslationUnit[] {
    const chapter = this.getRequiredChapter(chapterId);
    return mergeChapterTranslationUnits(chapter);
  }

  async exportChapter(
    chapterId: number,
    outputFilePath: string,
    fileHandler: TranslationFileHandler,
  ): Promise<void> {
    await fileHandler.writeTranslationUnits(
      outputFilePath,
      this.getChapterTranslationUnits(chapterId),
    );
  }

  private async loadAndInitializeChapter(
    chapterId: number,
    filePath: string,
  ): Promise<void> {
    const fileHandler = this.fileHandlerResolver?.(filePath);
    const units = fileHandler
      ? await fileHandler.readTranslationUnits(filePath)
      : this.parseUnits(await readFile(filePath, "utf8"));
    const fragmentGroups = normalizeSplitFragments(this.textSplitter.split(units));

    const fragments = fragmentGroups.map<FragmentEntry>((fragmentGroup) => {
      const fragmentUnits = fragmentGroup.units;
      const sourceLines = fragmentUnits.map((unit) => unit.source);
      const metadataList = fragmentUnits.map((unit) => unit.metadata ?? null);
      const targetGroups = fragmentUnits.map((unit) => [...unit.target]);
      const source = createTextFragment(sourceLines);
      const translation = createTextFragment(
        fragmentUnits.map((unit) => unit.target.at(-1) ?? ""),
      );

        return {
          source,
          translation,
          pipelineStates: {},
          meta: {
            metadataList,
            targetGroups,
            originalUnitIndexes: [...fragmentGroup.originalUnitIndexes],
            windowStartUnitIndex: fragmentGroup.windowStartUnitIndex,
            windowEndUnitIndex: fragmentGroup.windowEndUnitIndex,
          },
          hash: computeHash(source),
        };
      });

    const chapter: ChapterEntry = {
      id: chapterId,
      filePath,
      fragments,
    };

    this.chapters.set(chapterId, chapter);
    this.rebuildHashIndexForChapter(chapter);
    await this.saveChapterToDisk(chapter);
  }

  private async saveChapterById(chapterId: number): Promise<void> {
    await this.saveChapterToDisk(this.getRequiredChapter(chapterId));
  }

  private async saveChapterToDisk(chapter: ChapterEntry): Promise<void> {
    const filePath = this.getChapterDataPath(chapter.id);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(chapter, null, 2), "utf8");
  }

  private async loadChapterFromDisk(chapterId: number): Promise<ChapterEntry | undefined> {
    const filePath = this.getChapterDataPath(chapterId);
    try {
      const content = await readFile(filePath, "utf8");
      const chapter = JSON.parse(content) as ChapterEntry;
      return normalizePersistedChapter(chapter);
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private rebuildHashIndexForChapter(chapter: ChapterEntry): void {
    for (const [fragmentIndex, fragment] of chapter.fragments.entries()) {
      this.hashIndex.set(fragment.hash, {
        chapterId: chapter.id,
        fragmentIndex,
      });
    }
  }

  private getRequiredChapter(chapterId: number): ChapterEntry {
    const chapter = this.chapters.get(chapterId);
    if (!chapter) {
      throw new Error(`章节 ${chapterId} 不存在`);
    }

    return chapter;
  }

  private getRequiredFragment(chapterId: number, fragmentIndex: number): FragmentEntry {
    const fragment = this.getFragmentById(chapterId, fragmentIndex);
    if (!fragment) {
      throw new Error(`文本块不存在: chapter=${chapterId}, fragment=${fragmentIndex}`);
    }

    return fragment;
  }

  private getChapterDataPath(chapterId: number): string {
    return join(this.dataDir, `${chapterId}.json`);
  }
}

function defaultUnitParser(content: string): TranslationUnit[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map<TranslationUnit>((line) => ({
      source: line,
      target: [],
      metadata: null,
    }));
}

function normalizeFragment(value: TextFragment | string | string[]): TextFragment {
  if (typeof value === "string" || Array.isArray(value)) {
    return createTextFragment(value);
  }

  return value;
}

function computeHash(fragment: TextFragment): string {
  return Bun.hash(fragmentToText(fragment)).toString(16);
}

function normalizePersistedChapter(chapter: ChapterEntry): ChapterEntry {
  let nextUnitIndex = 0;

  return {
    id: chapter.id,
    filePath: chapter.filePath,
    fragments: chapter.fragments.map((fragment) => {
      const originalUnitIndexes = normalizeOriginalUnitIndexes({
        providedIndexes: fragment.meta?.originalUnitIndexes,
        lineCount: fragment.source.lines.length,
        fallbackStartIndex: nextUnitIndex,
        windowStartUnitIndex: fragment.meta?.windowStartUnitIndex,
        windowEndUnitIndex: fragment.meta?.windowEndUnitIndex,
      });
      const windowStartUnitIndex = originalUnitIndexes[0] ?? nextUnitIndex;
      const windowEndUnitIndex =
        typeof fragment.meta?.windowEndUnitIndex === "number"
          ? fragment.meta.windowEndUnitIndex
          : (originalUnitIndexes.at(-1) ?? (windowStartUnitIndex - 1)) + 1;
      nextUnitIndex = Math.max(nextUnitIndex, windowEndUnitIndex);

      return {
        source: fragment.source,
        translation: fragment.translation,
        pipelineStates: fragment.pipelineStates ?? {},
        meta: {
          metadataList: fragment.meta?.metadataList ?? [],
          targetGroups: (fragment.meta?.targetGroups ?? []).map((group) => [...group]),
          originalUnitIndexes,
          windowStartUnitIndex,
          windowEndUnitIndex,
        },
        hash: fragment.hash,
      };
    }),
  };
}

function normalizeSplitFragments(
  fragments: Array<TranslationUnit[] | TranslationUnitWindow>,
): NormalizedSplitFragment[] {
  const normalized: NormalizedSplitFragment[] = [];
  let nextUnitIndex = 0;

  for (const fragment of fragments) {
    const units = Array.isArray(fragment) ? fragment : fragment.units;
    const originalUnitIndexes = normalizeOriginalUnitIndexes({
      providedIndexes: Array.isArray(fragment) ? undefined : fragment.originalUnitIndexes,
      lineCount: units.length,
      fallbackStartIndex: nextUnitIndex,
      windowStartUnitIndex:
        Array.isArray(fragment) ? undefined : fragment.windowStartUnitIndex,
      windowEndUnitIndex:
        Array.isArray(fragment) ? undefined : fragment.windowEndUnitIndex,
    });
    const windowStartUnitIndex = originalUnitIndexes[0] ?? nextUnitIndex;
    const windowEndUnitIndex =
      !Array.isArray(fragment) && typeof fragment.windowEndUnitIndex === "number"
        ? fragment.windowEndUnitIndex
        : (originalUnitIndexes.at(-1) ?? (windowStartUnitIndex - 1)) + 1;

    normalized.push({
      units,
      originalUnitIndexes,
      windowStartUnitIndex,
      windowEndUnitIndex,
    });
    nextUnitIndex = Math.max(nextUnitIndex, windowEndUnitIndex);
  }

  return normalized;
}

function mergeChapterTranslationUnits(chapter: ChapterEntry): TranslationUnit[] {
  const unitSlots = new Map<number, TranslationUnit>();
  let nextUnitIndex = 0;

  for (const fragment of chapter.fragments) {
    const originalUnitIndexes = normalizeOriginalUnitIndexes({
      providedIndexes: fragment.meta?.originalUnitIndexes,
      lineCount: fragment.source.lines.length,
      fallbackStartIndex: nextUnitIndex,
      windowStartUnitIndex: fragment.meta?.windowStartUnitIndex,
      windowEndUnitIndex: fragment.meta?.windowEndUnitIndex,
    });
    const fragmentEndUnitIndex =
      (originalUnitIndexes.at(-1) ?? (nextUnitIndex - 1)) + 1;
    nextUnitIndex = Math.max(nextUnitIndex, fragmentEndUnitIndex);

    for (const [lineIndex, sourceLine] of fragment.source.lines.entries()) {
      const unitIndex = originalUnitIndexes[lineIndex];
      if (typeof unitIndex !== "number") {
        throw new Error(`章节 ${chapter.id} 的窗口索引缺失: fragment=${fragment.hash}`);
      }

      const candidate = buildTranslationUnit(fragment, lineIndex, sourceLine);
      const existing = unitSlots.get(unitIndex);
      if (!existing) {
        unitSlots.set(unitIndex, candidate);
        continue;
      }

      if (existing.source !== candidate.source) {
        throw new Error(
          `章节 ${chapter.id} 的窗口索引 ${unitIndex} 存在不一致原文，无法合并导出`,
        );
      }

      if (shouldReplaceMergedUnit(existing, candidate)) {
        unitSlots.set(unitIndex, candidate);
      }
    }
  }

  const orderedIndexes = Array.from(unitSlots.keys()).sort((left, right) => left - right);
  for (const [expectedIndex, actualIndex] of orderedIndexes.entries()) {
    if (expectedIndex !== actualIndex) {
      throw new Error(`章节 ${chapter.id} 的窗口索引不连续，无法导出`);
    }
  }

  return orderedIndexes.map((index) => unitSlots.get(index)!);
}

function buildTranslationUnit(
  fragment: FragmentEntry,
  lineIndex: number,
  sourceLine: string,
): TranslationUnit {
  const metadataList = fragment.meta?.metadataList ?? [];
  const targetGroups = fragment.meta?.targetGroups ?? [];
  const originalTargets = [...(targetGroups[lineIndex] ?? [])];
  const finalTranslation = fragment.translation.lines[lineIndex];
  const targets = originalTargets;

  if (finalTranslation && finalTranslation.length > 0) {
    if (targets.length === 0) {
      targets.push(finalTranslation);
    } else {
      targets[targets.length - 1] = finalTranslation;
    }
  }

  return {
    source: sourceLine,
    target: targets,
    metadata: metadataList[lineIndex] ?? null,
  };
}

function shouldReplaceMergedUnit(existing: TranslationUnit, candidate: TranslationUnit): boolean {
  const existingTranslation = existing.target.at(-1) ?? "";
  const candidateTranslation = candidate.target.at(-1) ?? "";
  return existingTranslation.length === 0 && candidateTranslation.length > 0;
}

function normalizeOriginalUnitIndexes(options: {
  providedIndexes?: number[];
  lineCount: number;
  fallbackStartIndex: number;
  windowStartUnitIndex?: number;
  windowEndUnitIndex?: number;
}): number[] {
  const {
    providedIndexes,
    lineCount,
    fallbackStartIndex,
    windowStartUnitIndex,
    windowEndUnitIndex,
  } = options;

  if (providedIndexes && providedIndexes.length === lineCount) {
    return [...providedIndexes];
  }

  if (
    typeof windowStartUnitIndex === "number" &&
    typeof windowEndUnitIndex === "number" &&
    windowEndUnitIndex - windowStartUnitIndex === lineCount
  ) {
    return createSequentialUnitIndexes(windowStartUnitIndex, lineCount);
  }

  return createSequentialUnitIndexes(fallbackStartIndex, lineCount);
}

function createSequentialUnitIndexes(startIndex: number, count: number): number[] {
  return Array.from({ length: count }, (_, offset) => startIndex + offset);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
