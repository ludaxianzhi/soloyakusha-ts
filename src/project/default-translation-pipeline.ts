import { Glossary } from "../glossary/index.ts";
import type { PlotSummaryEntry } from "./plot-summarizer.ts";
import type { StoryTopology } from "./story-topology.ts";
import { TranslationContextView } from "./context-view.ts";
import type { GlobalAssociationPattern } from "./global-pattern-scanner.ts";
import type {
  OrderedFragmentSnapshot,
  TranslationPipelineDefinition,
} from "./pipeline.ts";
import type { TranslationDocumentManager } from "./translation-document-manager.ts";
import type {
  Chapter,
  GlossarySettings,
  TranslationDependencyMode,
} from "./types.ts";

type DefaultTranslationPipelineOptions = {
  documentManager: TranslationDocumentManager;
  getGlossary: () => Glossary | undefined;
  glossaryConfig?: GlossarySettings;
  getTraversalChapters: () => Chapter[];
  getPlotSummaryEntries?: () => ReadonlyArray<PlotSummaryEntry>;
  getStoryTopology?: () => StoryTopology | undefined;
  maxPlotSummaryEntries?: number;
  isStepCompleted: (chapterId: number, fragmentIndex: number, stepId: string) => boolean;
};

export function createDefaultTranslationPipelineDefinition(
  options: DefaultTranslationPipelineOptions,
): TranslationPipelineDefinition {
  return {
    steps: [
      {
        id: "translation",
        description: "最终翻译",
        buildInput: ({ chapterId, fragmentIndex, runtime }) =>
          runtime.getSourceText(chapterId, fragmentIndex),
        resolveDependencies: ({ chapterId, fragmentIndex, stepId, runtime }) => {
          const dependencyMode = resolveTranslationDependencyMode({
            chapterId,
            fragmentIndex,
            stepId,
            orderedFragments: runtime.getOrderedFragments(),
            documentManager: options.documentManager,
            glossary: options.getGlossary(),
            isStepCompleted: options.isStepCompleted,
          });

          return dependencyMode
            ? {
                ready: true,
                metadata: { dependencyMode },
              }
            : {
                ready: false,
                reason: getTranslationDependencyBlockedReason({
                  chapterId,
                  fragmentIndex,
                  stepId,
                  orderedFragments: runtime.getOrderedFragments(),
                  documentManager: options.documentManager,
                  glossary: options.getGlossary(),
                  isStepCompleted: options.isStepCompleted,
                }),
              };
        },
        buildContextView: ({ chapterId, fragmentIndex, metadata }) => {
          const dependencyMode = metadata.dependencyMode;
          if (
            dependencyMode !== "previousTranslations" &&
            dependencyMode !== "glossaryTerms"
          ) {
            return undefined;
          }

          return new TranslationContextView(chapterId, fragmentIndex, {
            documentManager: options.documentManager,
            stepId: "translation",
            dependencyMode,
            traversalChapters: options.getTraversalChapters(),
            glossary: options.getGlossary(),
            glossaryConfig: options.glossaryConfig,
            plotSummaryEntries: options.getPlotSummaryEntries?.(),
            storyTopology: options.getStoryTopology?.(),
            maxPlotSummaryEntries: options.maxPlotSummaryEntries,
          });
        },
      },
    ],
  };
}

type TranslationDependencyOptions = {
  chapterId: number;
  fragmentIndex: number;
  stepId: string;
  orderedFragments: OrderedFragmentSnapshot[];
  documentManager: TranslationDocumentManager;
  glossary?: Glossary;
  isStepCompleted: (chapterId: number, fragmentIndex: number, stepId: string) => boolean;
};

