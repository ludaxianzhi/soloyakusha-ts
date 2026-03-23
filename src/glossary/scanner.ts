/**
 * 提供全文级术语扫描器：按连续行聚合全文输入，调用 LLM 抽取实体类术语。
 *
 * 核心特性：
 * - 不按章节或片段批次扫描，而是把全文展平成连续行后再组批
 * - 默认每批最多 8192 字符，尽可能提供更大的上下文
 * - 仅抽取五类术语：人名、地名、专有名词、人物称呼、口癖
 * - 扫描完成后自动回填术语出现总次数与出现文本块数
 *
 * @module glossary/scanner
 */

import type { ChatClient } from "../llm/base.ts";
import type { ChatRequestOptions } from "../llm/types.ts";
import type { TranslationDocumentManager } from "../project/translation-document-manager.ts";
import {
  Glossary,
  type GlossaryTerm,
  type GlossaryTermCategory,
  type GlossaryTermStatus,
  type GlossaryTextBlock,
} from "./glossary.ts";

export const DEFAULT_FULL_TEXT_GLOSSARY_SCAN_MAX_CHARS = 8192;

const SCAN_CATEGORY_ORDER: Array<GlossaryTermCategory | "uncategorized"> = [
  "personName",
  "placeName",
  "properNoun",
  "personTitle",
  "catchphrase",
  "uncategorized",
];

const SCAN_CATEGORY_LABELS: Record<GlossaryTermCategory | "uncategorized", string> = {
  personName: "人名",
  placeName: "地名",
  properNoun: "专有名词",
  personTitle: "人物称呼",
  catchphrase: "口癖",
  uncategorized: "未分类",
};

const STATUS_LABELS: Record<GlossaryTermStatus, string> = {
  translated: "已翻译",
  untranslated: "未翻译",
};

export type FullTextGlossaryScanLine = {
  lineNumber: number;
  text: string;
  blockId: string;
  chapterId?: number;
  fragmentIndex?: number;
};

export type FullTextGlossaryScanBatch = {
  batchIndex: number;
  startLineNumber: number;
  endLineNumber: number;
  charCount: number;
  text: string;
  lines: FullTextGlossaryScanLine[];
};

export type FullTextGlossaryScanOptions = {
  maxCharsPerBatch?: number;
  requestOptions?: ChatRequestOptions;
  seedTerms?: GlossaryTerm[];
};

export type FullTextGlossaryScanResult = {
  glossary: Glossary;
  lines: FullTextGlossaryScanLine[];
  batches: FullTextGlossaryScanBatch[];
};

type RawScannedEntity = {
  term: string;
  category?: GlossaryTermCategory;
  description?: string;
};

export class FullTextGlossaryScanner {
  constructor(private readonly chatClient: ChatClient) {}

  collectLinesFromDocumentManager(
    documentManager: TranslationDocumentManager,
  ): FullTextGlossaryScanLine[] {
    const lines: FullTextGlossaryScanLine[] = [];
    let lineNumber = 1;

    for (const chapter of documentManager.getAllChapters()) {
      for (const [fragmentIndex, fragment] of chapter.fragments.entries()) {
        const blockId = `chapter:${chapter.id}:fragment:${fragmentIndex}`;
        for (const line of fragment.source.lines) {
          lines.push({
            lineNumber,
            text: line,
            blockId,
            chapterId: chapter.id,
            fragmentIndex,
          });
          lineNumber += 1;
        }
      }
    }

    return lines;
  }

  buildBatches(
    lines: ReadonlyArray<FullTextGlossaryScanLine>,
    options: Pick<FullTextGlossaryScanOptions, "maxCharsPerBatch"> = {},
  ): FullTextGlossaryScanBatch[] {
    const maxCharsPerBatch =
      options.maxCharsPerBatch ?? DEFAULT_FULL_TEXT_GLOSSARY_SCAN_MAX_CHARS;
    if (!Number.isInteger(maxCharsPerBatch) || maxCharsPerBatch <= 0) {
      throw new Error("maxCharsPerBatch 必须为正整数");
    }

    const batches: FullTextGlossaryScanBatch[] = [];
    let currentLines: FullTextGlossaryScanLine[] = [];
    let currentCharCount = 0;

    for (const line of lines) {
      const lineCharCount = line.text.length + 1;
      if (
        currentLines.length > 0 &&
        currentCharCount + lineCharCount > maxCharsPerBatch
      ) {
        batches.push(createScanBatch(batches.length, currentLines, currentCharCount));
        currentLines = [];
        currentCharCount = 0;
      }

      currentLines.push(line);
      currentCharCount += lineCharCount;
    }

    if (currentLines.length > 0) {
      batches.push(createScanBatch(batches.length, currentLines, currentCharCount));
    }

    return batches;
  }

