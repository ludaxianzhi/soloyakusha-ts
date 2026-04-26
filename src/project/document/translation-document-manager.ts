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
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  TranslationFileHandler,
  TranslationFileHandlerResolver,
} from "../../file-handlers/base.ts";
import {
  isBlankSourceText,
  normalizeBlankSourceUnit,
  restoreBlankText,
} from "../../file-handlers/base.ts";
import type { SavedRepetitionPatternAnalysisResult } from "../analysis/repetition-pattern-analysis.ts";
import type {
  ChapterEntry,
  FragmentEntry,
  FragmentPipelineStepState,
  ProofreadTaskState,
  SlidingWindowFragment,
  SlidingWindowFragmentLine,
  SlidingWindowOptions,
  TextFragment,
  TranslationDependencyGraph,
  TranslationProjectState,
  TranslationUnit,
  TranslationUnitMetadata,
  TranslationUnitParser,
  TranslationUnitSplitter,
  WorkspaceConfig,
} from "../types.ts";
import type { ContextNetworkData } from "../context/context-network-types.ts";
import {
  createTextFragment,
  fragmentToText,
} from "../types.ts";
import {
  SqliteProjectStorage,
  type PersistedChapterIndex,
} from "../storage/sqlite-project-storage.ts";
import {
  clearContextNetwork,
  loadContextNetwork,
  saveContextNetwork,
} from "../context/context-network-storage.ts";
import {
  buildWorkspaceBootstrapDocument,
  DEFAULT_WORKSPACE_DATABASE_FILE_PATH,
  saveWorkspaceBootstrap,
} from "../pipeline/translation-project-workspace.ts";

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
  readonly databasePath: string;
  readonly projectStatePath: string;
  readonly workspaceConfigPath: string;
  private readonly textSplitter: TranslationUnitSplitter;
  private readonly parseUnits: TranslationUnitParser;
  private readonly chapters = new Map<number, ChapterEntry>();
  private readonly chapterIndexes = new Map<
    number,
    {
      filePath: string;
      fragmentHashes: string[];
    }
  >();
  private chapterOrder: number[] = [];
  private readonly hashIndex = new Map<string, { chapterId: number; fragmentIndex: number }>();
  private readonly storage: SqliteProjectStorage;

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
    this.dataDir = dataRootDir;
    this.databasePath = resolve(join(this.projectDir, DEFAULT_WORKSPACE_DATABASE_FILE_PATH));
    this.projectStatePath = this.databasePath;
    this.workspaceConfigPath = resolve(join(dataRootDir, "workspace-config.json"));
    this.textSplitter = options.textSplitter ?? new DefaultTextSplitter();
    this.parseUnits = options.parseUnits ?? defaultUnitParser;
    this.fileHandlerResolver = options.fileHandlerResolver;
    this.storage = new SqliteProjectStorage(this.databasePath);
  }

  private readonly fileHandlerResolver?: TranslationFileHandlerResolver;

  async loadChapters(
    chapterFiles: Array<{ chapterId: number; filePath: string }>,
  ): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    this.chapterOrder = [...chapterFiles.map(({ chapterId }) => chapterId)];

    for (const { chapterId, filePath } of chapterFiles) {
      const persistedChapterIndex = this.storage.loadChapterIndexSync(chapterId);
      if (persistedChapterIndex) {
        this.setChapterIndex(persistedChapterIndex);
        continue;
      }

      await this.loadAndInitializeChapter(chapterId, filePath);
    }
  }

  async saveChapters(): Promise<void> {
    for (const chapter of this.getAllChapters()) {
      await this.saveChapter(chapter);
    }
  }

  async loadProjectState(): Promise<TranslationProjectState | undefined> {
    const state = await this.storage.loadProjectState();
    return state ? normalizePersistedProjectState(state) : undefined;
  }

  async saveProjectState(state: TranslationProjectState): Promise<void> {
    await this.storage.saveProjectState(state);
  }

  async loadSavedRepetitionPatternAnalysis(): Promise<
    SavedRepetitionPatternAnalysisResult | undefined
  > {
    return this.storage.loadSavedRepetitionPatternAnalysis();
  }

  async loadTranslationDependencyGraph(): Promise<TranslationDependencyGraph | undefined> {
    return this.storage.loadTranslationDependencyGraph();
  }

  async saveTranslationDependencyGraph(graph: TranslationDependencyGraph): Promise<void> {
    await this.storage.saveTranslationDependencyGraph(graph);
  }

  async clearTranslationDependencyGraph(): Promise<void> {
    await this.storage.clearTranslationDependencyGraph();
  }

  async loadContextNetwork(): Promise<ContextNetworkData | undefined> {
    return loadContextNetwork(this.projectDir);
  }

  async saveContextNetwork(data: ContextNetworkData): Promise<void> {
    await saveContextNetwork(this.projectDir, data);
  }

  async clearContextNetwork(): Promise<void> {
    await clearContextNetwork(this.projectDir);
  }

  async saveSavedRepetitionPatternAnalysis(
    result: SavedRepetitionPatternAnalysisResult,
  ): Promise<void> {
    await this.storage.saveSavedRepetitionPatternAnalysis(result);
  }

  async clearSavedRepetitionPatternAnalysis(): Promise<void> {
    await this.storage.clearSavedRepetitionPatternAnalysis();
  }

  async updateTranslation(
    chapterId: number,
    fragmentIndex: number,
    translation: TextFragment | string | string[],
  ): Promise<void> {
    const fragment = this.getRequiredFragment(chapterId, fragmentIndex);
    fragment.translation = normalizeFragment(translation);
    await this.storage.updateFragmentTranslation(chapterId, fragmentIndex, fragment.translation);
  }

  async updateTranslatedLine(
    chapterId: number,
    fragmentIndex: number,
    lineIndex: number,
    translation: string,
  ): Promise<void> {
    const fragment = this.getRequiredFragment(chapterId, fragmentIndex);
    if (lineIndex < 0 || lineIndex >= fragment.source.lines.length) {
      throw new Error(
        `文本行不存在: chapter=${chapterId}, fragment=${fragmentIndex}, line=${lineIndex}`,
      );
    }

    fragment.translation.lines[lineIndex] = translation;
    await this.storage.updateTranslatedLine(chapterId, fragmentIndex, lineIndex, translation);
  }

  /**
   * 原子更新步骤状态与译文，确保二者在同一次写入中落盘，避免中途崩溃导致译文丢失。
   */
  async updateStepStateAndTranslation(
    chapterId: number,
    fragmentIndex: number,
    stepId: string,
    state: FragmentPipelineStepState,
    translation: TextFragment,
  ): Promise<void> {
    const fragment = this.getRequiredFragment(chapterId, fragmentIndex);
    fragment.pipelineStates[stepId] = state;
    fragment.translation = translation;
    await this.storage.saveStepStateAndTranslation(
      chapterId,
      fragmentIndex,
      stepId,
      state,
      translation,
    );
  }

  async updatePipelineStepState(
    chapterId: number,
    fragmentIndex: number,
    stepId: string,
    state: FragmentPipelineStepState,
  ): Promise<void> {
    const fragment = this.getRequiredFragment(chapterId, fragmentIndex);
    fragment.pipelineStates[stepId] = state;
    await this.storage.savePipelineStepState(chapterId, fragmentIndex, stepId, state);
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

    await this.storage.savePipelineStepStates(
      steps.map((stepRef) => ({
        chapterId: stepRef.chapterId,
        fragmentIndex: stepRef.fragmentIndex,
        stepId: stepRef.stepId,
        state: this.getRequiredFragment(stepRef.chapterId, stepRef.fragmentIndex).pipelineStates[
          stepRef.stepId
        ]!,
      })),
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
    const chapter = this.getChapterById(chapterId);
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
    return this.ensureChapterLoaded(chapterId);
  }

  getAllChapters(): ChapterEntry[] {
    return this.chapterOrder
      .map((chapterId) => this.ensureChapterLoaded(chapterId))
      .filter((chapter): chapter is ChapterEntry => Boolean(chapter));
  }

  getChapterFragmentCount(chapterId: number): number {
    return this.chapterIndexes.get(chapterId)?.fragmentHashes.length ?? 0;
  }

  getChapterFragmentRefs(chapterId: number): Array<{ chapterId: number; fragmentIndex: number }> {
    const fragmentCount = this.getChapterFragmentCount(chapterId);
    return Array.from({ length: fragmentCount }, (_value, fragmentIndex) => ({
      chapterId,
      fragmentIndex,
    }));
  }

  getSourceText(chapterId: number, fragmentIndex: number): string {
    return fragmentToText(this.getRequiredFragment(chapterId, fragmentIndex).source).replace(
      /<blank\/>/g,
      "",
    );
  }

  getTranslatedText(chapterId: number, fragmentIndex: number): string {
    return fragmentToText(this.getRequiredFragment(chapterId, fragmentIndex).translation).replace(
      /<blank\/>/g,
      "",
    );
  }

  getChapterSourceText(chapterId: number): string {
    return this.getChapterTranslationUnits(chapterId)
      .map((unit) => restoreBlankText(unit.source))
      .join("\n");
  }

  getChapterTranslatedText(chapterId: number): string {
    return this.getChapterTranslationUnits(chapterId)
      .map((unit) => restoreBlankText(unit.target.at(-1) ?? ""))
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
    await this.storage.updateFragmentTranslation(
      window.chapterId,
      window.fragmentIndex,
      fragment.translation,
    );
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
    options?: { fileHandler?: TranslationFileHandler; importTranslation?: boolean },
  ): Promise<ChapterEntry> {
    const fileHandler = options?.fileHandler ?? this.fileHandlerResolver?.(filePath);
    const rawUnits = fileHandler
      ? await fileHandler.readTranslationUnits(filePath)
      : this.parseUnits(await readFile(filePath, "utf8"));
    const units = options?.importTranslation
      ? rawUnits
      : rawUnits.map((unit) => ({ ...unit, target: [] }));
    const chapter = createChapterEntry(chapterId, filePath, this.textSplitter.split(units));

    this.setLoadedChapter(chapter);
    this.ensureChapterOrderContains(chapterId);
    await this.saveChapter(chapter);
    return chapter;
  }

  /**
   * 清除指定章节的译文与流水线状态，将各片段恢复为"待翻译"初始状态并持久化。
   */
  async clearChapterTranslations(chapterIds: number[]): Promise<void> {
    const affectedIds = [...new Set(chapterIds)];
    for (const chapterId of affectedIds) {
      const chapter = this.getChapterById(chapterId);
      if (!chapter) {
        continue;
      }
      for (const fragment of chapter.fragments) {
        resetFragmentToUntranslated(fragment);
      }
      await this.saveChapter(chapter);
    }
  }

  async reconcileImportedChapterTranslations(
    chapterIds: number[],
    options: {
      importTranslation: boolean;
      pipelineStepIds: string[];
      finalStepId: string;
    },
  ): Promise<void> {
    const affectedIds = [...new Set(chapterIds)];
    const completedAt = new Date().toISOString();

    for (const chapterId of affectedIds) {
      const chapter = this.getChapterById(chapterId);
      if (!chapter) {
        continue;
      }

      for (const fragment of chapter.fragments) {
        if (!options.importTranslation) {
          resetFragmentToUntranslated(fragment);
          continue;
        }

        const normalizedLines = fragment.source.lines.map((_sourceLine, lineIndex) => {
          const translation = fragment.translation.lines[lineIndex];
          return hasTranslatedLine(translation) ? translation : "";
        });
        const isFullyTranslated =
          normalizedLines.length === fragment.source.lines.length &&
          normalizedLines.every((line) => hasTranslatedLine(line));

        if (!isFullyTranslated) {
          resetFragmentToUntranslated(fragment);
          continue;
        }

        fragment.translation = createTextFragment(normalizedLines);
        if (fragment.meta) {
          fragment.meta.targetGroups = normalizedLines.map((line, lineIndex) => {
            const nextGroup = [...(fragment.meta?.targetGroups?.[lineIndex] ?? [])];
            if (nextGroup.length === 0) {
              nextGroup.push(line);
            } else {
              nextGroup[nextGroup.length - 1] = line;
            }
            return nextGroup;
          });
        }
        fragment.pipelineStates = createCompletedPipelineStates(
          options.pipelineStepIds,
          options.finalStepId,
          fragment.translation,
          completedAt,
        );
      }

      await this.saveChapter(chapter);
    }
  }

  /**
   * 移除章节：从内存中删除章节数据和哈希索引，并删除磁盘上的数据文件。
   */
  async removeChapter(chapterId: number): Promise<void> {
    this.deleteChapterIndex(chapterId);
    this.chapters.delete(chapterId);
    this.chapterOrder = this.chapterOrder.filter((id) => id !== chapterId);
    await this.storage.deleteChapter(chapterId);
  }

  /**
   * 从磁盘加载工作区配置文件。文件不存在时返回 undefined。
   */
  async loadWorkspaceConfig(): Promise<WorkspaceConfig | undefined> {
    return this.storage.loadWorkspaceConfig();
  }

  /**
   * 将工作区配置持久化到磁盘。
   *
   * 配置以紧凑 JSON 存储（不考虑可读性，优先 API 交互友好性）。
   */
  async saveWorkspaceConfig(config: WorkspaceConfig): Promise<void> {
    await this.storage.saveWorkspaceConfig(config);
    await saveWorkspaceBootstrap(
      this.projectDir,
      buildWorkspaceBootstrapDocument(config.projectName),
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
    const chapter = createChapterEntry(chapterId, filePath, this.textSplitter.split(units));

    this.setLoadedChapter(chapter);
    await this.saveChapter(chapter);
  }

  private ensureChapterOrderContains(chapterId: number): void {
    if (!this.chapterOrder.includes(chapterId)) {
      this.chapterOrder.push(chapterId);
    }
  }

  private ensureChapterLoaded(chapterId: number): ChapterEntry | undefined {
    const existing = this.chapters.get(chapterId);
    if (existing) {
      return existing;
    }

    const persistedChapter = this.storage.loadChapterSync(chapterId);
    if (!persistedChapter) {
      return undefined;
    }

    this.setLoadedChapter(persistedChapter);
    return persistedChapter;
  }

  private setLoadedChapter(chapter: ChapterEntry): void {
    this.chapters.set(chapter.id, chapter);
    this.setChapterIndex({
      chapterId: chapter.id,
      filePath: chapter.filePath,
      fragmentHashes: chapter.fragments.map((fragment) => fragment.hash),
    });
  }

  private setChapterIndex(index: PersistedChapterIndex): void {
    this.deleteChapterIndex(index.chapterId);
    this.chapterIndexes.set(index.chapterId, {
      filePath: index.filePath,
      fragmentHashes: [...index.fragmentHashes],
    });
    this.ensureChapterOrderContains(index.chapterId);
    for (const [fragmentIndex, hash] of index.fragmentHashes.entries()) {
      this.hashIndex.set(hash, {
        chapterId: index.chapterId,
        fragmentIndex,
      });
    }
  }

  private deleteChapterIndex(chapterId: number): void {
    const existingIndex = this.chapterIndexes.get(chapterId);
    if (!existingIndex) {
      return;
    }

    for (const hash of existingIndex.fragmentHashes) {
      this.hashIndex.delete(hash);
    }
    this.chapterIndexes.delete(chapterId);
  }

  private getRequiredChapter(chapterId: number): ChapterEntry {
    const chapter = this.getChapterById(chapterId);
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

  private async saveChapter(chapter: ChapterEntry): Promise<void> {
    await this.storage.saveChapter(chapter);
    this.setChapterIndex({
      chapterId: chapter.id,
      filePath: chapter.filePath,
      fragmentHashes: chapter.fragments.map((fragment) => fragment.hash),
    });
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
    proofreadTask: normalizePersistedProofreadTaskState(state.proofreadTask),
  };
}

function normalizePersistedProofreadTaskState(
  state: ProofreadTaskState | undefined,
): ProofreadTaskState | undefined {
  if (!state) {
    return undefined;
  }

  return {
    taskId: state.taskId,
    mode: state.mode === "simultaneous" ? "simultaneous" : "linear",
    status: state.status ?? "paused",
    chapterIds: Array.isArray(state.chapterIds)
      ? state.chapterIds.map((value) => Number(value)).filter(Number.isFinite)
      : [],
    chapters: Array.isArray(state.chapters)
      ? state.chapters
          .map((chapter) => ({
            chapterId: Number(chapter.chapterId),
            fragmentCount: Math.max(0, Number(chapter.fragmentCount) || 0),
          }))
          .filter((chapter) => Number.isFinite(chapter.chapterId))
      : [],
    totalChapters: Math.max(0, Number(state.totalChapters) || 0),
    completedChapters: Math.max(0, Number(state.completedChapters) || 0),
    totalBatches: Math.max(0, Number(state.totalBatches) || 0),
    completedBatches: Math.max(0, Number(state.completedBatches) || 0),
    nextChapterIndex: Math.max(0, Number(state.nextChapterIndex) || 0),
    nextFragmentIndex: Math.max(0, Number(state.nextFragmentIndex) || 0),
    currentChapterId:
      state.currentChapterId !== undefined ? Number(state.currentChapterId) : undefined,
    warningCount: Math.max(0, Number(state.warningCount) || 0),
    lastWarningMessage: state.lastWarningMessage,
    abortRequested: Boolean(state.abortRequested),
    errorMessage: state.errorMessage,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
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
  if (isBlankSourceText(sourceLine)) {
    return normalizeBlankSourceUnit({
      source: sourceLine,
      target: [],
      metadata: metadataList[lineIndex] ?? null,
    });
  }
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
  const normalizedUnits = fragmentUnits.map((unit) => normalizeBlankSourceUnit(unit));
  const source = createTextFragment(normalizedUnits.map((unit) => unit.source));
  return {
    source,
    translation: createTextFragment(
      normalizedUnits.map((unit) => unit.target.at(-1) ?? ""),
    ),
    pipelineStates: {},
    meta: {
      metadataList: normalizedUnits.map((unit) => unit.metadata ?? null),
      targetGroups: normalizedUnits.map((unit) => [...unit.target]),
    },
    hash: computeHash(source),
  };
}

function resetFragmentToUntranslated(fragment: FragmentEntry): void {
  fragment.translation = {
    lines: fragment.source.lines.map((sourceLine) =>
      isBlankSourceText(sourceLine) ? "<blank/>" : "",
    ),
  };
  fragment.pipelineStates = {};
  if (fragment.meta) {
    fragment.meta.targetGroups = fragment.source.lines.map(() => []);
  }
}

function createCompletedPipelineStates(
  stepIds: string[],
  finalStepId: string,
  translation: TextFragment,
  completedAt: string,
): Record<string, FragmentPipelineStepState> {
  return Object.fromEntries(
    stepIds.map((stepId, index) => [
      stepId,
      {
        status: "completed",
        queueSequence: index + 1,
        attemptCount: 1,
        queuedAt: completedAt,
        startedAt: completedAt,
        completedAt,
        updatedAt: completedAt,
        output:
          stepId === finalStepId
            ? createTextFragment([...translation.lines])
            : createTextFragment([...translation.lines]),
      } satisfies FragmentPipelineStepState,
    ]),
  );
}

function hasTranslatedLine(line: string | undefined): line is string {
  return typeof line === "string" && line.trim().length > 0;
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
