import type { TranslationFileHandlerResolver } from "../file-handlers/base.ts";
import { resolve } from "node:path";
import { PrebuiltContextRetriever } from "./context-index.ts";
import { TranslationContextView } from "./context-view.ts";
import { TranslationDocumentManager } from "./translation-document-manager.ts";
import { TopologyPersister } from "./topology-persister.ts";
import { TranslationTopology } from "./topology.ts";
import type {
  ProjectCursor,
  TranslationProjectConfig,
  TranslationTask,
  TranslationUnitParser,
  TranslationUnitSplitter,
  TranslationResult,
} from "./types.ts";
import { ProjectProgress } from "./types.ts";

export class TranslationProject {
  private readonly projectDir: string;
  private readonly documentManager: TranslationDocumentManager;
  private readonly topologyPersister: TopologyPersister;
  private topology?: TranslationTopology;
  private contextRetriever?: PrebuiltContextRetriever;
  private initialized = false;
  private currentCursor: ProjectCursor = {};

  constructor(
    private readonly config: TranslationProjectConfig,
    options: {
      textSplitter?: TranslationUnitSplitter;
      parseUnits?: TranslationUnitParser;
      fileHandlerResolver?: TranslationFileHandlerResolver;
      documentManager?: TranslationDocumentManager;
      topologyPersister?: TopologyPersister;
      contextRetriever?: PrebuiltContextRetriever;
    } = {},
  ) {
    this.projectDir = resolve(config.projectDir);
    this.documentManager =
      options.documentManager ??
      new TranslationDocumentManager(this.projectDir, {
        textSplitter: options.textSplitter,
        parseUnits: options.parseUnits,
        fileHandlerResolver: options.fileHandlerResolver,
      });
    this.topologyPersister = options.topologyPersister ?? new TopologyPersister();
    this.contextRetriever = options.contextRetriever;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.topology = await this.loadTopology();
    await this.documentManager.loadChapters(
      this.topology.getAllChapters().map((chapter) => ({
        chapterId: chapter.id,
        filePath: resolveChapterPath(this.projectDir, chapter.filePath),
      })),
    );

    if (!this.contextRetriever && this.config.context?.indexPath) {
      this.contextRetriever = new PrebuiltContextRetriever({
        indexPath: resolveChapterPath(this.projectDir, this.config.context.indexPath),
        retrieveK: this.config.context.retrieveK ?? 5,
      });
    }

    if (this.contextRetriever) {
      await this.contextRetriever.load();
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
      topology: this.topology,
      contextRetriever: this.contextRetriever,
      context: this.config.context,
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
    if (!this.initialized || !this.topology) {
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

  getTopology(): TranslationTopology | undefined {
    return this.topology;
  }

  private async loadTopology(): Promise<TranslationTopology> {
    if (this.config.topology) {
      const topology = new TranslationTopology();
      topology.loadFromConfig(this.config.topology);
      return topology;
    }

    if (!this.config.topologyPath) {
      throw new Error("必须通过 topology 或 topologyPath 提供项目拓扑");
    }

    return this.topologyPersister.loadTopology(
      resolveChapterPath(this.projectDir, this.config.topologyPath),
    );
  }

  private getTraversalChapters() {
    return this.topology?.getDfsOrderedChapters() ?? [];
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
