import { describe, expect, test } from 'bun:test';
import type {
  ChapterTranslationEditorDocument,
  ChapterTranslationEditorRepetitionMatch,
  GlossaryTerm,
} from '../../app/types.ts';
import {
  applyAssistantDraftToSelection,
  buildAssistantGlossaryHints,
  buildAssistantRepetitionHints,
  buildChapterTranslationEditorSelectionSignature,
  collectChapterTranslationEditorSelection,
} from './chapter-editor-assistant.ts';

describe('chapter editor assistant helpers', () => {
  const draft = {
    baseline: {
      chapterId: 1,
      format: 'naturedialog',
      unitCount: 3,
      rawLineCount: 8,
    },
    content: '○ 源A\n● 译A\n\n○ 源B\n● 译B\n\n○ 源C\n● 译C',
    units: [
      {
        unitIndex: 0,
        fragmentIndex: 0,
        lineIndex: 0,
        sourceText: '源A',
        translatedText: '译A',
        targetCandidates: [],
      },
      {
        unitIndex: 1,
        fragmentIndex: 0,
        lineIndex: 1,
        sourceText: '源B',
        translatedText: '译B',
        targetCandidates: [],
      },
      {
        unitIndex: 2,
        fragmentIndex: 0,
        lineIndex: 2,
        sourceText: '源C',
        translatedText: '译C',
        targetCandidates: [],
      },
    ],
    diagnostics: [],
    glossaryMatches: [],
    repetitionMatches: [],
  } satisfies ChapterTranslationEditorDocument;

  test('collects every touched unit from a selection', () => {
    const selectionEnd = draft.content.indexOf('○ 源C') - 1;
    const selection = collectChapterTranslationEditorSelection({
      content: draft.content,
      draft,
      from: 0,
      to: selectionEnd,
    });

    expect(selection?.units.map((unit) => unit.unitIndex)).toEqual([0, 1]);
    expect(buildChapterTranslationEditorSelectionSignature(selection)).toBe('0,1');
  });

  test('builds glossary and repetition hints without duplicates', () => {
    const glossaryTerms: GlossaryTerm[] = [
      { term: '源A', translation: '译A' },
      { term: '源A', translation: '译A' },
    ];
    const selection = collectChapterTranslationEditorSelection({
      content: draft.content,
      draft,
      from: 0,
      to: draft.content.indexOf('● 译A') + 3,
    });
    expect(selection).not.toBeNull();

    const repetitionMatches: ChapterTranslationEditorRepetitionMatch[] = [
      { unitIndex: 0, text: '源A', matchStartInSentence: 0, matchEndInSentence: 1, hoverText: 'pattern A' },
      { unitIndex: 0, text: '源A', matchStartInSentence: 0, matchEndInSentence: 1, hoverText: 'pattern A' },
    ];

    expect(buildAssistantGlossaryHints(selection!, glossaryTerms)).toEqual(['源A -> 译A']);
    expect(buildAssistantRepetitionHints(selection!, repetitionMatches)).toEqual(['pattern A']);
  });

  test('applies assistant drafts line-by-line', () => {
    const selectionEnd = draft.content.indexOf('○ 源C') - 1;
    const selection = collectChapterTranslationEditorSelection({
      content: draft.content,
      draft,
      from: 0,
      to: selectionEnd,
    });
    expect(selection).not.toBeNull();

    expect(
      applyAssistantDraftToSelection({
        content: draft.content,
        draft,
        selection: selection!,
        draftText: 'X\nY',
      }),
    ).toBe('○ 源A\n● X\n\n○ 源B\n● Y\n\n○ 源C\n● 译C');
  });
});
