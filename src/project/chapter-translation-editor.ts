import { TranslationFileHandlerFactory } from "../file-handlers/factory.ts";
import type {
  ParsedTranslationDocument,
  ParsedTranslationUnitBlock,
  TranslationFileHandler,
} from "../file-handlers/base.ts";
import type { ChapterEntry, TranslationUnit } from "./types.ts";

export const EDITABLE_TRANSLATION_FORMATS = ["naturedialog", "m3t"] as const;

export type EditableTranslationFormat = (typeof EDITABLE_TRANSLATION_FORMATS)[number];
export type ChapterTranslationEditorSeverity = "error" | "warning";
export type ChapterTranslationEditorGlossaryMatchKind =
  | "sourceTerm"
  | "targetTranslation";

export interface ChapterTranslationEditorUnit {
  unitIndex: number;
  fragmentIndex: number;
  lineIndex: number;
  sourceText: string;
  translatedText: string;
  targetCandidates: string[];
}

export interface ChapterTranslationEditorBaseline {
  chapterId: number;
  format: EditableTranslationFormat;
  unitCount: number;
  rawLineCount: number;
}

export interface ChapterTranslationEditorRange {
  from: number;
  to: number;
  startLineNumber: number;
  endLineNumber: number;
}

export interface ChapterTranslationEditorDiagnostic
  extends ChapterTranslationEditorRange {
  severity: ChapterTranslationEditorSeverity;
  code: string;
  message: string;
  unitIndex?: number;
}

export interface ChapterTranslationEditorGlossaryMatch {
  from: number;
  to: number;
  text: string;
  term: string;
  translation?: string;
  kind: ChapterTranslationEditorGlossaryMatchKind;
}

export interface ChapterTranslationEditorRepetitionMatch {
  unitIndex: number;
  text: string;
  matchStartInSentence: number;
  matchEndInSentence: number;
  hoverText: string;
}

export interface ChapterTranslationEditorLineUpdate {
  unitIndex: number;
  fragmentIndex: number;
  lineIndex: number;
  sourceText: string;
  previousText: string;
  nextText: string;
  changed: boolean;
}

export interface ChapterTranslationEditorDocument {
  baseline: ChapterTranslationEditorBaseline;
  content: string;
  units: ChapterTranslationEditorUnit[];
  diagnostics: ChapterTranslationEditorDiagnostic[];
  glossaryMatches: ChapterTranslationEditorGlossaryMatch[];
  repetitionMatches: ChapterTranslationEditorRepetitionMatch[];
}

export interface ChapterTranslationEditorValidationResult {
  baseline: ChapterTranslationEditorBaseline;
  content: string;
  normalizedContent: string;
  parsedUnitCount: number;
  rawLineCount: number;
  hasLineCountChange: boolean;
  lineCountDelta: number;
  diagnostics: ChapterTranslationEditorDiagnostic[];
  updates: ChapterTranslationEditorLineUpdate[];
  canApply: boolean;
}

export function buildChapterTranslationEditorUnits(
  chapter: ChapterEntry,
): ChapterTranslationEditorUnit[] {
  return chapter.fragments.flatMap((fragment, fragmentIndex) =>
    fragment.source.lines.map((sourceText, lineIndex, sourceLines) => ({
      unitIndex:
        chapter.fragments
          .slice(0, fragmentIndex)
          .reduce((sum, current) => sum + current.source.lines.length, 0) + lineIndex,
      fragmentIndex,
      lineIndex,
      sourceText,
      translatedText: fragment.translation.lines[lineIndex] ?? "",
      targetCandidates: [...(fragment.meta?.targetGroups?.[lineIndex] ?? [])],
    })),
  );
}

export function createChapterTranslationEditorDocument(input: {
  chapterId: number;
  format: EditableTranslationFormat;
  units: ChapterTranslationEditorUnit[];
  glossaryTerms?: ReadonlyArray<{ term: string; translation?: string }>;
  repetitionMatches?: ReadonlyArray<ChapterTranslationEditorRepetitionMatch>;
}): ChapterTranslationEditorDocument {
  const handler = getEditableTranslationHandler(input.format);
  const content = handler.formatTranslationUnits(
    input.units.map((unit) => ({
      source: unit.sourceText,
      target: normalizeEditorTargets(unit.targetCandidates, unit.translatedText),
    })),
  );
  const parsed = handler.parseTranslationDocument(content);

  return {
    baseline: {
      chapterId: input.chapterId,
      format: input.format,
      unitCount: input.units.length,
      rawLineCount: parsed.rawLineCount,
    },
    content,
    units: input.units.map(cloneEditorUnit),
    diagnostics: [],
    glossaryMatches: collectGlossaryMatches(content, input.glossaryTerms ?? []),
    repetitionMatches: [...(input.repetitionMatches ?? [])],
  };
}

