/**
 * 根据 Pipeline 步骤的依赖满足方式构建翻译上下文视图。
 *
 * @module project/context-view
 */

import type { Glossary, ResolvedGlossaryTerm } from "../../glossary/glossary.ts";
import { matchGlossaryTermsWithCascadeForInjection } from "./glossary-cascade-matcher.ts";
import type { PlotSummaryEntry } from "./plot-summarizer.ts";
import {
  formatPlotSummaryForContext,
  getPlotSummariesForPosition,
} from "./plot-summarizer.ts";
import type { StoryTopology } from "./story-topology.ts";
import { TranslationDocumentManager } from "../document/translation-document-manager.ts";
import type {
  Chapter,
  ContextPair,
  GlossarySettings,
  TranslationContextEntry,
  TranslationContextType,
  TranslationDependencyMode,
} from "../types.ts";

type OrderedFragmentRef = {
  chapterId: number;
  fragmentIndex: number;
};

export type DependencyPromptContext = {
  referenceSourceTexts: string[];
  referenceTranslations: string[];
  plotSummaries: string[];
};

export class TranslationContextView {
  constructor(
    readonly chapterId: number,
    readonly fragmentIndex: number,
    private readonly options: {
      documentManager: TranslationDocumentManager;
      stepId: string;
      dependencyMode: TranslationDependencyMode;
      traversalChapters: Chapter[];
      networkContextRefs?: OrderedFragmentRef[];
      glossary?: Glossary;
      glossaryConfig?: GlossarySettings;
      plotSummaryEntries?: ReadonlyArray<PlotSummaryEntry>;
      storyTopology?: StoryTopology;
      maxPlotSummaryEntries?: number;
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

    const glossaryContext = this.getGlossaryContext();
    if (glossaryContext) {
      contexts.push(glossaryContext);
    }

    const plotSummaryContext = this.getPlotSummaryContext();
    if (plotSummaryContext) {
      contexts.push(plotSummaryContext);
    }

    const dependencyContext = this.getDependencyContext();
    if (dependencyContext) {
      contexts.push(dependencyContext);
    }

    return contexts.sort((left, right) => right.priority - left.priority);
  }

  getContext(type: TranslationContextType): TranslationContextEntry | undefined {
    if (type === "glossary") {
      return this.getGlossaryContext();
    }

    if (type === "dependencyTranslation") {
      return this.getDependencyContext();
    }

    if (type === "plotSummary") {
      return this.getPlotSummaryContext();
    }

    return undefined;
  }

  getGlossaryContext(): TranslationContextEntry | undefined {
    const glossaryTerms = this.getTranslatedGlossaryTerms();
    if (glossaryTerms.length === 0) {
      return undefined;
    }

    const content = this.options.glossary!.renderAsCsv(glossaryTerms);

    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length <= 1) {
      return undefined;
    }

    return {
      type: "glossary",
      description: "项目术语表",
      priority: 100,
      content,
    };
  }

  getMatchedGlossaryTerms(): ResolvedGlossaryTerm[] {
    if (!this.options.glossary) {
      return [];
    }

    const autoFilter = this.options.glossaryConfig?.autoFilter ?? true;
    return autoFilter
      ? matchGlossaryTermsWithCascadeForInjection(this.options.glossary, this.sourceText)
      : this.options.glossary.getAllTerms();
  }

  getTranslatedGlossaryTerms(): ResolvedGlossaryTerm[] {
    return this.getMatchedGlossaryTerms().filter((term) => term.status === "translated");
  }

  getUntranslatedGlossaryTerms(): ResolvedGlossaryTerm[] {
    return this.getMatchedGlossaryTerms().filter((term) => term.status === "untranslated");
  }

  getPlotSummaryContext(): TranslationContextEntry | undefined {
    const summaries = this.getPlotSummaryTexts();
    if (summaries.length === 0) {
      return undefined;
    }

    return {
      type: "plotSummary",
      description: "前序情节总结",
      priority: 80,
      summaries,
    };
  }

  getPlotSummaryTexts(): string[] {
    const entries = this.options.plotSummaryEntries;
    if (!entries || entries.length === 0) {
      return [];
    }

    const maxEntries = this.options.maxPlotSummaryEntries ?? 8;
    return getPlotSummariesForPosition(
      entries,
      this.chapterId,
      this.fragmentIndex,
      this.options.storyTopology,
    )
      .slice(-maxEntries)
      .map((entry) => formatPlotSummaryForContext(entry));
  }

