import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EmbeddingClient } from "../llm/base.ts";
import { TranslationDocumentManager } from "./translation-document-manager.ts";
import { TranslationTopology } from "./topology.ts";
import type {
  ContextIndexData,
  ContextIndexNeighbor,
  FragmentEntry,
} from "./types.ts";

export class ContextIndexBuilder {
  private indexData?: ContextIndexData;

  constructor(
    private readonly embeddingClient: EmbeddingClient,
    private readonly topK = 10,
  ) {}

  async buildIndex(
    documentManager: TranslationDocumentManager,
    topology?: TranslationTopology,
  ): Promise<ContextIndexData> {
    const fragments: Array<{
      chapterId: number;
      fragmentIndex: number;
      hash: string;
      embedding: number[];
    }> = [];

    for (const chapter of documentManager.getAllChapters()) {
      for (const [fragmentIndex, fragment] of chapter.fragments.entries()) {
        fragments.push({
          chapterId: chapter.id,
          fragmentIndex,
          hash: fragment.hash,
          embedding: await this.embeddingClient.getEmbedding(
            documentManager.getSourceText(chapter.id, fragmentIndex),
          ),
        });
      }
    }

    const index: ContextIndexData = {};

    for (const [currentIndex, currentFragment] of fragments.entries()) {
      const candidateFragments = fragments
        .slice(0, currentIndex)
        .filter((candidate) => {
          if (!topology) {
            return candidate.chapterId < currentFragment.chapterId;
          }

          const earlierChapterIds = new Set(
            topology
              .getAllEarlierChapters(currentFragment.chapterId)
              .map((chapter) => chapter.id),
          );
          return (
            earlierChapterIds.has(candidate.chapterId) ||
            candidate.chapterId < currentFragment.chapterId
          );
        });

      if (candidateFragments.length === 0) {
        index[currentFragment.hash] = [];
        continue;
      }

      const neighbors = candidateFragments
        .map<ContextIndexNeighbor>((candidate) => ({
          hash: candidate.hash,
          distance: euclideanDistance(currentFragment.embedding, candidate.embedding),
          chapterId: candidate.chapterId,
          fragmentIndex: candidate.fragmentIndex,
        }))
        .sort((left, right) => left.distance - right.distance)
        .slice(0, this.topK);

      index[currentFragment.hash] = neighbors;
    }

    this.indexData = index;
    return index;
  }

  async saveIndex(indexPath: string): Promise<void> {
    if (!this.indexData) {
      throw new Error("上下文索引尚未构建，请先调用 buildIndex()");
    }

    await mkdir(dirname(indexPath), { recursive: true });
    await writeFile(indexPath, JSON.stringify(this.indexData, null, 2), "utf8");
  }
}

export class PrebuiltContextRetriever {
  private indexData?: ContextIndexData;

  constructor(
    private readonly options: {
      indexPath?: string;
      indexData?: ContextIndexData;
      retrieveK?: number;
    },
  ) {
    this.indexData = options.indexData;
  }

  async load(): Promise<void> {
    if (this.options.indexData) {
      this.indexData = this.options.indexData;
      return;
    }

    if (!this.options.indexPath) {
      throw new Error("未提供上下文索引路径");
    }

    const content = await readFile(this.options.indexPath, "utf8");
    this.indexData = JSON.parse(content) as ContextIndexData;
  }

  async reload(): Promise<void> {
    await this.load();
  }

  getContextFragments(
    chapterId: number,
    fragmentIndex: number,
    documentManager: TranslationDocumentManager,
  ): FragmentEntry[] {
    if (!this.indexData) {
      throw new Error("上下文索引尚未加载");
    }

    const currentFragment = documentManager.getFragmentById(chapterId, fragmentIndex);
    if (!currentFragment) {
      return [];
    }

    const neighbors = (this.indexData[currentFragment.hash] ?? []).slice(
      0,
      this.options.retrieveK ?? 5,
    );

    return neighbors
      .map((neighbor) => documentManager.getFragmentByHash(neighbor.hash)?.fragment)
      .filter((fragment): fragment is FragmentEntry => fragment !== undefined);
  }
}

function euclideanDistance(left: number[], right: number[]): number {
  if (left.length !== right.length) {
    throw new Error("向量维度不匹配");
  }

  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index]! - right[index]!;
    total += delta * delta;
  }

  return Math.sqrt(total);
}
