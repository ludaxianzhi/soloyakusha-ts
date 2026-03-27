import { Glossary } from "../glossary/index.ts";
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
  const hasCompletedPeer = options.orderedFragments.some(
    (fragment) =>
      !(
        fragment.chapterId === options.chapterId &&
        fragment.fragmentIndex === options.fragmentIndex
      ) && options.isStepCompleted(fragment.chapterId, fragment.fragmentIndex, options.stepId),
  );
  if (
    hasCompletedPeer &&
    matchedGlossaryTerms.length > 0 &&
    matchedGlossaryTerms.every((term) => term.status === "translated")
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

  const untranslatedTerms = matchedGlossaryTerms.filter((term) => term.status !== "translated");
  if (untranslatedTerms.length > 0) {
    return "waiting_for_translated_glossary_terms";
  }

  const hasCompletedPeer = options.orderedFragments.some(
    (fragment) =>
      !(
        fragment.chapterId === options.chapterId &&
        fragment.fragmentIndex === options.fragmentIndex
      ) && options.isStepCompleted(fragment.chapterId, fragment.fragmentIndex, options.stepId),
  );
  if (!hasCompletedPeer) {
    return "waiting_for_completed_peer";
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

export function collectSourceTextBlocks(
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
