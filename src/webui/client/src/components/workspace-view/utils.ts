import type { WorkspaceChapterDescriptor } from '../../app/types.ts';

export function formatChapterLabel(chapter: WorkspaceChapterDescriptor): string {
  return `#${chapter.id} ${chapter.filePath}`;
}
