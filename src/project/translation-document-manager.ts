/**
 * 负责章节加载、文本切分、片段持久化、运行时滑动窗口视图与翻译文档访问。
 *
 * 本模块是翻译项目的数据存储层核心，提供：
 * - 多格式文件的翻译单元解析
 * - 基于字符限制的文本切分策略
 * - 片段状态的内存索引与磁盘持久化
 * - 翻译结果合并导出
 * - 基于已切分片段按需派生滑动窗口视图
 *
 * 数据流向：
 * 原始文件 → TranslationUnit[] → FragmentEntry[] → JSON 持久化
 *
 * @module project/translation-document-manager
 */

import {
  mkdir,
  readFile,
  unlink,
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
  SlidingWindowFragment,
  SlidingWindowFragmentLine,
  SlidingWindowOptions,
  TextFragment,
  TranslationProjectState,
  TranslationUnit,
  TranslationUnitMetadata,
  TranslationUnitParser,
  TranslationUnitSplitter,
  WorkspaceConfig,
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
  readonly projectStatePath: string;
  readonly workspaceConfigPath: string;
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
    const dataRootDir = resolve(this.projectDir, "Data");
    this.dataDir = resolve(options.chapterDataDir ?? join(dataRootDir, "Chapters"));
    this.projectStatePath = resolve(join(dataRootDir, "project-state.json"));
    this.workspaceConfigPath = resolve(join(dataRootDir, "workspace-config.json"));
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

  async loadProjectState(): Promise<TranslationProjectState | undefined> {
    try {
      const content = await readFile(this.projectStatePath, "utf8");
      return normalizePersistedProjectState(JSON.parse(content) as TranslationProjectState);
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async saveProjectState(state: TranslationProjectState): Promise<void> {
    await mkdir(dirname(this.projectStatePath), { recursive: true });
    await writeFile(this.projectStatePath, JSON.stringify(state, null, 2), "utf8");
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

  getSlidingWindowFragment(
    chapterId: number,
    fragmentIndex: number,
    options: SlidingWindowOptions = {},
  ): SlidingWindowFragment {
    const overlapChars = options.overlapChars ?? 400;
    if (overlapChars < 0) {
      throw new Error("overlapChars 不能小于 0");
    }

    const chapter = this.getRequiredChapter(chapterId);
    const lines = flattenChapterLines(chapter);
    const focusRange = getFragmentLineRange(chapter, fragmentIndex);
    const windowStart = expandWindowStart(lines, focusRange.start, overlapChars);
    const windowEnd = expandWindowEnd(lines, focusRange.end, overlapChars);
    const windowLines = lines.slice(windowStart, windowEnd);

    return {
      chapterId,
      fragmentIndex,
      source: createTextFragment(windowLines.map((line) => line.source)),
      translation: createTextFragment(windowLines.map((line) => line.translation)),
      lines: windowLines.map<SlidingWindowFragmentLine>((line) => ({
        unitIndex: line.unitIndex,
        fragmentIndex: line.fragmentIndex,
        lineIndex: line.lineIndex,
        source: line.source,
        translation: line.translation,
      })),
      focusLineStart: focusRange.start - windowStart,
      focusLineEnd: focusRange.end - windowStart,
    };
  }

  getChapterSlidingWindowFragments(
    chapterId: number,
    options: SlidingWindowOptions = {},
  ): SlidingWindowFragment[] {
    const chapter = this.getRequiredChapter(chapterId);
    return chapter.fragments.map((_fragment, fragmentIndex) =>
      this.getSlidingWindowFragment(chapterId, fragmentIndex, options),
    );
  }

  async updateSlidingWindowTranslation(
    window: SlidingWindowFragment,
    translation: TextFragment | string | string[],
  ): Promise<void> {
    const normalizedTranslation = normalizeFragment(translation);
    if (normalizedTranslation.lines.length !== window.source.lines.length) {
      throw new Error(
        `滑动窗口译文行数不匹配: expected=${window.source.lines.length}, actual=${normalizedTranslation.lines.length}`,
      );
    }

    const fragment = this.getRequiredFragment(window.chapterId, window.fragmentIndex);
    const focusLines = normalizedTranslation.lines.slice(
      window.focusLineStart,
      window.focusLineEnd,
    );
    if (focusLines.length !== fragment.source.lines.length) {
      throw new Error(
        `滑动窗口回填范围无效: expected=${fragment.source.lines.length}, actual=${focusLines.length}`,
      );
    }

    fragment.translation = createTextFragment(focusLines);
    await this.saveChapterById(window.chapterId);
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

  /**
   * 添加新章节：从源文件读取翻译单元、切分为片段并持久化。
   *
   * 如果提供了 fileHandler，使用它读取文件；否则回退到构造时的 fileHandlerResolver 和 parseUnits。
   */
  async addChapter(
    chapterId: number,
    filePath: string,
    options?: { fileHandler?: TranslationFileHandler },
  ): Promise<ChapterEntry> {
    const fileHandler = options?.fileHandler ?? this.fileHandlerResolver?.(filePath);
    const units = fileHandler
      ? await fileHandler.readTranslationUnits(filePath)
      : this.parseUnits(await readFile(filePath, "utf8"));
    const chapter = createChapterEntry(chapterId, filePath, this.textSplitter.split(units));

    this.chapters.set(chapterId, chapter);
    this.rebuildHashIndexForChapter(chapter);
    await this.saveChapterToDisk(chapter);
    return chapter;
  }

  /**
   * 移除章节：从内存中删除章节数据和哈希索引，并删除磁盘上的数据文件。
   */
  async removeChapter(chapterId: number): Promise<void> {
    const chapter = this.chapters.get(chapterId);
    if (chapter) {
      for (const fragment of chapter.fragments) {
        this.hashIndex.delete(fragment.hash);
      }
    }
    this.chapters.delete(chapterId);

    try {
      await unlink(this.getChapterDataPath(chapterId));
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }

  /**
   * 从磁盘加载工作区配置文件。文件不存在时返回 undefined。
   */
  async loadWorkspaceConfig(): Promise<WorkspaceConfig | undefined> {
    try {
      const content = await readFile(this.workspaceConfigPath, "utf8");
      return JSON.parse(content) as WorkspaceConfig;
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * 将工作区配置持久化到磁盘。
   *
   * 配置以紧凑 JSON 存储（不考虑可读性，优先 API 交互友好性）。
   */
  async saveWorkspaceConfig(config: WorkspaceConfig): Promise<void> {
    await mkdir(dirname(this.workspaceConfigPath), { recursive: true });
    await writeFile(this.workspaceConfigPath, JSON.stringify(config), "utf8");
  }

  private async loadAndInitializeChapter(
    chapterId: number,
    filePath: string,
  ): Promise<void> {
    const fileHandler = this.fileHandlerResolver?.(filePath);
    const units = fileHandler
      ? await fileHandler.readTranslationUnits(filePath)
      : this.parseUnits(await readFile(filePath, "utf8"));
    const chapter = createChapterEntry(chapterId, filePath, this.textSplitter.split(units));

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
      const parsed = JSON.parse(content) as ChapterEntry;
      const chapter = normalizePersistedChapter(parsed);
      if (chapterNeedsLegacyWindowUpgrade(parsed)) {
        const upgraded = createChapterEntry(
          chapter.id,
          chapter.filePath,
          this.textSplitter.split(mergeLegacyChapterTranslationUnits(parsed)),
        );
        await this.saveChapterToDisk(upgraded);
        return upgraded;
      }

      return chapter;
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
  return {
    id: chapter.id,
    filePath: chapter.filePath,
    fragments: chapter.fragments.map((fragment) => {
      return {
        source: fragment.source,
        translation: fragment.translation,
        pipelineStates: Object.fromEntries(
          Object.entries(fragment.pipelineStates ?? {}).map(([stepId, state]) => [
            stepId,
            normalizePersistedPipelineStepState(state),
          ]),
        ),
        meta: {
          metadataList: fragment.meta?.metadataList ?? [],
          targetGroups: (fragment.meta?.targetGroups ?? []).map((group) => [...group]),
        },
        hash: fragment.hash,
      };
    }),
  };
}

function normalizePersistedPipelineStepState(
  state: FragmentPipelineStepState,
): FragmentPipelineStepState {
  return {
    ...state,
    attemptCount: typeof state.attemptCount === "number" ? state.attemptCount : 0,
  };
}

function normalizePersistedProjectState(
  state: TranslationProjectState,
): TranslationProjectState {
  return {
    schemaVersion: 1,
    pipeline: {
      stepIds: [...(state.pipeline?.stepIds ?? [])],
      finalStepId: state.pipeline?.finalStepId ?? "",
    },
    lifecycle: {
      status: state.lifecycle?.status ?? "idle",
      currentRunId: state.lifecycle?.currentRunId,
      startedAt: state.lifecycle?.startedAt,
      stopRequestedAt: state.lifecycle?.stopRequestedAt,
      stoppedAt: state.lifecycle?.stoppedAt,
      abortedAt: state.lifecycle?.abortedAt,
      abortReason: state.lifecycle?.abortReason,
      completedAt: state.lifecycle?.completedAt,
      interruptedAt: state.lifecycle?.interruptedAt,
      lastSavedAt: state.lifecycle?.lastSavedAt,
      updatedAt: state.lifecycle?.updatedAt,
    },
  };
}

function mergeChapterTranslationUnits(chapter: ChapterEntry): TranslationUnit[] {
  return chapter.fragments.flatMap((fragment) =>
    fragment.source.lines.map((sourceLine, lineIndex) =>
      buildTranslationUnit(fragment, lineIndex, sourceLine),
    ),
  );
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

function createSequentialUnitIndexes(startIndex: number, count: number): number[] {
  return Array.from({ length: count }, (_, offset) => startIndex + offset);
}

function createChapterEntry(
  chapterId: number,
  filePath: string,
  fragmentGroups: TranslationUnit[][],
): ChapterEntry {
  return {
    id: chapterId,
    filePath,
    fragments: fragmentGroups.map((fragmentUnits) => createFragmentEntry(fragmentUnits)),
  };
}

function createFragmentEntry(fragmentUnits: TranslationUnit[]): FragmentEntry {
  const source = createTextFragment(fragmentUnits.map((unit) => unit.source));
  return {
    source,
    translation: createTextFragment(fragmentUnits.map((unit) => unit.target.at(-1) ?? "")),
    pipelineStates: {},
    meta: {
      metadataList: fragmentUnits.map((unit) => unit.metadata ?? null),
      targetGroups: fragmentUnits.map((unit) => [...unit.target]),
    },
    hash: computeHash(source),
  };
}

type FlattenedChapterLine = {
  unitIndex: number;
  fragmentIndex: number;
  lineIndex: number;
  source: string;
  translation: string;
};

function flattenChapterLines(chapter: ChapterEntry): FlattenedChapterLine[] {
  let unitIndex = 0;
  return chapter.fragments.flatMap((fragment, fragmentIndex) =>
    fragment.source.lines.map((source, lineIndex) => ({
      unitIndex: unitIndex++,
      fragmentIndex,
      lineIndex,
      source,
      translation: fragment.translation.lines[lineIndex] ?? "",
    })),
  );
}

function getFragmentLineRange(
  chapter: ChapterEntry,
  fragmentIndex: number,
): { start: number; end: number } {
  const fragment = chapter.fragments[fragmentIndex];
  if (!fragment) {
    throw new Error(`文本块不存在: chapter=${chapter.id}, fragment=${fragmentIndex}`);
  }

  const start = chapter.fragments
    .slice(0, fragmentIndex)
    .reduce((sum, current) => sum + current.source.lines.length, 0);
  return {
    start,
    end: start + fragment.source.lines.length,
  };
}

function expandWindowStart(
  lines: FlattenedChapterLine[],
  focusStart: number,
  overlapChars: number,
): number {
  let start = focusStart;
  let currentChars = 0;

  while (start > 0 && currentChars < overlapChars) {
    start -= 1;
    currentChars += lines[start]?.source.length ?? 0;
  }

  return start;
}

function expandWindowEnd(
  lines: FlattenedChapterLine[],
  focusEnd: number,
  overlapChars: number,
): number {
  let end = focusEnd;
  let currentChars = 0;

  while (end < lines.length && currentChars < overlapChars) {
    currentChars += lines[end]?.source.length ?? 0;
    end += 1;
  }

  return end;
}

type LegacyFragmentMeta = {
  metadataList: TranslationUnitMetadata[];
  targetGroups?: string[][];
  originalUnitIndexes?: number[];
  windowStartUnitIndex?: number;
  windowEndUnitIndex?: number;
};

type LegacyFragmentEntry = Omit<FragmentEntry, "meta"> & {
  meta?: LegacyFragmentMeta;
};

type LegacyChapterEntry = Omit<ChapterEntry, "fragments"> & {
  fragments: LegacyFragmentEntry[];
};

function chapterNeedsLegacyWindowUpgrade(chapter: ChapterEntry): chapter is LegacyChapterEntry {
  return chapter.fragments.some(
    (fragment) =>
      Array.isArray((fragment.meta as LegacyFragmentMeta | undefined)?.originalUnitIndexes) ||
      typeof (fragment.meta as LegacyFragmentMeta | undefined)?.windowStartUnitIndex ===
        "number" ||
      typeof (fragment.meta as LegacyFragmentMeta | undefined)?.windowEndUnitIndex === "number",
  );
}

function mergeLegacyChapterTranslationUnits(chapter: LegacyChapterEntry): TranslationUnit[] {
  const unitSlots = new Map<number, TranslationUnit>();
  let nextUnitIndex = 0;

  for (const fragment of chapter.fragments) {
    const originalUnitIndexes = normalizeLegacyOriginalUnitIndexes({
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
        throw new Error(`章节 ${chapter.id} 的旧窗口索引缺失: fragment=${fragment.hash}`);
      }

      const candidate = buildTranslationUnit(fragment, lineIndex, sourceLine);
      const existing = unitSlots.get(unitIndex);
      if (!existing) {
        unitSlots.set(unitIndex, candidate);
        continue;
      }

      if (existing.source !== candidate.source) {
        throw new Error(
          `章节 ${chapter.id} 的旧窗口索引 ${unitIndex} 存在不一致原文，无法迁移`,
        );
      }

      if (shouldReplaceLegacyMergedUnit(existing, candidate)) {
        unitSlots.set(unitIndex, candidate);
      }
    }
  }

  return Array.from(unitSlots.entries())
    .sort(([left], [right]) => left - right)
    .map(([, unit]) => unit);
}

function normalizeLegacyOriginalUnitIndexes(options: {
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

function shouldReplaceLegacyMergedUnit(
  existing: TranslationUnit,
  candidate: TranslationUnit,
): boolean {
  const existingTranslation = existing.target.at(-1) ?? "";
  const candidateTranslation = candidate.target.at(-1) ?? "";
  return existingTranslation.length === 0 && candidateTranslation.length > 0;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
