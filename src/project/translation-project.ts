/**
 * 负责翻译项目初始化、任务遍历、上下文构建接入与结果提交协调。
 */

import type { TranslationFileHandlerResolver } from "../file-handlers/base.ts";
import { Glossary, GlossaryPersisterFactory } from "../glossary/index.ts";
import { resolve } from "node:path";
import { TranslationContextView } from "./context-view.ts";
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
