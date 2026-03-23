/**
 * 根据章节与片段位置构建翻译上下文视图，聚合术语表与前序翻译参考。
 *
 * 本模块提供翻译上下文的动态构建能力，为当前待翻译片段准备：
 * - 相关术语表条目（基于原文内容自动筛选或全量渲染）
 * - 前序已翻译片段（按配置数量取最近的翻译结果）
 *
 * 上下文视图用于辅助 LLM 理解翻译语境，提高翻译一致性。
 *
 * @module project/context-view
 */

import type { Glossary } from "../glossary/glossary.ts";
import { TranslationDocumentManager } from "./translation-document-manager.ts";
import type {
  ContextPair,
  ContextSettings,
  GlossarySettings,
  TranslationContextEntry,
  TranslationContextType,
} from "./types.ts";

/**
 * 翻译上下文视图，按当前片段汇总术语表与前序翻译参考。
 *
 * 该类以章节 ID 和片段索引为定位，从 {@link TranslationDocumentManager} 中提取：
 * - 当前片段的原文内容
 * - 与原文相关的术语表条目
 * - 指定数量的前序翻译对
 *
 * 术语表筛选：
 * - 当 glossaryConfig.autoFilter 为 true（默认）时，仅返回原文中出现的术语
 * - 否则返回全部术语表内容
 *
 * 前序翻译数量由 context.includeEarlierFragments 控制（默认 2 条）。
 */
export class TranslationContextView {
  constructor(
    readonly chapterId: number,
    readonly fragmentIndex: number,
    private readonly options: {
      documentManager: TranslationDocumentManager;
      context?: ContextSettings;
      glossary?: Glossary;
      glossaryConfig?: GlossarySettings;
    },
  ) {}

  get sourceText(): string {
    return this.options.documentManager.getSourceText(
      this.chapterId,
      this.fragmentIndex,
    );
  }

  getContexts(): TranslationContextEntry[] {
    const contexts: TranslationContextEntry[] = [];

    const glossaryContext = this.getGlossaryContext();
    if (glossaryContext) {
      contexts.push(glossaryContext);
    }

    const precedingContext = this.getPrecedingContext();
    if (precedingContext) {
      contexts.push(precedingContext);
    }

    return contexts.sort((left, right) => right.priority - left.priority);
  }

  getContext(type: TranslationContextType): TranslationContextEntry | undefined {
    if (type === "glossary") {
      return this.getGlossaryContext();
    }

    if (type === "precedingTranslation") {
      return this.getPrecedingContext();
    }

    return undefined;
  }

  getGlossaryContext(): TranslationContextEntry | undefined {
    if (!this.options.glossary) {
      return undefined;
    }

    const autoFilter = this.options.glossaryConfig?.autoFilter ?? true;
    const content = autoFilter
      ? this.options.glossary.filterAndRenderAsCsv(this.sourceText)
      : this.options.glossary.renderAsCsv();

    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length <= 1) {
      return undefined;
    }

    return {
      type: "glossary",
      description: "项目术语表",
      priority: 100,
      content,
    };
  }

  getPrecedingContext(): TranslationContextEntry | undefined {
    const pairs = this.buildPrecedingContextPairs();
    if (pairs.length === 0) {
      return undefined;
    }

    return {
      type: "precedingTranslation",
      description: "前序翻译参考",
      priority: 60,
      pairs,
    };
  }

  private buildPrecedingContextPairs(): ContextPair[] {
    const maxFragments = this.options.context?.includeEarlierFragments ?? 2;
    if (maxFragments <= 0) {
      return [];
    }

    const pairs: ContextPair[] = [];
    for (const chapterEntry of this.options.documentManager.getAllChapters()) {
      const limit =
        chapterEntry.id === this.chapterId
          ? Math.min(this.fragmentIndex, chapterEntry.fragments.length)
          : chapterEntry.fragments.length;

      for (let currentIndex = 0; currentIndex < limit; currentIndex += 1) {
        const fragment = chapterEntry.fragments[currentIndex];
        if (!fragment?.isTranslated || fragment.translation.lines.length === 0) {
          continue;
        }

        pairs.push(
          createContextPair(
            chapterEntry.id,
            currentIndex,
            fragment.hash,
            this.options.documentManager,
          ),
        );
      }

      if (chapterEntry.id === this.chapterId) {
        break;
      }
    }

    return pairs.slice(-maxFragments);
  }
}

function createContextPair(
  chapterId: number,
  fragmentIndex: number,
  fragmentHash: string,
  documentManager: TranslationDocumentManager,
): ContextPair {
  return {
    chapterId,
    fragmentIndex,
    fragmentHash,
    sourceText: documentManager.getSourceText(chapterId, fragmentIndex),
    translatedText: documentManager.getTranslatedText(chapterId, fragmentIndex),
  };
}
