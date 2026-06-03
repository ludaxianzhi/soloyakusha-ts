import { TranslationFileHandlerFactory } from "../../file-handlers/factory.ts";
import type {
  ParsedTranslationDocument,
  ParsedTranslationUnitBlock,
  TranslationFileHandler,
} from "../../file-handlers/base.ts";
import type { ChapterEntry, TranslationUnit } from "../types.ts";

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
  comment?: string;
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
  preProcessors?: Array<{ id: string; params?: Record<string, unknown> }>;
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
    fragment.source.lines.map((sourceText, lineIndex, sourceLines) => {
      const translatedText = fragment.translation.lines[lineIndex] ?? "";
      const targetCandidates = [...(fragment.meta?.targetGroups?.[lineIndex] ?? [])];
      if (targetCandidates.length === 0) {
        targetCandidates.push(translatedText);
      } else {
        targetCandidates[targetCandidates.length - 1] = translatedText;
      }

      return {
        unitIndex:
          chapter.fragments
            .slice(0, fragmentIndex)
            .reduce((sum, current) => sum + current.source.lines.length, 0) + lineIndex,
        fragmentIndex,
        lineIndex,
        sourceText,
        translatedText,
        targetCandidates,
        comment: fragment.meta?.comments?.[lineIndex],
      };
    }),
  );
}

export function createChapterTranslationEditorDocument(input: {
  chapterId: number;
  format: EditableTranslationFormat;
  units: ChapterTranslationEditorUnit[];
  glossaryTerms?: ReadonlyArray<{ term: string; translation?: string }>;
  repetitionMatches?: ReadonlyArray<ChapterTranslationEditorRepetitionMatch>;
  preProcessors?: Array<{ id: string; params?: Record<string, unknown> }>;
}): ChapterTranslationEditorDocument {
  const handler = getEditableTranslationHandler(input.format);
  let content = handler.formatTranslationUnits(
    input.units.map((unit) => ({
      source: unit.sourceText,
      target: normalizeEditorTargets(unit.targetCandidates, unit.translatedText),
    })),
  );

  // 在内容中追加 # comment 行
  if (input.units.some((unit) => unit.comment)) {
    const contentLines = content.split("\n");
    const resultLines: string[] = [];
    let unitIdx = 0;
    for (const line of contentLines) {
      resultLines.push(line);
      if (line.trimStart().startsWith("●")) {
        const comment = input.units[unitIdx]?.comment;
        unitIdx += 1;
        if (comment) {
          resultLines.push(`# ${comment}`);
        }
      }
    }
    content = resultLines.join("\n");
  }

  const parsed = handler.parseTranslationDocument(content);

  return {
    baseline: {
      chapterId: input.chapterId,
      format: input.format,
      unitCount: input.units.length,
      rawLineCount: countNonCommentLines(content),
    },
    content,
    units: input.units.map(cloneEditorUnit),
    diagnostics: [],
    glossaryMatches: collectGlossaryMatches(content, input.glossaryTerms ?? []),
    repetitionMatches: [...(input.repetitionMatches ?? [])],
    preProcessors: input.preProcessors,
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

  if (parsed.units.length !== input.units.length) {
    diagnostics.push({
      ...createDocumentRange(lineOffsets, 1, Math.max(parsed.rawLineCount, 1)),
      severity: "error",
      code: "unit-count-mismatch",
      message: `翻译单元数量不匹配：基线 ${input.units.length} 条，当前解析出 ${parsed.units.length} 条`,
    });
  }

  const hasBlockParseError =
    diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
    parsed.units.length !== input.units.length;

  const updates = hasBlockParseError
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

  const normalizedContent = hasBlockParseError
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
    hasLineCountChange: false,
    lineCountDelta: 0,
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

/**
 * 统计内容中非注释行的数量（即不以 # 开头的行）。
 * 注释行以 # 开头，不计入结构行数，编辑和保存都不会对注释行做变更检测。
 */
function countNonCommentLines(content: string): number {
  return content.split(/\r?\n/).filter((line) => !line.trimStart().startsWith("#")).length;
}
