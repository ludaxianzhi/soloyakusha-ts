import {
  GlobalAssociationPatternScanner,
  type GlobalAssociationPatternScanOptions,
} from "./global-pattern-scanner.ts";
import type { Chapter } from "./types.ts";
import type { TranslationDocumentManager } from "./translation-document-manager.ts";

export type RepetitionPatternAnalysisOptions = GlobalAssociationPatternScanOptions;
export type RepetitionPatternAnalysisScope = {
  chapterIds?: number[];
};
export const SAVED_REPETITION_PATTERN_ANALYSIS_SCHEMA_VERSION = 1 as const;

export type ScopedRepetitionPatternAnalysisOptions = RepetitionPatternAnalysisOptions &
  RepetitionPatternAnalysisScope;

export type RepetitionPatternCorpusEntry = {
  chapterId: number;
  chapterFilePath: string;
  unitIndex: number;
  fragmentIndex: number;
  lineIndex: number;
  sourceText: string;
  translatedText: string;
  globalStartIndex: number;
  globalEndIndex: number;
};

export type RepetitionPatternCorpus = {
  fullText: string;
  fullTextLength: number;
  entries: RepetitionPatternCorpusEntry[];
};

export type RepetitionPatternLocation = {
  chapterId: number;
  chapterFilePath: string;
  unitIndex: number;
  fragmentIndex: number;
  lineIndex: number;
  sourceSentence: string;
  translatedSentence: string;
  globalStartIndex: number;
  globalEndIndex: number;
  sentenceStartIndex: number;
  sentenceEndIndex: number;
  matchStartInSentence: number;
  matchEndInSentence: number;
};

export type RepetitionPatternTranslationVariant = {
  text: string;
  normalizedText: string;
  count: number;
  locations: RepetitionPatternLocation[];
};

export type RepetitionPatternAnalysis = {
  text: string;
  length: number;
  occurrenceCount: number;
  locations: RepetitionPatternLocation[];
  translations: RepetitionPatternTranslationVariant[];
  isTranslationConsistent: boolean;
};

export type RepetitionPatternAnalysisResult = {
  fullTextLength: number;
  totalSentenceCount: number;
  patterns: RepetitionPatternAnalysis[];
};

export type SavedRepetitionPatternLocation = Omit<
  RepetitionPatternLocation,
  "translatedSentence"
>;

export type SavedRepetitionPatternAnalysis = {
  text: string;
  length: number;
  occurrenceCount: number;
  locations: SavedRepetitionPatternLocation[];
};

export type SavedRepetitionPatternAnalysisResult = {
  schemaVersion: typeof SAVED_REPETITION_PATTERN_ANALYSIS_SCHEMA_VERSION;
  generatedAt: string;
  scanOptions: RepetitionPatternAnalysisOptions;
  fullTextLength: number;
  totalSentenceCount: number;
  patterns: SavedRepetitionPatternAnalysis[];
};

export function buildRepetitionPatternCorpus(params: {
  documentManager: TranslationDocumentManager;
  chapters: Chapter[];
}): RepetitionPatternCorpus {
  const entries: RepetitionPatternCorpusEntry[] = [];
  let cursor = 0;

  for (const chapter of params.chapters) {
    const chapterEntry = params.documentManager.getChapterById(chapter.id);
    if (!chapterEntry) {
      continue;
    }

    let unitIndex = 0;
    for (const [fragmentIndex, fragment] of chapterEntry.fragments.entries()) {
      for (const [lineIndex, sourceText] of fragment.source.lines.entries()) {
        if (entries.length > 0) {
          cursor += 1;
        }

        const textLength = Array.from(sourceText).length;
        const translatedText = fragment.translation.lines[lineIndex] ?? "";
        entries.push({
          chapterId: chapter.id,
          chapterFilePath: chapter.filePath,
          unitIndex,
          fragmentIndex,
          lineIndex,
          sourceText,
          translatedText,
          globalStartIndex: cursor,
          globalEndIndex: cursor + textLength,
        });

        cursor += textLength;
        unitIndex += 1;
      }
    }
  }

  return {
    fullText: entries.map((entry) => entry.sourceText).join("\n"),
    fullTextLength: cursor,
    entries,
  };
}

export class RepetitionPatternAnalyzer {
  analyze(
    corpus: RepetitionPatternCorpus,
    options: RepetitionPatternAnalysisOptions = {},
  ): RepetitionPatternAnalysisResult {
    if (corpus.entries.length === 0) {
      return {
        fullTextLength: corpus.fullTextLength,
        totalSentenceCount: 0,
        patterns: [],
      };
    }

    const scanner = new GlobalAssociationPatternScanner();
    const scanResult = scanner.scanText(corpus.fullText, options);
    const fullTextCharacters = Array.from(corpus.fullText);

    return {
      fullTextLength: scanResult.fullTextLength,
      totalSentenceCount: corpus.entries.length,
      patterns: scanResult.patterns.map((pattern) => {
        const locations = collectPatternLocations(
          corpus.entries,
          fullTextCharacters,
          Array.from(pattern.text),
        );
        const translations = groupPatternTranslations(locations);

        return {
          text: pattern.text,
          length: Array.from(pattern.text).length,
          occurrenceCount: locations.length,
          locations,
          translations,
          isTranslationConsistent: translations.length <= 1,
        };
      }),
    };
  }
}

