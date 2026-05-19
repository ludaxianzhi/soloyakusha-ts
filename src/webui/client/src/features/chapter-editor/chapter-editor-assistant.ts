import type {
  ChapterTranslationEditorDocument,
  ChapterTranslationEditorRepetitionMatch,
  EditableTranslationFormat,
  GlossaryTerm,
} from '../../app/types.ts';

export type ChapterTranslationEditorSelectionUnit = {
  unitIndex: number;
  fragmentIndex: number;
  lineIndex: number;
  sourceText: string;
  translatedText: string;
  currentTranslation: string;
};

export type ChapterTranslationEditorSelection = {
  from: number;
  to: number;
  text: string;
  units: ChapterTranslationEditorSelectionUnit[];
};

export function collectChapterTranslationEditorSelection(input: {
  content: string;
  draft: ChapterTranslationEditorDocument;
  from: number;
  to: number;
}): ChapterTranslationEditorSelection | null {
  const start = Math.max(0, Math.min(input.from, input.to));
  const end = Math.max(start, Math.max(input.from, input.to));
  if (start === end) {
    return null;
  }

  const lineRanges = buildLineRanges(input.content);
  const selectedLineIndexes = new Set<number>();
  lineRanges.forEach((range, index) => {
    if (rangesOverlap(start, end, range.from, range.to)) {
      selectedLineIndexes.add(index);
    }
  });

  const blocks = parseDisplayBlocks(input.content, input.draft.baseline.format);
  const units = blocks
    .map((block) => {
      if (!block.lineIndexes.some((lineIndex) => selectedLineIndexes.has(lineIndex))) {
        return null;
      }

      const draftUnit = input.draft.units[block.unitIndex];
      return {
        unitIndex: draftUnit?.unitIndex ?? block.unitIndex,
        fragmentIndex: draftUnit?.fragmentIndex ?? 0,
        lineIndex: draftUnit?.lineIndex ?? block.sourceLineIndex,
        sourceText: block.sourceText,
        translatedText: block.translatedText,
        currentTranslation: block.translatedText,
      } satisfies ChapterTranslationEditorSelectionUnit;
    })
    .filter((unit): unit is ChapterTranslationEditorSelectionUnit => unit !== null);

  if (units.length === 0) {
    return null;
  }

  return {
    from: start,
    to: end,
    text: input.content.slice(start, end),
    units,
  };
}

export function buildChapterTranslationEditorSelectionSignature(
  selection: ChapterTranslationEditorSelection | null,
): string {
  if (!selection) {
    return '';
  }

  return selection.units.map((unit) => unit.unitIndex).join(',');
}

export function buildAssistantGlossaryHints(
  selection: ChapterTranslationEditorSelection,
  glossaryTerms: GlossaryTerm[],
): string[] {
  const hints = new Set<string>();
  for (const unit of selection.units) {
    for (const term of glossaryTerms) {
      const trimmedTerm = term.term.trim();
      if (!trimmedTerm) {
        continue;
      }
      if (unit.sourceText.includes(trimmedTerm) || unit.currentTranslation.includes(trimmedTerm)) {
        hints.add(
          term.translation.trim()
            ? `${trimmedTerm} -> ${term.translation.trim()}${term.description ? `（${term.description}）` : ''}`
            : trimmedTerm,
        );
      }
    }
  }
  return [...hints];
}

export function buildAssistantRepetitionHints(
  selection: ChapterTranslationEditorSelection,
  repetitionMatches: ChapterTranslationEditorRepetitionMatch[],
): string[] {
  const unitIndexSet = new Set(selection.units.map((unit) => unit.unitIndex));
  const hints = new Set<string>();
  for (const match of repetitionMatches) {
    if (unitIndexSet.has(match.unitIndex)) {
      hints.add(match.hoverText);
    }
  }
  return [...hints];
}

