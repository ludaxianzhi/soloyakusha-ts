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
});

function createService(): ProjectService {
  return new ProjectService(
    { emit: () => undefined, addLog: () => undefined } as any,
    { removeWorkspace: async () => undefined } as any,
    {} as any,
    {} as any,
  );
}