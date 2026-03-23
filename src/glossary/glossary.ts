/**
 * 提供内存中的术语表模型，负责术语增删查改、筛选、统计与渲染。
 *
 * 本模块实现 {@link Glossary} 类，用于：
 * - 维护术语（原文）与译文的映射关系
 * - 维护术语类别、翻译状态和出现次数统计
 * - 根据原文内容筛选相关术语
 * - 渲染术语表为 CSV 格式供 LLM 参考
 *
 * @module glossary/glossary
 */

export const GLOSSARY_TERM_CATEGORIES = [
  "personName",
  "placeName",
  "properNoun",
  "personTitle",
  "catchphrase",
] as const;

export type GlossaryTermCategory = (typeof GLOSSARY_TERM_CATEGORIES)[number];

export const GLOSSARY_TERM_STATUSES = ["translated", "untranslated"] as const;

export type GlossaryTermStatus = (typeof GLOSSARY_TERM_STATUSES)[number];

export type GlossaryTerm = {
  term: string;
  translation: string;
  description?: string;
  status?: GlossaryTermStatus;
  category?: GlossaryTermCategory;
  totalOccurrenceCount?: number;
  textBlockOccurrenceCount?: number;
};

export type ResolvedGlossaryTerm = Omit<
  GlossaryTerm,
  "status" | "totalOccurrenceCount" | "textBlockOccurrenceCount"
> & {
  status: GlossaryTermStatus;
  totalOccurrenceCount: number;
  textBlockOccurrenceCount: number;
};

export type GlossaryTextBlock = {
  blockId: string;
  text: string;
};

/**
 * 术语表模型，负责维护术语集合并按上下文筛选、渲染可用条目。
 *
 * 核心功能：
 * - getAllTerms / getTerm: 获取术语
 * - addTerm / removeTerm / updateTerm: 术语增删改
 * - filterTerms: 按文本内容筛选相关术语
 * - updateOccurrenceStats: 基于文本块重算出现统计
 * - renderAsCsv / filterAndRenderAsCsv: 渲染为 CSV 格式
 */
export class Glossary {
  private readonly terms = new Map<string, ResolvedGlossaryTerm>();

  constructor(terms: GlossaryTerm[] = []) {
    for (const term of terms) {
      const normalized = normalizeGlossaryTerm(term);
      this.terms.set(normalized.term, normalized);
    }
  }

  getAllTerms(): ResolvedGlossaryTerm[] {
    return [...this.terms.values()].map(cloneResolvedGlossaryTerm);
  }

  getTerm(termText: string): ResolvedGlossaryTerm | undefined {
    const term = this.terms.get(termText);
    return term ? cloneResolvedGlossaryTerm(term) : undefined;
  }

  addTerm(term: GlossaryTerm): void {
    const normalized = normalizeGlossaryTerm(term);
    this.terms.set(normalized.term, normalized);
  }

  removeTerm(termText: string): void {
    this.terms.delete(termText);
  }

  updateTerm(termText: string, newTerm: GlossaryTerm): void {
    const normalized = normalizeGlossaryTerm(newTerm);
    if (termText !== normalized.term) {
      this.terms.delete(termText);
    }
    this.terms.set(normalized.term, normalized);
  }

  filterTerms(text: string): ResolvedGlossaryTerm[] {
    return this.getAllTerms().filter((term) => text.includes(term.term));
  }

  updateOccurrenceStats(
    textBlocks: ReadonlyArray<string | GlossaryTextBlock>,
  ): ResolvedGlossaryTerm[] {
    const normalizedBlocks = normalizeTextBlocks(textBlocks);
    for (const [termText, term] of this.terms.entries()) {
      let totalOccurrenceCount = 0;
      let textBlockOccurrenceCount = 0;

      for (const block of normalizedBlocks) {
        const matches = countOccurrences(block.text, termText);
        totalOccurrenceCount += matches;
        if (matches > 0) {
          textBlockOccurrenceCount += 1;
        }
      }

      this.terms.set(termText, {
        ...term,
        totalOccurrenceCount,
        textBlockOccurrenceCount,
      });
    }

    return this.getAllTerms();
  }