  async scanDocumentManager(
    documentManager: TranslationDocumentManager,
    options: FullTextGlossaryScanOptions = {},
  ): Promise<FullTextGlossaryScanResult> {
    const lines = this.collectLinesFromDocumentManager(documentManager);
    return this.scanLines(lines, options);
  }

  async scanLines(
    lines: ReadonlyArray<FullTextGlossaryScanLine>,
    options: FullTextGlossaryScanOptions = {},
  ): Promise<FullTextGlossaryScanResult> {
    const glossary = new Glossary(options.seedTerms ?? []);
    const batches = this.buildBatches(lines, options);

    for (const batch of batches) {
      const response = await this.chatClient.singleTurnRequest(
        buildScanPrompt(batch),
        buildScanRequestOptions(options.requestOptions),
      );
      const extractedEntities = parseScanResponse(response);
      for (const entity of extractedEntities) {
        const existing = glossary.getTerm(entity.term);
        glossary.addTerm(mergeScannedTerm(existing, entity));
      }
    }

    glossary.updateOccurrenceStats(
      lines.map<GlossaryTextBlock>((line) => ({
        blockId: line.blockId,
        text: line.text,
      })),
    );

    return {
      glossary,
      lines: [...lines],
      batches,
    };
  }

  formatResult(result: FullTextGlossaryScanResult): string {
    const terms = result.glossary.getAllTerms();
    if (terms.length === 0) {
      return "未提取到符合条件的术语。";
    }

    const grouped = new Map<string, typeof terms>();
    for (const category of SCAN_CATEGORY_ORDER) {
      grouped.set(category, []);
    }

    for (const term of terms) {
      const groupKey = term.category ?? "uncategorized";
      grouped.get(groupKey)?.push(term);
    }

    const lines: string[] = [`共提取 ${terms.length} 个术语。`];
    for (const category of SCAN_CATEGORY_ORDER) {
      const categoryTerms = grouped.get(category);
      if (!categoryTerms || categoryTerms.length === 0) {
        continue;
      }

      lines.push("", `[${SCAN_CATEGORY_LABELS[category]}]`);
      for (const term of categoryTerms.sort(compareFormattedTerms)) {
        lines.push(
          `- ${term.term} | 状态: ${STATUS_LABELS[term.status]} | 总出现: ${term.totalOccurrenceCount} | 文本块: ${term.textBlockOccurrenceCount}`,
        );
        if (term.translation.length > 0) {
          lines.push(`  译文: ${term.translation}`);
        }
        if (term.description) {
          lines.push(`  说明: ${term.description}`);
        }
      }
    }

    return lines.join("\n");
  }
}

function createScanBatch(
  batchIndex: number,
  lines: FullTextGlossaryScanLine[],
  charCount: number,
): FullTextGlossaryScanBatch {
  const firstLineNumber = lines[0]?.lineNumber ?? 0;
  const lastLineNumber = lines.at(-1)?.lineNumber ?? firstLineNumber;
  return {
    batchIndex,
    startLineNumber: firstLineNumber,
    endLineNumber: lastLineNumber,
    charCount,
    lines: [...lines],
    text: lines
      .map((line) => `L${line.lineNumber.toString().padStart(5, "0")}: ${line.text}`)
      .join("\n"),
  };
}