export function applyAssistantDraftToSelection(input: {
  content: string;
  draft: ChapterTranslationEditorDocument;
  selection: ChapterTranslationEditorSelection;
  draftText: string;
}): string | null {
  const draftLines = input.draftText.trimEnd().split(/\r?\n/);
  if (draftLines.length !== input.selection.units.length) {
    return null;
  }

  const blocks = parseDisplayBlocks(input.content, input.draft.baseline.format);
  const selectedUnitIndexSet = new Set(input.selection.units.map((unit) => unit.unitIndex));
  const selectedBlocks = blocks.filter((block) => selectedUnitIndexSet.has(block.unitIndex));
  if (selectedBlocks.length !== draftLines.length) {
    return null;
  }

  const nextLines = input.content.split(/\r?\n/);
  for (let index = 0; index < selectedBlocks.length; index += 1) {
    const block = selectedBlocks[index];
    if (!block) {
      return null;
    }
    const draftLine = draftLines[index] ?? '';
    const lastTargetLineIndex = block.targetLineIndexes.at(-1);
    if (typeof lastTargetLineIndex !== 'number') {
      return null;
    }
    const originalLine = nextLines[lastTargetLineIndex];
    if (typeof originalLine !== 'string') {
      return null;
    }
    nextLines[lastTargetLineIndex] = replaceMarkedLineBody(originalLine, draftLine);
  }

  return nextLines.join('\n');
}

/**
 * 计算当前编辑内容相对于草稿的译文增量变更。
 * 返回结果包含 canCompute（是否能正确计算）和 deltas（译文增量数组）。
 * 当 canCompute 为 false 时表示内容结构异常，deltas 为空。
 */
export function computeTranslationDeltas(input: {
  content: string;
  format: EditableTranslationFormat;
  draftUnits: ReadonlyArray<{ fragmentIndex: number; lineIndex: number; translatedText: string }>;
}): { canCompute: boolean; deltas: Array<{ fragmentIndex: number; lineIndex: number; text: string }> } {
  const blocks = parseDisplayBlocks(input.content, input.format);
  if (blocks.length !== input.draftUnits.length) return { canCompute: false, deltas: [] };
  const deltas: Array<{ fragmentIndex: number; lineIndex: number; text: string }> = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const draftUnit = input.draftUnits[i];
    if (!block || !draftUnit) continue;
    if (block.translatedText === draftUnit.translatedText) continue;
    deltas.push({
      fragmentIndex: draftUnit.fragmentIndex,
      lineIndex: draftUnit.lineIndex,
      text: block.translatedText,
    });
  }
  return { canCompute: true, deltas };
}

type DisplayBlock = {
  unitIndex: number;
  lineIndexes: number[];
  sourceLineIndex: number;
  targetLineIndexes: number[];
  sourceText: string;
  translatedText: string;
};

function parseDisplayBlocks(content: string, format: EditableTranslationFormat): DisplayBlock[] {
  const lines = content.split(/\r?\n/);
  if (format === 'm3t') {
    return parseM3TBlocks(lines);
  }
  return parseNatureDialogBlocks(lines);
}

function parseNatureDialogBlocks(lines: string[]): DisplayBlock[] {
  const blocks: DisplayBlock[] = [];
  let block: DisplayBlock | null = null;

  const flush = () => {
    if (block && block.targetLineIndexes.length > 0) {
      blocks.push(block);
    }
    block = null;
  };

  lines.forEach((rawLine, index) => {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flush();
      return;
    }

    if (trimmed.startsWith('○')) {
      const body = trimmed.slice(1).trim();
      if (!block) {
        block = {
          unitIndex: blocks.length,
          lineIndexes: [index],
          sourceLineIndex: index,
          targetLineIndexes: [],
          sourceText: body,
          translatedText: '',
        };
      } else {
        block.lineIndexes.push(index);
        block.targetLineIndexes.push(index);
        block.translatedText = body;
      }
      return;
    }

    if (trimmed.startsWith('●')) {
      const body = trimmed.slice(1).trim();
      if (!block) {
        return;
      }
      block.lineIndexes.push(index);
      block.targetLineIndexes.push(index);
      block.translatedText = body;
      flush();
    }
  });

  flush();
  return blocks;
}

