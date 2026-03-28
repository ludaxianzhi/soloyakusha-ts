import { readFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type {
  TranslationFileHandler,
} from "../file-handlers/base.ts";
import { TranslationFileHandlerFactory } from "../file-handlers/factory.ts";
import { Glossary, GlossaryPersisterFactory } from "../glossary/index.ts";
import type { TranslationDocumentManager } from "./translation-document-manager.ts";
import type {
  Chapter,
  GlossaryImportResult,
  TranslationExportResult,
  TranslationImportResult,
  TranslationProjectConfig,
  WorkspaceChapterDescriptor,
  WorkspaceConfig,
  WorkspaceConfigPatch,
  WorkspaceFileManifest,
} from "./types.ts";

export class TranslationProjectWorkspace {
  constructor(
    private readonly projectDir: string,
    private readonly config: TranslationProjectConfig,
    private readonly documentManager: TranslationDocumentManager,
    private readonly chapters: Chapter[],
    private readonly getWorkspaceConfigState: () => WorkspaceConfig,
    private readonly setWorkspaceConfigState: (config: WorkspaceConfig) => void,
    private readonly getGlossaryState: () => Glossary | undefined,
    private readonly setGlossaryState: (glossary: Glossary | undefined) => void,
    private readonly resolveFileHandler: (
      filePath: string,
      options?: { format?: string; fileHandler?: TranslationFileHandler },
      defaultFormat?: string,
    ) => TranslationFileHandler | undefined,
    private readonly onChapterStructureChanged: () => Promise<void>,
    private readonly onProjectMutation: () => Promise<void>,
  ) {}

  getWorkspaceConfig(): WorkspaceConfig {
    return cloneWorkspaceConfig(this.getWorkspaceConfigState());
  }

  async updateWorkspaceConfig(
    patch: WorkspaceConfigPatch,
  ): Promise<WorkspaceConfig> {
    const nextConfig = applyWorkspaceConfigPatch(this.getWorkspaceConfigState(), patch);
    this.setWorkspaceConfigState(nextConfig);
    await this.documentManager.saveWorkspaceConfig(nextConfig);
    return this.getWorkspaceConfig();
  }

  getChapterDescriptors(): WorkspaceChapterDescriptor[] {
    return this.chapters.map((chapter) => this.getRequiredChapterDescriptor(chapter.id));
  }

  getChapterDescriptor(chapterId: number): WorkspaceChapterDescriptor | undefined {
    if (!this.chapters.some((chapter) => chapter.id === chapterId)) {
      return undefined;
    }

    return this.getRequiredChapterDescriptor(chapterId);
  }

  async addChapter(
    chapterId: number,
    filePath: string,
    options?: {
      format?: string;
      fileHandler?: TranslationFileHandler;
    },
  ): Promise<TranslationImportResult> {
    if (this.chapters.some((chapter) => chapter.id === chapterId)) {
      throw new Error(`章节 ${chapterId} 已存在`);
    }

    const resolvedPath = resolveChapterPath(this.projectDir, filePath);
    const workspaceConfig = this.getWorkspaceConfigState();
    const fileHandler = this.resolveFileHandler(
      resolvedPath,
      options,
      workspaceConfig.defaultImportFormat,
    );
    const chapter = await this.documentManager.addChapter(chapterId, resolvedPath, {
      fileHandler,
    });

    this.chapters.push({ id: chapterId, filePath });
    await this.persistChapterOrder();
    await this.onChapterStructureChanged();

    return {
      chapterId,
      filePath,
      unitCount: chapter.fragments.reduce(
        (sum, fragment) => sum + fragment.source.lines.length,
        0,
      ),
      fragmentCount: chapter.fragments.length,
    };
  }

  async removeChapter(chapterId: number): Promise<void> {
    const index = this.chapters.findIndex((chapter) => chapter.id === chapterId);
    if (index === -1) {
      throw new Error(`章节 ${chapterId} 不存在`);
    }

    await this.documentManager.removeChapter(chapterId);
    this.chapters.splice(index, 1);
    await this.persistChapterOrder();
    await this.onProjectMutation();
  }

  async reorderChapters(chapterIds: number[]): Promise<void> {
    const existingIds = new Set(this.chapters.map((chapter) => chapter.id));
    for (const id of chapterIds) {
      if (!existingIds.has(id)) {
        throw new Error(`章节 ${id} 不存在`);
      }
    }
    if (new Set(chapterIds).size !== this.chapters.length) {
      throw new Error("重排序列表必须恰好包含所有章节且不重复");
    }

    const chapterMap = new Map(this.chapters.map((chapter) => [chapter.id, chapter]));
    this.chapters.length = 0;
    for (const id of chapterIds) {
      this.chapters.push(chapterMap.get(id)!);
    }

    await this.persistChapterOrder();
  }

  async exportChapter(
    chapterId: number,
    outputPath: string,
    options?: {
      format?: string;
      fileHandler?: TranslationFileHandler;
    },
  ): Promise<TranslationExportResult> {
    const resolvedPath = resolveChapterPath(this.projectDir, outputPath);
    const workspaceConfig = this.getWorkspaceConfigState();
    const fileHandler = this.resolveFileHandler(
      resolvedPath,
      options,
      workspaceConfig.defaultExportFormat,
    );
    if (!fileHandler) {
      throw new Error(
        `无法确定导出格式，请通过 format 或 fileHandler 指定: ${outputPath}`,
      );
    }

    const units = this.documentManager.getChapterTranslationUnits(chapterId);
    await this.documentManager.exportChapter(chapterId, resolvedPath, fileHandler);
    return {
      chapterId,
      outputPath: resolvedPath,
      unitCount: units.length,
    };
  }

  async exportAllChapters(
    outputDir: string,
    options?: {
      format?: string;
      fileHandler?: TranslationFileHandler;
      fileExtension?: string;
    },
  ): Promise<TranslationExportResult[]> {
    const resolvedDir = resolveChapterPath(this.projectDir, outputDir);
    const results: TranslationExportResult[] = [];

    for (const chapter of this.chapters) {
      const ext =
        options?.fileExtension ??
        getExportFileExtension(chapter.filePath, options?.format);
      const base = basename(chapter.filePath, extname(chapter.filePath));
      const outputPath = join(resolvedDir, `${base}${ext}`);
      results.push(await this.exportChapter(chapter.id, outputPath, options));
    }

    return results;
  }

  async importGlossary(filePath: string): Promise<GlossaryImportResult> {
    const resolvedPath = resolveChapterPath(this.projectDir, filePath);
    const persister = GlossaryPersisterFactory.getPersister(resolvedPath);
    const importedGlossary = await persister.loadGlossary(resolvedPath);
    const importedTerms = importedGlossary.getAllTerms();

    let glossary = this.getGlossaryState();
    glossary ??= new Glossary();
    this.setGlossaryState(glossary);

    const existingTerms = new Set(glossary.getAllTerms().map((term) => term.term));
    let newTermCount = 0;
    let updatedTermCount = 0;

    for (const term of importedTerms) {
      if (existingTerms.has(term.term)) {
        glossary.updateTerm(term.term, term);
        updatedTermCount += 1;
      } else {
        glossary.addTerm(term);
        newTermCount += 1;
      }
    }

    await this.saveGlossaryIfNeeded();

    return {
      filePath: resolvedPath,
      termCount: importedTerms.length,
      newTermCount,
      updatedTermCount,
    };
  }

  async exportGlossary(outputPath: string): Promise<void> {
    const glossary = this.getGlossaryState();
    if (!glossary) {
      throw new Error("当前项目没有术语表");
    }

    const resolvedPath = resolveChapterPath(this.projectDir, outputPath);
    const persister = GlossaryPersisterFactory.getPersister(resolvedPath);
    await persister.saveGlossary(glossary, resolvedPath);
  }

  getWorkspaceFileManifest(): WorkspaceFileManifest {
    const glossaryPath = this.getResolvedGlossaryPath();

    return {
      projectDir: this.projectDir,
      configPath: this.documentManager.workspaceConfigPath,
      projectStatePath: this.documentManager.projectStatePath,
      glossaryPath,
      chapters: this.chapters.map((chapter) => ({
        id: chapter.id,
        sourceFilePath: resolveChapterPath(this.projectDir, chapter.filePath),
        dataFilePath: join(this.documentManager.dataDir, `${chapter.id}.json`),
      })),
    };
  }

  async saveGlossaryIfNeeded(): Promise<void> {
    const glossary = this.getGlossaryState();
    const glossaryPath = this.getResolvedGlossaryPath();
    if (!glossary || !glossaryPath) {
      return;
    }

    await GlossaryPersisterFactory.getPersister(glossaryPath).saveGlossary(
      glossary,
      glossaryPath,
    );
  }

  private getResolvedGlossaryPath(): string | undefined {
    const glossaryPath = this.getWorkspaceConfigState().glossary.path?.trim();
    if (!glossaryPath) {
      return undefined;
    }

    return resolveChapterPath(this.projectDir, glossaryPath);
  }

  private async persistChapterOrder(): Promise<void> {
    const nextConfig = {
      ...this.getWorkspaceConfigState(),
      chapters: this.chapters.map((chapter) => ({
        id: chapter.id,
        filePath: chapter.filePath,
      })),
    };
    this.setWorkspaceConfigState(nextConfig);
    await this.documentManager.saveWorkspaceConfig(nextConfig);
  }

  private getRequiredChapterDescriptor(chapterId: number): WorkspaceChapterDescriptor {
    const chapter = this.documentManager.getChapterById(chapterId);
    const chapterConfig = this.chapters.find((currentChapter) => currentChapter.id === chapterId);
    if (!chapter || !chapterConfig) {
      throw new Error(`章节 ${chapterId} 不存在`);
    }

    const sourceLineCount = chapter.fragments.reduce(
      (sum, fragment) => sum + fragment.source.lines.length,
      0,
    );
    const translatedLineCount = chapter.fragments.reduce(
      (sum, fragment) =>
        sum + fragment.translation.lines.filter((line) => line.length > 0).length,
      0,
    );

    return {
      id: chapterId,
      filePath: chapterConfig.filePath,
      fragmentCount: chapter.fragments.length,
      sourceLineCount,
      translatedLineCount,
      hasTranslationData: translatedLineCount > 0,
    };
  }
}

export async function openWorkspaceConfig(
  projectDir: string,
): Promise<WorkspaceConfig> {
  const resolvedDir = resolve(projectDir);
  const configPath = join(resolvedDir, "Data", "workspace-config.json");

  try {
    const content = await readFile(configPath, "utf8");
    return JSON.parse(content) as WorkspaceConfig;
  } catch {
    throw new Error(`工作区配置不存在: ${configPath}`);
  }
}

export function resolveFileHandlerFromOptions(
  filePath: string,
  options?: { format?: string; fileHandler?: TranslationFileHandler },
  defaultFormat?: string,
): TranslationFileHandler | undefined {
  if (options?.fileHandler) {
    return options.fileHandler;
  }

  const format = options?.format ?? defaultFormat;
  if (format) {
    return TranslationFileHandlerFactory.getHandler(format);
  }

  return undefined;
}

export function resolveChapterPath(projectDir: string, path: string): string {
  return resolve(projectDir, path);
}

export function buildInitialWorkspaceConfig(
  config: TranslationProjectConfig,
  chapters: Chapter[],
): WorkspaceConfig {
  return {
    schemaVersion: 1,
    projectName: config.projectName,
    chapters: chapters.map((chapter) => ({ id: chapter.id, filePath: chapter.filePath })),
    glossary: {
      path: config.glossary?.path,
      autoFilter: config.glossary?.autoFilter,
    },
    translator: {},
    slidingWindow: {},
    customRequirements: [...(config.customRequirements ?? [])],
  };
}

export function mergePersistedWorkspaceConfig(
  current: WorkspaceConfig,
  persisted: WorkspaceConfig,
): WorkspaceConfig {
  return {
    ...current,
    glossary: {
      ...current.glossary,
      ...persisted.glossary,
    },
    translator: {
      ...current.translator,
      ...persisted.translator,
    },
    slidingWindow: {
      ...current.slidingWindow,
      ...persisted.slidingWindow,
    },
    contextSize: persisted.contextSize ?? current.contextSize,
    defaultImportFormat: persisted.defaultImportFormat ?? current.defaultImportFormat,
    defaultExportFormat: persisted.defaultExportFormat ?? current.defaultExportFormat,
  };
}

export function applyWorkspaceConfigPatch(
  config: WorkspaceConfig,
  patch: WorkspaceConfigPatch,
): WorkspaceConfig {
  let nextTranslator = config.translator;
  if (patch.translator !== undefined) {
    const translatorName =
      patch.translator.translatorName === null
        ? undefined
        : (patch.translator.translatorName ?? config.translator.translatorName);
    nextTranslator = { translatorName };
  }

  return {
    ...config,
    projectName: patch.projectName ?? config.projectName,
    glossary: patch.glossary
      ? { ...config.glossary, ...patch.glossary }
      : config.glossary,
    translator: nextTranslator,
    slidingWindow: patch.slidingWindow
      ? { ...config.slidingWindow, ...patch.slidingWindow }
      : config.slidingWindow,
    contextSize:
      patch.contextSize === null
        ? undefined
        : (patch.contextSize ?? config.contextSize),
    customRequirements: patch.customRequirements ?? config.customRequirements,
    defaultImportFormat:
      patch.defaultImportFormat === null
        ? undefined
        : (patch.defaultImportFormat ?? config.defaultImportFormat),
    defaultExportFormat:
      patch.defaultExportFormat === null
        ? undefined
        : (patch.defaultExportFormat ?? config.defaultExportFormat),
  };
}

export function cloneWorkspaceConfig(config: WorkspaceConfig): WorkspaceConfig {
  return {
    ...config,
    chapters: config.chapters.map((chapter) => ({ ...chapter })),
    glossary: { ...config.glossary },
    translator: { ...config.translator },
    slidingWindow: { ...config.slidingWindow },
    customRequirements: [...config.customRequirements],
  };
}

const FORMAT_FILE_EXTENSIONS: Record<string, string> = {
  plain_text: ".txt",
  naturedialog: ".txt",
  naturedialog_keepname: ".txt",
  m3t: ".m3t",
  galtransl_json: ".json",
};

export function getExportFileExtension(
  originalFilePath: string,
  format?: string,
): string {
  if (format) {
    return FORMAT_FILE_EXTENSIONS[format] ?? `.${format}`;
  }

  return extname(originalFilePath) || ".txt";
}