function buildScanPrompt(batch: FullTextGlossaryScanBatch): string {
  return [
    "以下内容是按行展开的全文连续片段，不代表独立章节或文本块。",
    "请直接基于这些连续行抽取术语，不要按章节、片段或文本块重组。",
    `当前行号范围：L${batch.startLineNumber.toString().padStart(5, "0")} - L${batch.endLineNumber.toString().padStart(5, "0")}`,
    "",
    "全文行内容：",
    batch.text,
  ].join("\n");
}

function buildScanRequestOptions(
  requestOptions: ChatRequestOptions | undefined,
): ChatRequestOptions {
  const requestConfig = requestOptions?.requestConfig;
  const userSystemPrompt = requestConfig?.systemPrompt;

  return {
    ...requestOptions,
    requestConfig: {
      ...requestConfig,
      temperature: requestConfig?.temperature ?? 0,
      systemPrompt: [
        "你是一个小说/剧情文本术语扫描器。",
        "只提取以下五类：personName（人名）、placeName（地名）、properNoun（专有名词）、personTitle（人物称呼）、catchphrase（口癖）。",
        "禁止输出普通名词、动作、形容词、一般性代词、叙述性短语。",
        "term 必须使用原文中实际出现的写法。",
        "description 用简短中文说明，不超过 20 个字；如果没有必要可省略。",
        '输出必须是严格 JSON，格式为 {"entities":[{"term":"...","category":"personName","description":"..."}]}。',
        '如果没有任何结果，返回 {"entities":[]}。',
        "不要输出 Markdown、解释、代码块或额外文字。",
        userSystemPrompt ?? "",
      ]
        .filter((value) => value.length > 0)
        .join("\n"),
    },
  };
}

function parseScanResponse(responseText: string): RawScannedEntity[] {
  const jsonText = extractJsonPayload(responseText);
  const parsed = JSON.parse(jsonText) as
    | { entities?: unknown }
    | Array<Record<string, unknown>>;

  const rawEntities = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.entities)
      ? parsed.entities
      : [];

  return rawEntities.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const term = normalizeOptionalString(item.term);
    if (!term) {
      return [];
    }

    const category = normalizeCategory(item.category);
    const description = normalizeOptionalString(item.description);
    return [
      {
        term,
        category,
        description,
      },
    ];
  });
}

function extractJsonPayload(responseText: string): string {
  const fencedMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const trimmed = responseText.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) {
    return trimmed.slice(objectStart, objectEnd + 1);
  }

  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    return trimmed.slice(arrayStart, arrayEnd + 1);
  }

  throw new Error("LLM 未返回可解析的 JSON 术语扫描结果");
}

function mergeScannedTerm(
  existing:
    | ReturnType<Glossary["getTerm"]>
    | undefined,
  scanned: RawScannedEntity,
): GlossaryTerm {
  if (!existing) {
    return {
      term: scanned.term,
      translation: "",
      status: "untranslated",
      category: scanned.category,
      description: scanned.description,
    };
  }

  return {
    term: existing.term,
    translation: existing.translation,
    status: existing.status,
    category: existing.category ?? scanned.category,
    totalOccurrenceCount: existing.totalOccurrenceCount,
    textBlockOccurrenceCount: existing.textBlockOccurrenceCount,
    description: mergeDescriptions(existing.description, scanned.description),
  };
}

function mergeDescriptions(
  existing: string | undefined,
  next: string | undefined,
): string | undefined {
  if (!existing) {
    return next;
  }
  if (!next || existing === next) {
    return existing;
  }
  return `${existing} / ${next}`;
}

function normalizeCategory(value: unknown): GlossaryTermCategory | undefined {
  if (
    value === "personName" ||
    value === "placeName" ||
    value === "properNoun" ||
    value === "personTitle" ||
    value === "catchphrase"
  ) {
    return value;
  }

  return undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function compareFormattedTerms(
  left: {
    totalOccurrenceCount: number;
    textBlockOccurrenceCount: number;
    term: string;
  },
  right: {
    totalOccurrenceCount: number;
    textBlockOccurrenceCount: number;
    term: string;
  },
): number {
  return (
    right.totalOccurrenceCount - left.totalOccurrenceCount ||
    right.textBlockOccurrenceCount - left.textBlockOccurrenceCount ||
    left.term.localeCompare(right.term)
  );
}