  renderAsCsv(
    terms: ReadonlyArray<GlossaryTerm | ResolvedGlossaryTerm> = this.getAllTerms(),
  ): string {
    const lines = [
      "Term,Translation,Status,Category,TotalOccurrences,TextBlockOccurrences,Description",
    ];
    for (const term of terms) {
      const normalized = normalizeGlossaryTerm(term);
      lines.push(
        [
          normalized.term,
          normalized.translation,
          normalized.status,
          normalized.category ?? "",
          normalized.totalOccurrenceCount.toString(),
          normalized.textBlockOccurrenceCount.toString(),
          normalized.description ?? "",
        ]
          .map(escapeCsvCell)
          .join(","),
      );
    }
    return lines.join("\n");
  }

  filterAndRenderAsCsv(text: string): string {
    return this.renderAsCsv(this.filterTerms(text));
  }
}

export function normalizeGlossaryTerm(term: GlossaryTerm): ResolvedGlossaryTerm {
  const trimmedTerm = term.term?.trim();
  if (!trimmedTerm) {
    throw new Error("术语 term 不能为空");
  }

  const translation = typeof term.translation === "string" ? term.translation : "";
  const status = resolveGlossaryTermStatus(term.status, translation);
  const category = resolveGlossaryTermCategory(term.category);

  return {
    term: trimmedTerm,
    translation,
    description: normalizeOptionalString(term.description),
    status,
    category,
    totalOccurrenceCount: normalizeNonNegativeInteger(term.totalOccurrenceCount),
    textBlockOccurrenceCount: normalizeNonNegativeInteger(term.textBlockOccurrenceCount),
  };
}

function resolveGlossaryTermStatus(
  status: GlossaryTerm["status"],
  translation: string,
): GlossaryTermStatus {
  if (!status) {
    return translation.trim().length > 0 ? "translated" : "untranslated";
  }

  if ((GLOSSARY_TERM_STATUSES as readonly string[]).includes(status)) {
    return status;
  }

  throw new Error(`不支持的术语状态: ${status}`);
}

function resolveGlossaryTermCategory(
  category: GlossaryTerm["category"],
): GlossaryTermCategory | undefined {
  if (!category) {
    return undefined;
  }

  if ((GLOSSARY_TERM_CATEGORIES as readonly string[]).includes(category)) {
    return category;
  }

  throw new Error(`不支持的术语类别: ${category}`);
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value.length > 0 ? value : undefined;
}

function normalizeNonNegativeInteger(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }

  return Math.max(0, Math.trunc(value));
}

function normalizeTextBlocks(
  textBlocks: ReadonlyArray<string | GlossaryTextBlock>,
): GlossaryTextBlock[] {
  const mergedBlocks = new Map<string, string>();
  for (const [index, block] of textBlocks.entries()) {
    const normalized =
      typeof block === "string"
        ? {
            blockId: `block-${index}`,
            text: block,
          }
        : {
            blockId: block.blockId,
            text: block.text,
          };

    const existingText = mergedBlocks.get(normalized.blockId);
    mergedBlocks.set(
      normalized.blockId,
      existingText ? `${existingText}\n${normalized.text}` : normalized.text,
    );
  }

  return [...mergedBlocks.entries()].map(([blockId, text]) => ({
    blockId,
    text,
  }));
}

function countOccurrences(text: string, term: string): number {
  if (term.length === 0 || text.length === 0) {
    return 0;
  }

  let count = 0;
  let startIndex = 0;
  while (startIndex <= text.length - term.length) {
    const matchIndex = text.indexOf(term, startIndex);
    if (matchIndex === -1) {
      break;
    }

    count += 1;
    startIndex = matchIndex + term.length;
  }

  return count;
}

function cloneResolvedGlossaryTerm(term: ResolvedGlossaryTerm): ResolvedGlossaryTerm {
  return {
    ...term,
  };
}

function escapeCsvCell(value: string): string {
  const escaped = value.replaceAll('"', '""');
  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
}
