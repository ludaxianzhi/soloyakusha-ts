import type { WorkspaceChapterDescriptor } from '../../app/types.ts';

export function formatChapterLabel(chapter: WorkspaceChapterDescriptor): string {
  return `#${chapter.id} ${chapter.filePath}`;
}

export interface ChapterImportGroupDescriptor {
  id: string;
  name: string;
  path: string;
  depth: number;
  chapterIds: number[];
}

interface MutableChapterImportGroupNode {
  id: string;
  name: string;
  path: string;
  depth: number;
  chapterIds: Set<number>;
  children: Map<string, MutableChapterImportGroupNode>;
}

const ROOT_GROUP_ID = '.';
const ROOT_GROUP_NAME = '根目录文件';

export function buildChapterImportGroups(
  chapters: WorkspaceChapterDescriptor[],
): ChapterImportGroupDescriptor[] {
  const rootNode: MutableChapterImportGroupNode = {
    id: '__root__',
    name: '__root__',
    path: '',
    depth: -1,
    chapterIds: new Set<number>(),
    children: new Map<string, MutableChapterImportGroupNode>(),
  };

  for (const chapter of chapters) {
    const normalizedPath = chapter.filePath.replace(/\\/g, '/');
    const segments = normalizedPath.split('/').filter(Boolean);
    const dirSegments = segments.slice(0, -1);

    if (dirSegments.length === 0) {
      const rootGroup = getOrCreateChildNode(rootNode, ROOT_GROUP_ID, ROOT_GROUP_NAME, 0);
      rootGroup.chapterIds.add(chapter.id);
      continue;
    }

    let current = rootNode;
    dirSegments.forEach((segment, index) => {
      const path = dirSegments.slice(0, index + 1).join('/');
      current = getOrCreateChildNode(current, path, segment, index);
      current.chapterIds.add(chapter.id);
    });
  }

  return flattenImportGroups(rootNode);
}

function getOrCreateChildNode(
  parent: MutableChapterImportGroupNode,
  path: string,
  name: string,
  depth: number,
): MutableChapterImportGroupNode {
  const existing = parent.children.get(path);
  if (existing) {
    return existing;
  }
  const next: MutableChapterImportGroupNode = {
    id: path,
    name,
    path,
    depth,
    chapterIds: new Set<number>(),
    children: new Map<string, MutableChapterImportGroupNode>(),
  };
  parent.children.set(path, next);
  return next;
}

function flattenImportGroups(
  rootNode: MutableChapterImportGroupNode,
): ChapterImportGroupDescriptor[] {
  const result: ChapterImportGroupDescriptor[] = [];
  const walk = (node: MutableChapterImportGroupNode): void => {
    const children = [...node.children.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    for (const child of children) {
      result.push({
        id: child.id,
        name: child.name,
        path: child.path,
        depth: child.depth,
        chapterIds: [...child.chapterIds].sort((left, right) => left - right),
      });
      walk(child);
    }
  };
  walk(rootNode);
  return result;
}
