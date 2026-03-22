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
  TextFragment,
  TranslationUnit,
  TranslationUnitParser,
  TranslationUnitSplitter,
} from "./types.ts";
import {
  createTextFragment,
  fragmentToText,
} from "./types.ts";

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
    fragment.isTranslated = true;
    await this.saveChapterById(chapterId);
  }

  updateStageValue(
    chapterId: number,
    fragmentIndex: number,
    key: string,
    value: TextFragment | string | string[],
  ): void {
    const fragment = this.getRequiredFragment(chapterId, fragmentIndex);
    fragment.stageValues[key] = normalizeFragment(value);
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
    return Array.from(this.chapters.values()).sort((left, right) => left.id - right.id);
  }

  getTranslationProgress(): {
    translatedFragments: number;
    totalFragments: number;
  } {
    let translatedFragments = 0;
    let totalFragments = 0;

    for (const chapter of this.chapters.values()) {
      for (const fragment of chapter.fragments) {
        totalFragments += 1;
        if (fragment.isTranslated) {
          translatedFragments += 1;
        }
      }
    }

    return {
      translatedFragments,
      totalFragments,
    };
  }

  getSourceText(chapterId: number, fragmentIndex: number): string {
    return fragmentToText(this.getRequiredFragment(chapterId, fragmentIndex).source);
  }

  getTranslatedText(chapterId: number, fragmentIndex: number): string {
    return fragmentToText(this.getRequiredFragment(chapterId, fragmentIndex).translation);
  }

  getChapterSourceText(chapterId: number): string {
    const chapter = this.getRequiredChapter(chapterId);
    return chapter.fragments.map((fragment) => fragmentToText(fragment.source)).join("\n");
  }

  getChapterTranslatedText(chapterId: number): string {
    const chapter = this.getRequiredChapter(chapterId);
    return chapter.fragments
      .map((fragment) => fragmentToText(fragment.translation))
      .join("\n");
  }

  exportTranslatedChapters(): ChapterEntry[] {
    return this.getAllChapters().filter((chapter) =>
      chapter.fragments.every((fragment) => fragment.isTranslated),
    );
  }

  getChapterTranslationUnits(chapterId: number): TranslationUnit[] {
    const chapter = this.getRequiredChapter(chapterId);
    const units: TranslationUnit[] = [];

    for (const fragment of chapter.fragments) {
      const metadataList = fragment.meta?.metadataList ?? [];
      const targetGroups = fragment.meta?.targetGroups ?? [];
      for (const [lineIndex, sourceLine] of fragment.source.lines.entries()) {
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

        units.push({
          source: sourceLine,
          target: targets,
          metadata: metadataList[lineIndex] ?? null,
        });
      }
    }

    return units;
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
    const fragmentGroups = this.textSplitter.split(units);

    const fragments = fragmentGroups.map<FragmentEntry>((fragmentUnits) => {
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
        stageValues: {},
        meta: {
          metadataList,
          targetGroups,
        },
        isTranslated:
          translation.lines.length > 0 &&
          translation.lines.every((line) => line.length > 0),
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
  return {
    id: chapter.id,
    filePath: chapter.filePath,
      fragments: chapter.fragments.map((fragment) => ({
        source: fragment.source,
        translation: fragment.translation,
        stageValues: fragment.stageValues ?? {},
        meta: {
          metadataList: fragment.meta?.metadataList ?? [],
          targetGroups: fragment.meta?.targetGroups ?? [],
        },
        isTranslated: fragment.isTranslated,
        hash: fragment.hash,
      })),
    };
  }

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
