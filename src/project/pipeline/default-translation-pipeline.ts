import { Glossary } from "../../glossary/index.ts";
import type { PlotSummaryEntry } from "../context/plot-summarizer.ts";
import type { StoryTopology } from "../context/story-topology.ts";
import { TranslationContextView } from "../context/context-view.ts";
import type { GlobalAssociationPattern } from "../analysis/global-pattern-scanner.ts";
import type {
  OrderedFragmentSnapshot,
  TranslationPipelineDefinition,
} from "./pipeline.ts";
import type { TranslationDocumentManager } from "../document/translation-document-manager.ts";
import type {
  Chapter,
  GlossarySettings,
  TranslationDependencyMode,
} from "../types.ts";

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
        buildContextView: ({ chapterId, fragmentIndex, metadata, runtime }) => {
          const dependencyMode = metadata.dependencyMode;
          if (
            dependencyMode !== "previousTranslations" &&
            dependencyMode !== "glossaryTerms" &&
            dependencyMode !== "contextNetwork"
          ) {
            return undefined;
          }

          const networkContextRefs =
            dependencyMode === "contextNetwork"
              ? resolveContextNetworkRefs(
                  metadata.networkContextGlobalIndices,
                  metadata.dependencyMode,
                  runtime.getOrderedFragments(),
                  chapterId,
                  fragmentIndex,
                )
              : undefined;

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
            networkContextRefs,
          });
        },
      },
    ],
  };
}

export function resolveContextNetworkRefs(
  encodedIndices: string | number | boolean | undefined,
  dependencyMode: string | number | boolean | undefined,
  orderedFragments: OrderedFragmentSnapshot[],
  chapterId: number,
  fragmentIndex: number,
): Array<{ chapterId: number; fragmentIndex: number }> {
  if (dependencyMode !== "contextNetwork" || typeof encodedIndices !== "string") {
    return [];
  }

  return encodedIndices
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => Number.parseInt(value, 10))
    .filter((globalIndex) => Number.isInteger(globalIndex) && globalIndex >= 0)
    .map((globalIndex) => orderedFragments[globalIndex])
    .filter(
      (ref): ref is { chapterId: number; fragmentIndex: number } =>
        ref !== undefined && !(ref.chapterId === chapterId && ref.fragmentIndex === fragmentIndex),
    );
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

export function collectSourceTextSentences(
  documentManager: TranslationDocumentManager,
  chapters: Chapter[],
): Array<{
  sentenceId: string;
  text: string;
  fragmentGlobalIndex: number;
  chapterId: number;
  fragmentIndex: number;
  lineIndex: number;
}> {
  const chaptersById = new Map(documentManager.getAllChapters().map((chapter) => [chapter.id, chapter]));
  const sentences: Array<{
    sentenceId: string;
    text: string;
    fragmentGlobalIndex: number;
    chapterId: number;
    fragmentIndex: number;
    lineIndex: number;
  }> = [];

  let fragmentGlobalIndex = 0;
  for (const chapter of chapters) {
    const chapterEntry = chaptersById.get(chapter.id);
    if (!chapterEntry) {
      continue;
    }

    chapterEntry.fragments.forEach((fragment, fragmentIndex) => {
      fragment.source.lines.forEach((text, lineIndex) => {
        if (text.trim().length === 0) {
          return;
        }

        sentences.push({
          sentenceId: `chapter:${chapter.id}:fragment:${fragmentIndex}:line:${lineIndex}`,
          text,
          fragmentGlobalIndex,
          chapterId: chapter.id,
          fragmentIndex,
          lineIndex,
        });
      });
      fragmentGlobalIndex += 1;
    });
  }

  return sentences;
}

const TINY_CHUNK_MAX_CHARS = 100;

export function collectSourceTextTinyChunks(
  documentManager: TranslationDocumentManager,
  chapters: Chapter[],
): Array<{
  chunkId: string;
  text: string;
  fragmentGlobalIndex: number;
  chapterId: number;
  fragmentIndex: number;
}> {
  const chaptersById = new Map(documentManager.getAllChapters().map((chapter) => [chapter.id, chapter]));
  const chunks: Array<{
    chunkId: string;
    text: string;
    fragmentGlobalIndex: number;
    chapterId: number;
    fragmentIndex: number;
  }> = [];

  let fragmentGlobalIndex = 0;
  for (const chapter of chapters) {
    const chapterEntry = chaptersById.get(chapter.id);
    if (!chapterEntry) {
      continue;
    }

    chapterEntry.fragments.forEach((fragment, fragmentIndex) => {
      let accumulatedLines: string[] = [];
      let accumulatedLength = 0;
      let chunkLocalIndex = 0;

      const flushAccumulated = () => {
        if (accumulatedLines.length === 0) {
          return;
        }
        chunks.push({
          chunkId: `chapter:${chapter.id}:fragment:${fragmentIndex}:chunk:${chunkLocalIndex}`,
          text: accumulatedLines.join(""),
          fragmentGlobalIndex,
          chapterId: chapter.id,
          fragmentIndex,
        });
        chunkLocalIndex += 1;
        accumulatedLines = [];
        accumulatedLength = 0;
      };

      for (const line of fragment.source.lines) {
        if (line.trim().length === 0) {
          continue;
        }

        if (line.length > TINY_CHUNK_MAX_CHARS) {
          flushAccumulated();
          chunks.push({
            chunkId: `chapter:${chapter.id}:fragment:${fragmentIndex}:chunk:${chunkLocalIndex}`,
            text: line,
            fragmentGlobalIndex,
            chapterId: chapter.id,
            fragmentIndex,
          });
          chunkLocalIndex += 1;
        } else {
          if (accumulatedLength + line.length > TINY_CHUNK_MAX_CHARS) {
            flushAccumulated();
          }
          accumulatedLines.push(line);
          accumulatedLength += line.length;
        }
      }

      flushAccumulated();
      fragmentGlobalIndex += 1;
    });
  }

  return chunks;
}
