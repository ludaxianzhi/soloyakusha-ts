/**
 * 负责翻译项目初始化、任务遍历、上下文构建接入与结果提交协调。
 *
 * 本模块是翻译项目的核心协调器，串联以下组件：
 * - {@link TranslationDocumentManager}: 章节加载、片段切分、持久化
 * - {@link Glossary}: 术语表加载与筛选
 * - {@link TranslationContextView}: 上下文视图构建
 *
 * 典型使用流程：
 * 1. 创建项目实例，传入配置与可选的自定义组件
 * 2. 调用 initialize() 加载章节和术语表
 * 3. 通过 iterTasks() 或 getNextTask() 获取待翻译任务
 * 4. 将翻译结果通过 submitResult() 提交
 * 5. 定期调用 saveProgress() 保存进度
 *
 * @module project/translation-project
 */

import type { TranslationFileHandlerResolver } from "../file-handlers/base.ts";
import { Glossary, GlossaryPersisterFactory } from "../glossary/index.ts";
import { resolve } from "node:path";
import { TranslationContextView } from "./context-view.ts";
import type {
  GlobalAssociationPattern,
  GlobalAssociationPatternScanOptions,
  GlobalAssociationPatternScanResult,
} from "./global-pattern-scanner.ts";
import { GlobalAssociationPatternScanner } from "./global-pattern-scanner.ts";
import { TranslationDocumentManager } from "./translation-document-manager.ts";
import type {
  Chapter,
  ProjectCursor,
  TranslationResult,
  TranslationProjectConfig,
  TranslationTask,
  TranslationUnitParser,
  TranslationUnitSplitter,
} from "./types.ts";
import { ProjectProgress } from "./types.ts";

/**
 * 翻译项目协调器，串联章节初始化、任务遍历、上下文构建与结果提交。
 *
 * 该类是翻译项目的顶级入口，负责：
 * - 管理章节列表的遍历顺序
 * - 维护当前翻译位置游标
 * - 协调文档管理器与术语表的交互
 * - 提供翻译任务的上下文视图构建
 *
 * 支持两种任务获取方式：
 * - {@link getNextTask}: 每次返回下一个待翻译任务，适合手动控制流程
 * - {@link iterTasks}: 异步迭代器，适合 for-await-of 循环处理
 *
 * @example
 * ```typescript
 * const project = new TranslationProject(config);
 * await project.initialize();
 *
 * for await (const task of project.iterTasks()) {
 *   const result = await translate(task);
 *   await project.submitResult(result);
 * }
 *
 * await project.saveProgress();
 * ```
 */
export class TranslationProject {
  private readonly projectDir: string;
  private readonly chapters: Chapter[];
  private readonly documentManager: TranslationDocumentManager;
  private glossary?: Glossary;
  private initialized = false;
  private currentCursor: ProjectCursor = {};

  constructor(
    private readonly config: TranslationProjectConfig,
    options: {
      textSplitter?: TranslationUnitSplitter;
      parseUnits?: TranslationUnitParser;
      fileHandlerResolver?: TranslationFileHandlerResolver;
      documentManager?: TranslationDocumentManager;
      glossary?: Glossary;
    } = {},
  ) {
    this.projectDir = resolve(config.projectDir);
    this.chapters = [...config.chapters];
    this.documentManager =
      options.documentManager ??
      new TranslationDocumentManager(this.projectDir, {
        textSplitter: options.textSplitter,
        parseUnits: options.parseUnits,
        fileHandlerResolver: options.fileHandlerResolver,
      });
    this.glossary = options.glossary;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.chapters.length === 0) {
      throw new Error("必须通过 chapters 提供线性章节列表");
    }

    await this.documentManager.loadChapters(
      this.chapters.map((chapter) => ({
        chapterId: chapter.id,
        filePath: resolveChapterPath(this.projectDir, chapter.filePath),
      })),
    );

    if (!this.glossary && this.config.glossary?.path) {
      const glossaryPath = resolveChapterPath(this.projectDir, this.config.glossary.path);
      this.glossary = await GlossaryPersisterFactory.getPersister(
        glossaryPath,
      ).loadGlossary(glossaryPath);
    }