export function resolveTranslationDependencyMode(
  options: TranslationDependencyOptions,
): TranslationDependencyMode | undefined {
  const currentIndex = options.orderedFragments.findIndex(
    (fragment) =>
      fragment.chapterId === options.chapterId &&
      fragment.fragmentIndex === options.fragmentIndex,
  );
  if (currentIndex === -1) {
    throw new Error(
      `文本块不存在: chapter=${options.chapterId}, fragment=${options.fragmentIndex}`,
    );
  }

  if (
    options.orderedFragments
      .slice(0, currentIndex)
      .every((fragment) =>
        options.isStepCompleted(fragment.chapterId, fragment.fragmentIndex, options.stepId),
      )
  ) {
    return "previousTranslations";
  }

  const matchedGlossaryTerms = options.glossary?.filterTerms(
    options.documentManager.getSourceText(options.chapterId, options.fragmentIndex),
  ) ?? [];
  const completedPeerFragments = options.orderedFragments.filter(
    (fragment) =>
      !(
        fragment.chapterId === options.chapterId &&
        fragment.fragmentIndex === options.fragmentIndex
      ) && options.isStepCompleted(fragment.chapterId, fragment.fragmentIndex, options.stepId),
  );
  const hasCompletedPeer = completedPeerFragments.length > 0;
  const completedSourceTexts = completedPeerFragments.map((fragment) =>
    options.documentManager.getSourceText(fragment.chapterId, fragment.fragmentIndex),
  );
  if (
    hasCompletedPeer &&
    matchedGlossaryTerms.length > 0 &&
    matchedGlossaryTerms.every((term) =>
      completedSourceTexts.some((text) => text.includes(term.term)),
    ) &&
    options.orderedFragments
      .slice(0, Math.floor((currentIndex + 1) / 2))
      .every((fragment) =>
        options.isStepCompleted(fragment.chapterId, fragment.fragmentIndex, options.stepId),
      )
  ) {
    return "glossaryTerms";
  }

  return undefined;
}

export function getTranslationDependencyBlockedReason(
  options: TranslationDependencyOptions,
): string {
  const currentIndex = options.orderedFragments.findIndex(
    (fragment) =>
      fragment.chapterId === options.chapterId &&
      fragment.fragmentIndex === options.fragmentIndex,
  );
  if (currentIndex === -1) {
    return "fragment_not_found";
  }

  const hasUnfinishedPreviousFragments = options.orderedFragments
    .slice(0, currentIndex)
    .some((fragment) =>
      !options.isStepCompleted(fragment.chapterId, fragment.fragmentIndex, options.stepId),
    );
  if (!options.glossary) {
    return hasUnfinishedPreviousFragments
      ? "waiting_for_previous_fragments"
      : "waiting_for_glossary";
  }

  const matchedGlossaryTerms = options.glossary.filterTerms(
    options.documentManager.getSourceText(options.chapterId, options.fragmentIndex),
  );
  if (matchedGlossaryTerms.length === 0) {
    return hasUnfinishedPreviousFragments
      ? "waiting_for_previous_fragments"
      : "waiting_for_glossary_terms";
  }

  const completedPeerFragments = options.orderedFragments.filter(
    (fragment) =>
      !(
        fragment.chapterId === options.chapterId &&
        fragment.fragmentIndex === options.fragmentIndex
      ) && options.isStepCompleted(fragment.chapterId, fragment.fragmentIndex, options.stepId),
  );
  const completedSourceTexts = completedPeerFragments.map((fragment) =>
    options.documentManager.getSourceText(fragment.chapterId, fragment.fragmentIndex),
  );
  const termsNotInTranslations = matchedGlossaryTerms.filter(
    (term) => !completedSourceTexts.some((text) => text.includes(term.term)),
  );
  if (termsNotInTranslations.length > 0) {
    return "waiting_for_terms_in_translations";
  }

  const hasCompletedPeer = completedPeerFragments.length > 0;
  if (!hasCompletedPeer) {
    return "waiting_for_completed_peer";
  }

  const requiredPrecedingCount = Math.floor((currentIndex + 1) / 2);
  const precedingNotCompleted = options.orderedFragments
    .slice(0, requiredPrecedingCount)
    .some(
      (fragment) =>
        !options.isStepCompleted(fragment.chapterId, fragment.fragmentIndex, options.stepId),
    );
  if (precedingNotCompleted) {
    return "waiting_for_preceding_fragments";
  }

  return "waiting_for_step_dependencies";
}

export function upsertGlobalPatternTerm(
  glossary: Glossary,
  pattern: GlobalAssociationPattern,
): void {
  const existing = glossary.getTerm(pattern.text);
  if (!existing) {
    glossary.addTerm({
      term: pattern.text,
      translation: "",
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

export function collectSourceTextBlocks(
  documentManager: TranslationDocumentManager,
  chapters: Chapter[],
): Array<{ blockId: string; text: string }> {
  return chapters.flatMap((chapter) =>
    documentManager.getChapterFragmentRefs(chapter.id).map(({ fragmentIndex }) => ({
      blockId: `chapter:${chapter.id}:fragment:${fragmentIndex}`,
      text: documentManager.getSourceText(chapter.id, fragmentIndex),
    })),
  );
}