  getDependencyContext(): TranslationContextEntry | undefined {
    const pairs = this.getDependencyPairs();
    if (pairs.length === 0) {
      return undefined;
    }

    return {
      type: "dependencyTranslation",
      description:
        this.options.dependencyMode === "previousTranslations"
          ? "前序步骤参考"
          : this.options.dependencyMode === "glossaryTerms"
            ? "词汇依赖步骤参考"
            : "上下文网络参考",
      priority: 60,
      pairs,
    };
  }

  getDependencyPairs(): ContextPair[] {
    if (this.options.dependencyMode === "previousTranslations") {
      return this.buildPreviousStepPairs();
    }

    if (this.options.dependencyMode === "glossaryTerms") {
      return this.buildGlossaryDependencyPairs();
    }

    return this.buildContextNetworkPairs();
  }

  getDependencyTranslatedTexts(): string[] {
    return this.getDependencyPairs()
      .map((pair) => pair.translatedText.trim())
      .filter((value) => value.length > 0);
  }

  getDependencyPromptContext(): DependencyPromptContext {
    const pairs = this.getDependencyPairs();
    const referenceSourceTexts = pairs
      .map((pair) => pair.sourceText.trim())
      .filter((value) => value.length > 0);
    const referenceTranslations = pairs
      .map((pair) => pair.translatedText.trim())
      .filter((value) => value.length > 0);

    return {
      referenceSourceTexts,
      referenceTranslations,
      plotSummaries:
        referenceSourceTexts.length > 0 ? this.getPlotSummaryTexts() : [],
    };
  }

  private buildPreviousStepPairs(): ContextPair[] {
    const orderedFragments = this.getOrderedFragments();
    const currentIndex = orderedFragments.findIndex(
      (fragment) =>
        fragment.chapterId === this.chapterId &&
        fragment.fragmentIndex === this.fragmentIndex,
    );
    if (currentIndex <= 0) {
      return [];
    }

    const pairs: ContextPair[] = [];
    for (let offset = 1; offset <= 2; offset += 1) {
      const ref = orderedFragments[currentIndex - offset];
      if (!ref || !this.isStepCompleted(ref.chapterId, ref.fragmentIndex)) {
        continue;
      }

      pairs.push(
        createContextPair(
          ref.chapterId,
          ref.fragmentIndex,
          this.options.documentManager,
        ),
      );
    }

    return pairs;
  }

  private buildGlossaryDependencyPairs(): ContextPair[] {
    const orderedFragments = this.getOrderedFragments();
    const translatedRefs = orderedFragments.filter((fragment) =>
      this.isStepCompleted(fragment.chapterId, fragment.fragmentIndex),
    );
    if (translatedRefs.length === 0) {
      return [];
    }

    const currentIndex = orderedFragments.findIndex(
      (fragment) =>
        fragment.chapterId === this.chapterId &&
        fragment.fragmentIndex === this.fragmentIndex,
    );
    if (currentIndex === -1) {
      return [];
    }

    const best = this.selectBestGlossaryDependencyRef(translatedRefs, currentIndex, orderedFragments);
    if (!best) {
      return [];
    }

    return [
      createContextPair(best.chapterId, best.fragmentIndex, this.options.documentManager),
    ];
  }

  private buildContextNetworkPairs(): ContextPair[] {
    const refs: OrderedFragmentRef[] = [];
    const directPredecessor = this.getDirectPredecessorRef();
    if (directPredecessor && this.isStepCompleted(directPredecessor.chapterId, directPredecessor.fragmentIndex)) {
      refs.push(directPredecessor);
    }

    for (const ref of this.options.networkContextRefs ?? []) {
      if (!this.isStepCompleted(ref.chapterId, ref.fragmentIndex)) {
        continue;
      }
      refs.push(ref);
    }

    const uniqueRefs = dedupeFragmentRefs(refs).filter(
      (ref) => !(ref.chapterId === this.chapterId && ref.fragmentIndex === this.fragmentIndex),
    );
    return uniqueRefs.map((ref) =>
      createContextPair(ref.chapterId, ref.fragmentIndex, this.options.documentManager),
    );
  }

