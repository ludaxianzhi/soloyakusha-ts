import { describe, expect, test } from 'bun:test';
import { createTextFragment } from '../../project/types.ts';
import { ProjectService } from './project-service.ts';

describe('ProjectService batch post process', () => {
  test('aligns speaker brackets against each source line instead of the whole fragment', async () => {
    const chapter = {
      id: 1,
      filePath: 'demo.txt',
      fragments: [
        {
          source: createTextFragment(['【叶良】「え？ は、はい」', '……もっとなにかしゃべったほうがよかったか？']),
          translation: createTextFragment(['「诶？ 是、是的」', '【叶良】……我是不是该再多说点什么才好？']),
          pipelineStates: {},
          hash: 'fragment-1',
        },
      ],
    };

    const updates: Array<{ chapterId: number; fragmentIndex: number; lines: string[] }> = [];
    const docManager = {
      getChapterById: (chapterId: number) => (chapterId === 1 ? chapter : undefined),
      updateTranslation: async (chapterId: number, fragmentIndex: number, lines: string[]) => {
        updates.push({ chapterId, fragmentIndex, lines });
        const fragment = chapter.fragments[fragmentIndex];
        if (!fragment) {
          throw new Error(`fragment ${fragmentIndex} not found`);
        }
        fragment.translation = createTextFragment(lines);
      },
    };

    const service = createService();
    const serviceAny = service as any;
    serviceAny.project = {
      getDocumentManager: () => docManager,
    };
    serviceAny.refreshSnapshot = () => undefined;

    await service.runBatchPostProcess([1], ['speaker-bracket-aligner']);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.lines).toEqual([
      '【叶良】「诶？ 是、是的」',
      '……我是不是该再多说点什么才好？',
    ]);
  });

  test('previews only substring replacements on selected chapters', () => {
    const chapter = {
      id: 1,
      filePath: 'chapter-1.txt',
      fragments: [
        {
          source: createTextFragment(['勇者登场', '勇者离开']),
          translation: createTextFragment(['勇者A 和 勇者B 一起登场', '这里不会被改动']),
          pipelineStates: {},
          hash: 'fragment-1',
        },
      ],
    };

    const service = createService();
    const serviceAny = service as any;
    serviceAny.project = {
      getDocumentManager: () => ({
        getChapterById: (chapterId: number) => (chapterId === 1 ? chapter : undefined),
      }),
      getChapterDescriptors: () => [
        {
          id: 1,
          filePath: 'chapter-1.txt',
          displayName: 'Chapter 1',
          fragmentCount: 1,
          sourceLineCount: 2,
          translatedLineCount: 2,
          hasTranslationData: true,
        },
      ],
    };

    const preview = service.previewBatchFindReplace({
      chapterIds: [1],
      sourceRegex: '登场',
      translationRegex: '勇者([AB])',
      replacement: 'Hero-$1',
    });

    expect(preview.totalSelectedChapters).toBe(1);
    expect(preview.affectedChapterCount).toBe(1);
    expect(preview.matchedPairCount).toBe(1);
    expect(preview.totalReplacementCount).toBe(2);
    expect(preview.matches).toEqual([
      {
        chapterId: 1,
        chapterDisplayName: 'Chapter 1',
        chapterFilePath: 'chapter-1.txt',
        fragmentIndex: 0,
        lineIndex: 0,
        sourceText: '勇者登场',
        previousText: '勇者A 和 勇者B 一起登场',
        nextText: 'Hero-A 和 Hero-B 一起登场',
        replacementCount: 2,
      },
    ]);
  });

  test('applies find replace without overwriting the whole sentence', async () => {
    const chapter = {
      id: 1,
      filePath: 'chapter-1.txt',
      fragments: [
        {
          source: createTextFragment(['敌人逼近', '战斗开始']),
          translation: createTextFragment(['敌人A 与 敌人B 已经逼近', '战斗开始']),
          pipelineStates: {},
          hash: 'fragment-1',
        },
      ],
    };

    const updates: Array<{ chapterId: number; fragmentIndex: number; lines: string[] }> = [];
    const service = createService();
    const serviceAny = service as any;
    serviceAny.project = {
      getDocumentManager: () => ({
        getChapterById: (chapterId: number) => (chapterId === 1 ? chapter : undefined),
        updateTranslation: async (chapterId: number, fragmentIndex: number, lines: string[]) => {
          updates.push({ chapterId, fragmentIndex, lines });
          const fragment = chapter.fragments[fragmentIndex];
          if (!fragment) {
            throw new Error(`fragment ${fragmentIndex} not found`);
          }
          fragment.translation = createTextFragment(lines);
        },
      }),
      getChapterDescriptors: () => [
        {
          id: 1,
          filePath: 'chapter-1.txt',
          displayName: 'Chapter 1',
          fragmentCount: 1,
          sourceLineCount: 2,
          translatedLineCount: 2,
          hasTranslationData: true,
        },
      ],
    };
    serviceAny.refreshSnapshot = () => undefined;

    const result = await service.applyBatchFindReplace({
      chapterIds: [1],
      translationRegex: '敌人([AB])',
      replacement: 'Enemy-$1',
    });

    expect(result.updatedLineCount).toBe(1);
    expect(result.totalReplacementCount).toBe(2);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.lines).toEqual([
      'Enemy-A 与 Enemy-B 已经逼近',
      '战斗开始',
    ]);
  });

  test('rejects invalid translation regex during preview', () => {
    const service = createService();
    const serviceAny = service as any;
    serviceAny.project = {
      getDocumentManager: () => ({ getChapterById: () => undefined }),
      getChapterDescriptors: () => [],
    };

    expect(() =>
      service.previewBatchFindReplace({
        chapterIds: [1],
        translationRegex: '([',
        replacement: 'x',
      }),
    ).toThrow('译文 Regex 非法');
  });
});

function createService(): ProjectService {
  return new ProjectService(
    { emit: () => undefined, addLog: () => undefined } as any,
    { removeWorkspace: async () => undefined } as any,
    {} as any,
    {} as any,
  );
}