export function createSavedRepetitionPatternAnalysisResult(
  result: RepetitionPatternAnalysisResult,
  options: RepetitionPatternAnalysisOptions = {},
  generatedAt = new Date().toISOString(),
): SavedRepetitionPatternAnalysisResult {
  return {
    schemaVersion: SAVED_REPETITION_PATTERN_ANALYSIS_SCHEMA_VERSION,
    generatedAt,
    scanOptions: { ...options },
    fullTextLength: result.fullTextLength,
    totalSentenceCount: result.totalSentenceCount,
    patterns: result.patterns.map((pattern) => ({
      text: pattern.text,
      length: pattern.length,
      occurrenceCount: pattern.occurrenceCount,
      locations: pattern.locations.map(({ translatedSentence: _, ...location }) => ({
        ...location,
      })),
    })),
  };
}

export function hydrateSavedRepetitionPatternAnalysisResult(
  saved: SavedRepetitionPatternAnalysisResult,
  resolveTranslation: (location: SavedRepetitionPatternLocation) => string,
): RepetitionPatternAnalysisResult {
  return {
    fullTextLength: saved.fullTextLength,
    totalSentenceCount: saved.totalSentenceCount,
    patterns: saved.patterns.map((pattern) => {
      const locations = pattern.locations.map((location) => ({
        ...location,
        translatedSentence: resolveTranslation(location),
      }));
      const translations = groupPatternTranslations(locations);
      return {
        text: pattern.text,
        length: pattern.length,
        occurrenceCount: locations.length,
        locations,
        translations,
        isTranslationConsistent: translations.length <= 1,
      };
    }),
  };
}

function collectPatternLocations(
  entries: RepetitionPatternCorpusEntry[],
  fullTextCharacters: string[],
  patternCharacters: string[],
): RepetitionPatternLocation[] {
  const starts = findAllOccurrences(fullTextCharacters, patternCharacters);
  const patternLength = patternCharacters.length;
  const locations: RepetitionPatternLocation[] = [];

  for (const startIndex of starts) {
    const location = buildPatternLocation(entries, startIndex, patternLength);
    if (location) {
      locations.push(location);
    }
  }

  return locations;
}

function buildPatternLocation(
  entries: RepetitionPatternCorpusEntry[],
  startIndex: number,
  patternLength: number,
): RepetitionPatternLocation | undefined {
  if (patternLength <= 0) {
    return undefined;
  }

  const endIndex = startIndex + patternLength;
  const startEntryIndex = findEntryIndex(entries, startIndex);
  const endEntryIndex = findEntryIndex(entries, endIndex - 1);
  if (startEntryIndex === -1 || endEntryIndex === -1 || startEntryIndex !== endEntryIndex) {
    return undefined;
  }

  const entry = entries[startEntryIndex]!;
  return {
    chapterId: entry.chapterId,
    chapterFilePath: entry.chapterFilePath,
    unitIndex: entry.unitIndex,
    fragmentIndex: entry.fragmentIndex,
    lineIndex: entry.lineIndex,
    sourceSentence: entry.sourceText,
    translatedSentence: entry.translatedText,
    globalStartIndex: startIndex,
    globalEndIndex: endIndex,
    sentenceStartIndex: entry.globalStartIndex,
    sentenceEndIndex: entry.globalEndIndex,
    matchStartInSentence: startIndex - entry.globalStartIndex,
    matchEndInSentence: endIndex - entry.globalStartIndex,
  };
}

function findEntryIndex(
  entries: RepetitionPatternCorpusEntry[],
  position: number,
): number {
  let left = 0;
  let right = entries.length - 1;

  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const entry = entries[middle]!;
    if (position < entry.globalStartIndex) {
      right = middle - 1;
      continue;
    }
    if (position >= entry.globalEndIndex) {
      left = middle + 1;
      continue;
    }
    return middle;
  }

  return -1;
}

function groupPatternTranslations(
  locations: RepetitionPatternLocation[],
): RepetitionPatternTranslationVariant[] {
  const grouped = new Map<
    string,
    {
      text: string;
      normalizedText: string;
      locations: RepetitionPatternLocation[];
    }
  >();

  for (const location of locations) {
    const normalizedText = normalizeTranslationText(location.translatedSentence);
    const existing = grouped.get(normalizedText);
    if (existing) {
      existing.locations.push(location);
      continue;
    }

    grouped.set(normalizedText, {
      text: location.translatedSentence,
      normalizedText,
      locations: [location],
    });
  }

  return [...grouped.values()]
    .map((group) => ({
      text: group.text,
      normalizedText: group.normalizedText,
      count: group.locations.length,
      locations: group.locations,
    }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.normalizedText.localeCompare(right.normalizedText) ||
        left.text.localeCompare(right.text),
    );
}

function normalizeTranslationText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function findAllOccurrences(text: string[], pattern: string[]): number[] {
  if (pattern.length === 0 || text.length < pattern.length) {
    return [];
  }

  const lps = buildLongestPrefixSuffixTable(pattern);
  const result: number[] = [];
  let textIndex = 0;
  let patternIndex = 0;

  while (textIndex < text.length) {
    if (text[textIndex] === pattern[patternIndex]) {
      textIndex += 1;
      patternIndex += 1;
      if (patternIndex === pattern.length) {
        result.push(textIndex - pattern.length);
        patternIndex = lps[patternIndex - 1] ?? 0;
      }
      continue;
    }

    if (patternIndex === 0) {
      textIndex += 1;
      continue;
    }

    patternIndex = lps[patternIndex - 1] ?? 0;
  }

  return result;
}

function buildLongestPrefixSuffixTable(pattern: string[]): number[] {
  const lps = Array.from({ length: pattern.length }, () => 0);
  let length = 0;
  let index = 1;

  while (index < pattern.length) {
    if (pattern[index] === pattern[length]) {
      length += 1;
      lps[index] = length;
      index += 1;
      continue;
    }

    if (length === 0) {
      lps[index] = 0;
      index += 1;
      continue;
    }

    length = lps[length - 1] ?? 0;
  }

  return lps;
}
