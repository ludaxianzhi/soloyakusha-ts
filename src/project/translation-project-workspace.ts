import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  TranslationFileHandler,
} from "../file-handlers/base.ts";
import { TranslationFileHandlerFactory } from "../file-handlers/factory.ts";
import { Glossary, GlossaryPersisterFactory } from "../glossary/index.ts";
import { getContextNetworkDirectoryPath } from "./context-network-storage.ts";
import { SqliteProjectStorage } from "./sqlite-project-storage.ts";
import type { TranslationDocumentManager } from "./translation-document-manager.ts";
import type {
  Chapter,
  GlossaryImportResult,
  WorkspaceDependencyTrackingConfig,
  TranslationExportResult,
  TranslationImportResult,
  TranslationProjectConfig,
  WorkspaceChapterDescriptor,
  WorkspaceConfig,
  WorkspaceConfigPatch,
  WorkspaceFileManifest,
} from "./types.ts";

export const WORKSPACE_BOOTSTRAP_SCHEMA_VERSION = 2;
export const DEFAULT_WORKSPACE_DATABASE_FILE_PATH = "Data\\project.sqlite";

export type WorkspaceBootstrapDocument = {
  schemaVersion: typeof WORKSPACE_BOOTSTRAP_SCHEMA_VERSION;
  storage: "sqlite";
  projectName: string;
  databasePath: string;
};

