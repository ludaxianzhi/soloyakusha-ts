import { TranslationDocumentManager } from "./translation-document-manager.ts";
import { PrebuiltContextRetriever } from "./context-index.ts";
import { TranslationTopology } from "./topology.ts";
import type {
  ContextPair,
  ContextSettings,
  ProjectCursor,
  TranslationContextEntry,
  TranslationContextType,
} from "./types.ts";

export class TranslationContextView {
  constructor(
    readonly chapterId: number,
    readonly fragmentIndex: number,
    private readonly options: {
      documentManager: TranslationDocumentManager;
      topology?: TranslationTopology;
      contextRetriever?: PrebuiltContextRetriever;
      context?: ContextSettings;
    },
  ) {}

  get sourceText(): string {
    return this.options.documentManager.getSourceText(
      this.chapterId,
      this.fragmentIndex,
    );
  }

  getContexts(): TranslationContextEntry[] {
    const contexts: TranslationContextEntry[] = [];

    const precedingContext = this.getPrecedingContext();
    if (precedingContext) {
      contexts.push(precedingContext);
    }

    const semanticContext = this.getSemanticContext();
    if (semanticContext) {
      contexts.push(semanticContext);
    }

    return contexts.sort((left, right) => right.priority - left.priority);
  }

  getContext(type: TranslationContextType): TranslationContextEntry | undefined {
    if (type === "precedingTranslation") {
      return this.getPrecedingContext();
    }

    if (type === "semanticSimilar") {
      return this.getSemanticContext();
    }

    return undefined;
  }

  getPrecedingContext(): TranslationContextEntry | undefined {
    const pairs = this.buildPrecedingContextPairs();
    if (pairs.length === 0) {
      return undefined;
    }

    return {
      type: "precedingTranslation",
      description: "前序翻译参考",
      priority: 60,
      pairs,
    };
  }

  getSemanticContext(): TranslationContextEntry | undefined {
    const pairs = this.buildSemanticContextPairs();
    if (pairs.length === 0) {
      return undefined;
    }

    return {
      type: "semanticSimilar",
      description: "语义相似翻译参考",
      priority: 50,
      pairs,
    };
  }

  private buildSemanticContextPairs(): ContextPair[] {
    if (!this.options.contextRetriever) {
      return [];
    }

    const fragments = this.options.contextRetriever.getContextFragments(
      this.chapterId,
      this.fragmentIndex,
      this.options.documentManager,
    );

    return fragments
      .map((fragment) => this.resolveFragmentIdentity(fragment.hash))
      .filter((identity): identity is Required<ProjectCursor> & { fragmentHash: string } =>
        identity !== undefined,
      )
      .map((identity) =>
        createContextPair(
          identity.chapterId,
          identity.fragmentIndex,
          identity.fragmentHash,
          this.options.documentManager,
        ),
      )
      .filter((pair) => pair.translatedText.length > 0);
  }

  private buildPrecedingContextPairs(): ContextPair[] {
    const maxFragments = this.options.context?.includeEarlierFragments ?? 2;
    const includeEarlierChapters =
      this.options.context?.includeEarlierChapters ?? true;

    const pairs: ContextPair[] = [];
    const chapterEntry = this.options.documentManager.getChapterById(this.chapterId);
    if (chapterEntry) {
      for (
        let currentIndex = Math.max(0, this.fragmentIndex - maxFragments);
        currentIndex < this.fragmentIndex;
        currentIndex += 1
      ) {
        const fragment = chapterEntry.fragments[currentIndex];
        if (!fragment?.isTranslated || fragment.translation.lines.length === 0) {
          continue;
        }

        pairs.push(
          createContextPair(
            this.chapterId,
            currentIndex,
            fragment.hash,
            this.options.documentManager,
          ),
        );
      }
    }

    if (
      !includeEarlierChapters ||
      pairs.length >= maxFragments ||
      !this.options.topology
    ) {
      return pairs;
    }

    const earlierChapters = this.options.topology
      .getAllEarlierChapters(this.chapterId)
      .reverse();
    for (const earlierChapter of earlierChapters) {
      if (pairs.length >= maxFragments) {
        break;
      }

      const earlierEntry = this.options.documentManager.getChapterById(earlierChapter.id);
      if (!earlierEntry) {
        continue;
      }

      for (const [earlierFragmentIndex, fragment] of [
        ...earlierEntry.fragments.entries(),
      ].reverse()) {
        if (pairs.length >= maxFragments) {
          break;
        }
        if (!fragment.isTranslated || fragment.translation.lines.length === 0) {
          continue;
        }

        pairs.unshift(
          createContextPair(
            earlierChapter.id,
            earlierFragmentIndex,
            fragment.hash,
            this.options.documentManager,
          ),
        );
      }
    }

    return pairs;
  }

  private resolveFragmentIdentity(
    fragmentHash: string,
  ): (Required<ProjectCursor> & { fragmentHash: string }) | undefined {
    const record = this.options.documentManager.getFragmentByHash(fragmentHash);
    if (!record) {
      return undefined;
    }

    if (!record.fragment.isTranslated || record.fragment.translation.lines.length === 0) {
      return undefined;
    }

    return {
      chapterId: record.chapterId,
      fragmentIndex: record.fragmentIndex,
      fragmentHash,
    };
  }
}

function createContextPair(
  chapterId: number,
  fragmentIndex: number,
  fragmentHash: string,
  documentManager: TranslationDocumentManager,
): ContextPair {
  return {
    chapterId,
    fragmentIndex,
    fragmentHash,
    sourceText: documentManager.getSourceText(chapterId, fragmentIndex),
    translatedText: documentManager.getTranslatedText(chapterId, fragmentIndex),
  };
}