  private selectBestGlossaryDependencyRef(
    translatedRefs: OrderedFragmentRef[],
    currentIndex: number,
    orderedFragments: OrderedFragmentRef[],
  ): OrderedFragmentRef | undefined {
    if (!this.options.glossary) {
      return [...translatedRefs].sort((left, right) =>
        compareByDistance(left, right, currentIndex, orderedFragments),
      )[0];
    }

    const currentTerms = new Set(
      this.options.glossary
        .filterTerms(this.sourceText)
        .filter((term) => term.status === "translated")
        .map((term) => term.term),
    );

    let bestScore = -1;
    let bestRef: OrderedFragmentRef | undefined;
    let bestDistance = Infinity;

    for (const ref of translatedRefs) {
      const refIndex = orderedFragments.findIndex(
        (fragment) =>
          fragment.chapterId === ref.chapterId &&
          fragment.fragmentIndex === ref.fragmentIndex,
      );
      const distance = Math.abs(refIndex - currentIndex);
      const candidateTerms = this.options.glossary.filterTerms(
        this.options.documentManager.getSourceText(ref.chapterId, ref.fragmentIndex),
      );
      const score = countGlossaryOverlap(currentTerms, candidateTerms);
      if (score > bestScore || (score === bestScore && distance < bestDistance)) {
        bestScore = score;
        bestRef = ref;
        bestDistance = distance;
      }
    }

    return bestRef;
  }

  private getOrderedFragments(): OrderedFragmentRef[] {
    return this.options.traversalChapters.flatMap((chapter) =>
      this.options.documentManager.getChapterFragmentRefs(chapter.id),
    );
  }

  private getDirectPredecessorRef(): OrderedFragmentRef | undefined {
    if (this.fragmentIndex > 0) {
      return {
        chapterId: this.chapterId,
        fragmentIndex: this.fragmentIndex - 1,
      };
    }

    const previousChapterId = this.getPreviousChapterIdInRoute();
    if (previousChapterId === undefined) {
      return undefined;
    }

    const fragmentCount = this.options.documentManager.getChapterFragmentCount(previousChapterId);
    if (fragmentCount <= 0) {
      return undefined;
    }

    return {
      chapterId: previousChapterId,
      fragmentIndex: fragmentCount - 1,
    };
  }

  private getPreviousChapterIdInRoute(): number | undefined {
    if (this.options.storyTopology) {
      const route = this.options.storyTopology.findRouteForChapter(this.chapterId);
      if (route) {
        const sequence = this.options.storyTopology.getChapterSequence(route.id);
        const index = sequence.indexOf(this.chapterId);
        if (index > 0) {
          return sequence[index - 1];
        }
      }
    }

    const traversalIds = this.options.traversalChapters.map((chapter) => chapter.id);
    const index = traversalIds.indexOf(this.chapterId);
    return index > 0 ? traversalIds[index - 1] : undefined;
  }

  private isStepCompleted(chapterId: number, fragmentIndex: number): boolean {
    return (
      this.options.documentManager.getPipelineStepState(
        chapterId,
        fragmentIndex,
        this.options.stepId,
      )?.status === "completed"
    );
  }
}

function createContextPair(
  chapterId: number,
  fragmentIndex: number,
  documentManager: TranslationDocumentManager,
): ContextPair {
  const fragment = documentManager.getFragmentById(chapterId, fragmentIndex);
  if (!fragment) {
    throw new Error(`文本块不存在: chapter=${chapterId}, fragment=${fragmentIndex}`);
  }

  return {
    chapterId,
    fragmentIndex,
    fragmentHash: fragment.hash,
    sourceText: documentManager.getSourceText(chapterId, fragmentIndex),
    translatedText: documentManager.getTranslatedText(chapterId, fragmentIndex),
  };
}

function countGlossaryOverlap(
  currentTerms: Set<string>,
  candidateTerms: ReadonlyArray<ResolvedGlossaryTerm>,
): number {
  let score = 0;
  for (const term of candidateTerms) {
    if (term.status === "translated" && currentTerms.has(term.term)) {
      score += 1;
    }
  }

  return score;
}

function compareByDistance(
  left: OrderedFragmentRef,
  right: OrderedFragmentRef,
  currentIndex: number,
  orderedFragments: OrderedFragmentRef[],
): number {
  const leftIndex = orderedFragments.findIndex(
    (fragment) =>
      fragment.chapterId === left.chapterId &&
      fragment.fragmentIndex === left.fragmentIndex,
  );
  const rightIndex = orderedFragments.findIndex(
    (fragment) =>
      fragment.chapterId === right.chapterId &&
      fragment.fragmentIndex === right.fragmentIndex,
  );

  return (
    Math.abs(leftIndex - currentIndex) - Math.abs(rightIndex - currentIndex) ||
    leftIndex - rightIndex
  );
}

function dedupeFragmentRefs(refs: OrderedFragmentRef[]): OrderedFragmentRef[] {
  const seen = new Set<string>();
  const result: OrderedFragmentRef[] = [];
  for (const ref of refs) {
    const key = `${ref.chapterId}:${ref.fragmentIndex}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(ref);
  }
  return result;
}