type WorkspaceBootstrapInspection =
  | {
      kind: "current";
      document: WorkspaceBootstrapDocument;
    }
  | {
      kind: "deprecated";
      projectName?: string;
      message: string;
    }
  | {
      kind: "missing";
    };

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

  async updateDependencyTracking(
    update: (
      current: WorkspaceDependencyTrackingConfig,
    ) => WorkspaceDependencyTrackingConfig,
  ): Promise<WorkspaceConfig> {
    const currentConfig = this.getWorkspaceConfigState();
    const nextConfig = {
      ...currentConfig,
      dependencyTracking: update(resolveDependencyTracking(currentConfig)),
    };
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
      importTranslation?: boolean;
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
      importTranslation: options?.importTranslation,
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

    const removedChapter = this.chapters[index]!;
    await this.documentManager.removeChapter(chapterId);
    this.chapters.splice(index, 1);
    await this.persistChapterOrder();
    await this.cleanupOrphanedSourceFile(removedChapter.filePath);
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
      bootstrapPath: this.documentManager.workspaceConfigPath,
      databasePath: this.documentManager.databasePath,
      contextNetworkDir: getContextNetworkDirectoryPath(this.projectDir),
      glossaryPath,
      chapters: this.chapters.map((chapter) => ({
        id: chapter.id,
        sourceFilePath: resolveChapterPath(this.projectDir, chapter.filePath),
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

  private async cleanupOrphanedSourceFile(filePath: string): Promise<void> {
    const resolvedPath = resolveChapterPath(this.projectDir, filePath);
    const hasOtherReference = this.chapters.some(
      (chapter) => resolveChapterPath(this.projectDir, chapter.filePath) === resolvedPath,
    );
    if (hasOtherReference) {
      return;
    }

    if (!isPathInsideDir(resolvedPath, this.projectDir)) {
      return;
    }

    try {
      await rm(resolvedPath, { force: true });
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
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
  const bootstrap = await loadWorkspaceBootstrap(projectDir);
  const databasePath = resolveWorkspaceDatabasePath(projectDir, bootstrap.databasePath);
  const config = await new SqliteProjectStorage(databasePath).loadWorkspaceConfig();
  if (!config) {
    throw new Error(`工作区数据库缺少配置数据: ${databasePath}`);
  }
  return config;
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

/** 未指定术语表路径时的默认路径（相对于工作区目录）。 */
export const DEFAULT_GLOSSARY_FILE_PATH = 'Data/glossary.json';

export function buildInitialWorkspaceConfig(
  config: TranslationProjectConfig,
  chapters: Chapter[],
): WorkspaceConfig {
  return {
    schemaVersion: 1,
    projectName: config.projectName,
    chapters: chapters.map((chapter) => ({ id: chapter.id, filePath: chapter.filePath })),
    glossary: {
      path: config.glossary?.path ?? DEFAULT_GLOSSARY_FILE_PATH,
      autoFilter: config.glossary?.autoFilter ?? true,
    },
    dependencyTracking: {
      sourceRevision: 0,
      glossaryRevision: 0,
    },
    translator: {},
    slidingWindow: {},
    textSplitMaxChars: config.textSplitMaxChars,
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
    dependencyTracking: {
      sourceRevision:
        persisted.dependencyTracking?.sourceRevision ??
        resolveDependencyTracking(current).sourceRevision,
      glossaryRevision:
        persisted.dependencyTracking?.glossaryRevision ??
        resolveDependencyTracking(current).glossaryRevision,
    },
    slidingWindow: {
      ...current.slidingWindow,
      ...persisted.slidingWindow,
    },
    textSplitMaxChars: persisted.textSplitMaxChars ?? current.textSplitMaxChars,
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
    dependencyTracking: { ...resolveDependencyTracking(config) },
    translator: nextTranslator,
    slidingWindow: patch.slidingWindow
      ? { ...config.slidingWindow, ...patch.slidingWindow }
      : config.slidingWindow,
    textSplitMaxChars:
      patch.textSplitMaxChars === null
        ? undefined
        : (patch.textSplitMaxChars ?? config.textSplitMaxChars),
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
    dependencyTracking: { ...resolveDependencyTracking(config) },
    translator: { ...config.translator },
    slidingWindow: { ...config.slidingWindow },
    customRequirements: [...config.customRequirements],
  };
}

export function buildWorkspaceBootstrapDocument(
  projectName: string,
  databasePath = DEFAULT_WORKSPACE_DATABASE_FILE_PATH,
): WorkspaceBootstrapDocument {
  return {
    schemaVersion: WORKSPACE_BOOTSTRAP_SCHEMA_VERSION,
    storage: "sqlite",
    projectName,
    databasePath,
  };
}

function resolveDependencyTracking(config: WorkspaceConfig): WorkspaceDependencyTrackingConfig {
  return {
    sourceRevision: config.dependencyTracking?.sourceRevision ?? 0,
    glossaryRevision: config.dependencyTracking?.glossaryRevision ?? 0,
  };
}

export function getWorkspaceBootstrapPath(projectDir: string): string {
  return join(resolve(projectDir), "Data", "workspace-config.json");
}

export function resolveWorkspaceDatabasePath(projectDir: string, databasePath: string): string {
  return resolve(projectDir, databasePath);
}

export async function saveWorkspaceBootstrap(
  projectDir: string,
  bootstrap: WorkspaceBootstrapDocument,
): Promise<void> {
  const bootstrapPath = getWorkspaceBootstrapPath(projectDir);
  await mkdir(dirname(bootstrapPath), { recursive: true });
  await writeFile(bootstrapPath, `${JSON.stringify(bootstrap, null, 2)}\n`, "utf8");
}

export async function inspectWorkspaceBootstrap(
  projectDir: string,
): Promise<WorkspaceBootstrapInspection> {
  const bootstrapPath = getWorkspaceBootstrapPath(projectDir);

  let content: string;
  try {
    content = await readFile(bootstrapPath, "utf8");
  } catch {
    return { kind: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`工作区引导文件无法解析: ${bootstrapPath}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`工作区引导文件必须是对象: ${bootstrapPath}`);
  }

  const schemaVersion = parsed.schemaVersion;
  if (
    schemaVersion === WORKSPACE_BOOTSTRAP_SCHEMA_VERSION &&
    parsed.storage === "sqlite" &&
    typeof parsed.projectName === "string" &&
    typeof parsed.databasePath === "string"
  ) {
    return {
      kind: "current",
      document: {
        schemaVersion: WORKSPACE_BOOTSTRAP_SCHEMA_VERSION,
        storage: "sqlite",
        projectName: parsed.projectName,
        databasePath: parsed.databasePath,
      },
    };
  }

  const projectName = typeof parsed.projectName === "string" ? parsed.projectName : undefined;
  return {
    kind: "deprecated",
    projectName,
    message: `检测到旧版 JSON 工作区：${bootstrapPath}。当前版本仅支持 SQLite 工作区，请删除该旧工作区后重新创建。`,
  };
}

export async function loadWorkspaceBootstrap(
  projectDir: string,
): Promise<WorkspaceBootstrapDocument> {
  const inspection = await inspectWorkspaceBootstrap(projectDir);
  if (inspection.kind === "current") {
    return inspection.document;
  }
  if (inspection.kind === "deprecated") {
    throw new Error(inspection.message);
  }
  throw new Error(`工作区引导文件不存在: ${getWorkspaceBootstrapPath(projectDir)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPathInsideDir(candidatePath: string, baseDir: string): boolean {
  const resolvedCandidate = resolve(candidatePath);
  const resolvedBase = resolve(baseDir);
  const rel = relative(resolvedBase, resolvedCandidate);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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