    this.initialized = true;
  }

  async getNextTask(): Promise<TranslationTask | undefined> {
    this.ensureInitialized();
    for (const chapter of this.getTraversalChapters()) {
      const chapterEntry = this.documentManager.getChapterById(chapter.id);
      if (!chapterEntry) {
        continue;
      }

      for (const [fragmentIndex, fragment] of chapterEntry.fragments.entries()) {
        if (fragment.isTranslated) {
          continue;
        }

        this.currentCursor = {
          chapterId: chapter.id,
          fragmentIndex,
        };
        return this.buildTask(chapter.id, fragmentIndex);
      }
    }

    return undefined;
  }

  async *iterTasks(): AsyncGenerator<TranslationTask, void, undefined> {
    this.ensureInitialized();
    for (const chapter of this.getTraversalChapters()) {
      const chapterEntry = this.documentManager.getChapterById(chapter.id);
      if (!chapterEntry) {
        continue;
      }

      for (const [fragmentIndex, fragment] of chapterEntry.fragments.entries()) {
        if (fragment.isTranslated) {
          continue;
        }

        this.currentCursor = {
          chapterId: chapter.id,
          fragmentIndex,
        };
        yield this.buildTask(chapter.id, fragmentIndex);
      }
    }
  }

  async buildTask(chapterId: number, fragmentIndex: number): Promise<TranslationTask> {
    this.ensureInitialized();
    const contextView = this.getContextView(chapterId, fragmentIndex);

    return {
      chapterId,
      fragmentIndex,
      sourceText: contextView.sourceText,
      contextView,
      requirements: [...(this.config.customRequirements ?? [])],
    };
  }

  getContextView(
    chapterId: number,
    fragmentIndex: number,
  ): TranslationContextView {
    this.ensureInitialized();
    return new TranslationContextView(chapterId, fragmentIndex, {
      documentManager: this.documentManager,
      context: this.config.context,
      glossary: this.glossary,
      glossaryConfig: this.config.glossary,
    });
  }

  async submitResult(result: TranslationResult): Promise<void> {
    this.ensureInitialized();

    if (result.success === false) {
      return;
    }

    await this.documentManager.updateTranslation(
      result.chapterId,
      result.fragmentIndex,
      result.translatedText ?? "",
    );
  }

  getProgress(): ProjectProgress {
    if (!this.initialized) {
      return new ProjectProgress();
    }

    const traversalChapters = this.getTraversalChapters();
    const { translatedFragments, totalFragments } =
      this.documentManager.getTranslationProgress();

    let translatedChapters = 0;
    for (const chapter of traversalChapters) {
      const chapterEntry = this.documentManager.getChapterById(chapter.id);
      if (!chapterEntry) {
        continue;
      }

      if (chapterEntry.fragments.every((fragment) => fragment.isTranslated)) {
        translatedChapters += 1;
      }
    }

    return new ProjectProgress(
      traversalChapters.length,
      translatedChapters,
      totalFragments,
      translatedFragments,
      this.currentCursor.chapterId,
      this.currentCursor.fragmentIndex,
    );
  }

  scanGlobalAssociationPatterns(
    options: GlobalAssociationPatternScanOptions = {},
  ): GlobalAssociationPatternScanResult {
    this.ensureInitialized();

    const scanner = new GlobalAssociationPatternScanner();
    const sourceText = this.getTraversalChapters()
      .map((chapter) => this.documentManager.getChapterSourceText(chapter.id))
      .join("\n");
    const result = scanner.scanText(sourceText, options);

    this.glossary ??= new Glossary();
    for (const pattern of result.patterns) {
      upsertGlobalPatternTerm(this.glossary, pattern);
    }
    this.glossary.updateOccurrenceStats(
      collectSourceTextBlocks(this.documentManager, this.getTraversalChapters()),
    );

    return result;
  }

  async saveProgress(): Promise<void> {
    this.ensureInitialized();
    await this.documentManager.saveChapters();
  }

  getDocumentManager(): TranslationDocumentManager {
    return this.documentManager;
  }

  getGlossary(): Glossary | undefined {
    return this.glossary;
  }

  private getTraversalChapters() {
    return [...this.chapters];
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("项目尚未初始化，请先调用 initialize()");
    }
  }
}

function resolveChapterPath(projectDir: string, path: string): string {
  return resolve(projectDir, path);
}

function upsertGlobalPatternTerm(
  glossary: Glossary,
  pattern: GlobalAssociationPattern,
): void {
  const existing = glossary.getTerm(pattern.text);
  if (!existing) {
    glossary.addTerm({
      term: pattern.text,
      translation: "",
      status: "untranslated",
      totalOccurrenceCount: pattern.occurrenceCount,
      description: "全局关联模式",
    });
    return;
  }

  glossary.updateTerm(pattern.text, {
    ...existing,
    description: existing.description ?? "全局关联模式",
    totalOccurrenceCount: pattern.occurrenceCount,
  });
}

function collectSourceTextBlocks(
  documentManager: TranslationDocumentManager,
  chapters: Chapter[],
): Array<{ blockId: string; text: string }> {
  return chapters.flatMap((chapter) =>
    (documentManager.getChapterById(chapter.id)?.fragments ?? []).map((fragment, fragmentIndex) => ({
      blockId: `chapter:${chapter.id}:fragment:${fragmentIndex}`,
      text: fragment.source.lines.join("\n"),
    })),
  );
}