function parseM3TBlocks(lines: string[]): DisplayBlock[] {
  const blocks: DisplayBlock[] = [];
  let block: DisplayBlock | null = null;
  let pendingNameLineIndex: number | null = null;

  const flush = () => {
    if (block && block.targetLineIndexes.length > 0) {
      blocks.push(block);
    }
    block = null;
    pendingNameLineIndex = null;
  };

  lines.forEach((rawLine, index) => {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flush();
      return;
    }

    if (trimmed.startsWith('○ NAME:')) {
      pendingNameLineIndex = index;
      return;
    }

    if (trimmed.startsWith('○')) {
      const body = trimmed.slice(1).trim();
      if (!block) {
        block = {
          unitIndex: blocks.length,
          lineIndexes: pendingNameLineIndex !== null ? [pendingNameLineIndex, index] : [index],
          sourceLineIndex: index,
          targetLineIndexes: [],
          sourceText: body,
          translatedText: '',
        };
      } else {
        block.lineIndexes.push(index);
        block.targetLineIndexes.push(index);
        block.translatedText = body;
      }
      pendingNameLineIndex = null;
      return;
    }

    if (trimmed.startsWith('●')) {
      const body = trimmed.slice(1).trim();
      if (!block) {
        return;
      }
      block.lineIndexes.push(index);
      block.targetLineIndexes.push(index);
      block.translatedText = body;
      flush();
    }
  });

  flush();
  return blocks;
}

function buildLineRanges(content: string): Array<{ from: number; to: number; text: string }> {
  const lines = content.split(/\r?\n/);
  const ranges: Array<{ from: number; to: number; text: string }> = [];
  let offset = 0;

  for (const text of lines) {
    const from = offset;
    const to = from + text.length;
    ranges.push({ from, to, text });
    const newlineLength = content.slice(to, to + 2) === '\r\n' ? 2 : content.slice(to, to + 1) === '\n' ? 1 : 0;
    offset = to + newlineLength;
  }

  return ranges;
}

function rangesOverlap(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return aFrom <= bTo && aTo >= bFrom;
}

/**
 * 客户端预处理：对文本应用预处理器步骤（当前只支持 text-replace）。
 */
function clientSidePreProcess(
  text: string,
  preProcessors: Array<{ id: string; params?: Record<string, unknown> }>,
): string {
  let result = text;
  for (const step of preProcessors) {
    if (step.id && step.id !== 'text-replace') continue;
    const matchRegex = step.params?.matchRegex as string | undefined;
    const replacement = (step.params?.replacement as string) ?? '';
    const filterRegex = step.params?.filterRegex as string | undefined;
    if (!matchRegex) continue;
    let matchRe: RegExp;
    try { matchRe = new RegExp(matchRegex, 'g'); } catch { continue; }
    let filterRe: RegExp | undefined;
    if (filterRegex) {
      try { filterRe = new RegExp(filterRegex); } catch { continue; }
    }
    result = result
      .split('\n')
      .map((line) => {
        if (filterRe && !filterRe.test(line)) return line;
        return line.replace(matchRe, replacement);
      })
      .join('\n');
  }
  return result;
}

/**
 * 切换内容中源文行的预处理版本。
 * 启用时：将源文行替换为预处理后的版本。
 * 禁用时：恢复为原始源文。
 * 译文行保持不变。
 */
export function togglePreProcessorInContent(
  content: string,
  format: EditableTranslationFormat,
  draftUnits: ReadonlyArray<{ sourceText: string }>,
  enable: boolean,
  preProcessors?: Array<{ id: string; params?: Record<string, unknown> }>,
): string | null {
  const blocks = parseDisplayBlocks(content, format);
  if (blocks.length !== draftUnits.length) return null;
  const lines = content.split('\n');
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const draftUnit = draftUnits[i];
    if (!block || !draftUnit) return null;
    const sourceLineIndex = block.sourceLineIndex;
    const originalLine = lines[sourceLineIndex];
    if (typeof originalLine !== 'string') return null;
    let nextSourceText: string;
    if (enable) {
      nextSourceText = clientSidePreProcess(draftUnit.sourceText, preProcessors ?? []);
    } else {
      nextSourceText = draftUnit.sourceText;
    }
    lines[sourceLineIndex] = replaceMarkedLineBody(originalLine, nextSourceText);
  }
  return lines.join('\n');
}

function replaceMarkedLineBody(rawLine: string, nextBody: string): string {
  const trimmedStart = rawLine.trimStart();
  const leadingWhitespaceLength = rawLine.length - trimmedStart.length;
  const leadingWhitespace = rawLine.slice(0, leadingWhitespaceLength);
  if (trimmedStart.startsWith('○') || trimmedStart.startsWith('●')) {
    const marker = trimmedStart[0] ?? '';
    const hasSpace = trimmedStart.slice(1).startsWith(' ');
    return `${leadingWhitespace}${marker}${hasSpace ? ' ' : ''}${nextBody}`;
  }
  return nextBody;
}