export function validateChapterTranslationEditorContent(input: {
  baseline: ChapterTranslationEditorBaseline;
  units: ChapterTranslationEditorUnit[];
  content: string;
}): ChapterTranslationEditorValidationResult {
  const handler = getEditableTranslationHandler(input.baseline.format);
  const parsed = handler.parseTranslationDocument(input.content);
  const diagnostics: ChapterTranslationEditorDiagnostic[] = [];
  const lineOffsets = buildLineOffsets(input.content);

  if (parsed.rawLineCount !== input.baseline.rawLineCount) {
    diagnostics.push({
      ...createDocumentRange(lineOffsets, 1, Math.max(parsed.rawLineCount, 1)),
      severity: "warning",
      code: "line-count-changed",
      message: `文本总行数发生变化：基线 ${input.baseline.rawLineCount} 行，当前 ${parsed.rawLineCount} 行`,
    });
  }

  if (parsed.units.length !== input.units.length) {
    diagnostics.push({
      ...createDocumentRange(lineOffsets, 1, Math.max(parsed.rawLineCount, 1)),
      severity: "error",
      code: "unit-count-mismatch",
      message: `翻译单元数量不匹配：基线 ${input.units.length} 条，当前解析出 ${parsed.units.length} 条`,
    });
  }

  const comparableCount = Math.min(parsed.blocks.length, input.units.length);
  for (let index = 0; index < comparableCount; index += 1) {
    const expected = input.units[index]!;
    const block = parsed.blocks[index]!;
    if (block.unit.source !== expected.sourceText) {
      diagnostics.push({
        ...createBlockRange(lineOffsets, block),
        severity: "error",
        code: "source-mismatch",
        message: `第 ${index + 1} 条源文发生变化，编辑器模块只允许修改译文`,
        unitIndex: expected.unitIndex,
      });
    }
  }

  const updates =
    diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
    parsed.units.length !== input.units.length
      ? []
      : input.units.map((expected, index) => {
          const parsedUnit = parsed.units[index]!;
          const nextText = parsedUnit.target.at(-1) ?? "";
          return {
            unitIndex: expected.unitIndex,
            fragmentIndex: expected.fragmentIndex,
            lineIndex: expected.lineIndex,
            sourceText: expected.sourceText,
            previousText: expected.translatedText,
            nextText,
            changed: nextText !== expected.translatedText,
          } satisfies ChapterTranslationEditorLineUpdate;
        });

  const normalizedContent = diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ? input.content
    : handler.formatTranslationUnits(
        parsed.units.map((unit) => ({
          source: unit.source,
          target: normalizeEditorTargets(unit.target),
        })),
      );

  return {
    baseline: input.baseline,
    content: input.content,
    normalizedContent,
    parsedUnitCount: parsed.units.length,
    rawLineCount: parsed.rawLineCount,
    hasLineCountChange: parsed.rawLineCount !== input.baseline.rawLineCount,
    lineCountDelta: parsed.rawLineCount - input.baseline.rawLineCount,
    diagnostics,
    updates,
    canApply: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
  };
}

function getEditableTranslationHandler(
  format: EditableTranslationFormat,
): TranslationFileHandler {
  return TranslationFileHandlerFactory.getHandler(format);
}

function normalizeEditorTargets(
  targetCandidates: readonly string[],
  fallbackFinalText = "",
): string[] {
  if (targetCandidates.length > 0) {
    return [...targetCandidates];
  }
  return [fallbackFinalText];
}

function cloneEditorUnit(unit: ChapterTranslationEditorUnit): ChapterTranslationEditorUnit {
  return {
    ...unit,
    targetCandidates: [...unit.targetCandidates],
  };
}

function collectGlossaryMatches(
  content: string,
  glossaryTerms: ReadonlyArray<{ term: string; translation?: string }>,
): ChapterTranslationEditorGlossaryMatch[] {
  const matches: ChapterTranslationEditorGlossaryMatch[] = [];
  for (const glossaryTerm of glossaryTerms) {
    const term = glossaryTerm.term.trim();
    if (term) {
      matches.push(
        ...findAllOccurrences(content, term).map(({ from, to }) => ({
          from,
          to,
          text: content.slice(from, to),
          term,
          translation: glossaryTerm.translation?.trim() || undefined,
          kind: "sourceTerm" as const,
        })),
      );
    }

    const translation = glossaryTerm.translation?.trim();
    if (translation) {
      matches.push(
        ...findAllOccurrences(content, translation).map(({ from, to }) => ({
          from,
          to,
          text: content.slice(from, to),
          term,
          translation,
          kind: "targetTranslation" as const,
        })),
      );
    }
  }

  return matches.sort((left, right) => left.from - right.from || right.to - left.to);
}

function findAllOccurrences(
  content: string,
  query: string,
): Array<{ from: number; to: number }> {
  const matches: Array<{ from: number; to: number }> = [];
  let fromIndex = 0;
  while (fromIndex < content.length) {
    const foundIndex = content.indexOf(query, fromIndex);
    if (foundIndex === -1) {
      break;
    }
    matches.push({
      from: foundIndex,
      to: foundIndex + query.length,
    });
    fromIndex = foundIndex + Math.max(query.length, 1);
  }
  return matches;
}

function buildLineOffsets(content: string): number[] {
  const offsets = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function createBlockRange(
  lineOffsets: number[],
  block: ParsedTranslationUnitBlock,
): ChapterTranslationEditorRange {
  return createDocumentRange(lineOffsets, block.startLineNumber, block.endLineNumber);
}

function createDocumentRange(
  lineOffsets: number[],
  startLineNumber: number,
  endLineNumber: number,
): ChapterTranslationEditorRange {
  const normalizedStartLineNumber = Math.max(1, startLineNumber);
  const normalizedEndLineNumber = Math.max(normalizedStartLineNumber, endLineNumber);
  const from = lineOffsets[normalizedStartLineNumber - 1] ?? 0;
  const to =
    lineOffsets[normalizedEndLineNumber] ??
    lineOffsets.at(-1) ??
    from;

  return {
    from,
    to: Math.max(from, to),
    startLineNumber: normalizedStartLineNumber,
    endLineNumber: normalizedEndLineNumber,
  };
}
