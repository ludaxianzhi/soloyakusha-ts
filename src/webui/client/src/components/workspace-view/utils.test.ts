import { describe, expect, test } from 'bun:test';
import { buildChapterImportGroups } from './utils.ts';

describe('buildChapterImportGroups', () => {
  test('builds recursive groups from nested chapter paths', () => {
    const groups = buildChapterImportGroups([
      asChapter(1, 'main/001.txt'),
      asChapter(2, 'branch/a/010.txt'),
      asChapter(3, 'branch/a/sub/011.txt'),
      asChapter(4, 'branch/b/020.txt'),
    ]);

    expect(groups).toEqual([
      {
        id: 'branch',
        name: 'branch',
        path: 'branch',
        depth: 0,
        chapterIds: [2, 3, 4],
      },
      {
        id: 'branch/a',
        name: 'a',
        path: 'branch/a',
        depth: 1,
        chapterIds: [2, 3],
      },
      {
        id: 'branch/a/sub',
        name: 'sub',
        path: 'branch/a/sub',
        depth: 2,
        chapterIds: [3],
      },
      {
        id: 'branch/b',
        name: 'b',
        path: 'branch/b',
        depth: 1,
        chapterIds: [4],
      },
      {
        id: 'main',
        name: 'main',
        path: 'main',
        depth: 0,
        chapterIds: [1],
      },
    ]);
  });

  test('groups root-level files into a dedicated root group', () => {
    const groups = buildChapterImportGroups([
      asChapter(1, '001.txt'),
      asChapter(2, 'scenario/002.txt'),
      asChapter(3, '003.txt'),
    ]);

    expect(groups).toEqual([
      {
        id: '.',
        name: '根目录文件',
        path: '.',
        depth: 0,
        chapterIds: [1, 3],
      },
      {
        id: 'scenario',
        name: 'scenario',
        path: 'scenario',
        depth: 0,
        chapterIds: [2],
      },
    ]);
  });

  test('returns empty result when there are no chapters', () => {
    expect(buildChapterImportGroups([])).toEqual([]);
  });

  test('normalizes legacy appended path prefix for group display', () => {
    const groups = buildChapterImportGroups([
      asChapter(1, 'sources/appended/1775700464510/1未依/001.txt'),
      asChapter(2, 'sources/appended/1775700464510/2漂音/002.txt'),
    ]);

    expect(groups).toEqual([
      {
        id: '1未依',
        name: '1未依',
        path: '1未依',
        depth: 0,
        chapterIds: [1],
      },
      {
        id: '2漂音',
        name: '2漂音',
        path: '2漂音',
        depth: 0,
        chapterIds: [2],
      },
    ]);
  });
});

function asChapter(id: number, filePath: string) {
  const fileName = filePath.split('/').pop() ?? filePath;
  const displayName = fileName.replace(/\.[^.]+$/, '');
  return {
    id,
    filePath,
    displayName,
    fragmentCount: 0,
    sourceLineCount: 0,
    translatedLineCount: 0,
    hasTranslationData: false,
  };
}
