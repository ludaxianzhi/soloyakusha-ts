import type { Chapter } from "./types.ts";
import type { TranslationDocumentManager } from "./translation-document-manager.ts";
import {
  buildRepetitionPatternCorpus,
  RepetitionPatternAnalyzer,
  type RepetitionPatternAnalysisOptions,
  type RepetitionPatternAnalysisResult,
} from "./repetition-pattern-analysis.ts";

export type {
  RepetitionPatternAnalysisOptions,
  RepetitionPatternAnalysisResult,
} from "./repetition-pattern-analysis.ts";

export function analyzeProjectRepeatedPatterns(
  params: {
    documentManager: TranslationDocumentManager;
    chapters: Chapter[];
  },
  options: RepetitionPatternAnalysisOptions = {},
): RepetitionPatternAnalysisResult {
  const corpus = buildRepetitionPatternCorpus(params);
  return new RepetitionPatternAnalyzer().analyze(corpus, options);
}
