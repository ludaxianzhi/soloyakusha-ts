/**
 * 提供全文级术语扫描器：按连续行聚合全文输入，调用 LLM 抽取实体类术语。
 *
 * 核心特性：
 * - 不按章节或片段批次扫描，而是把全文展平成连续行后再组批
 * - 默认每批最多 8192 字符，尽可能提供更大的上下文
 * - 仅抽取五类术语：人名、地名、专有名词、人物称呼、口癖
 * - 扫描完成后自动回填术语出现总次数与出现文本块数
 * - 支持按出现文本块数排序后的 TopK / TopP 结果裁剪
 *
 * @module glossary/scanner
 */

import type { ChatClient } from "../llm/base.ts";
import { withOutputValidator, withRequestMeta } from "../llm/chat-request.ts";
import type { ChatRequestOptions, LlmRequestMetadata } from "../llm/types.ts";
import { getDefaultPromptManager } from "../prompts/index.ts";
import { NOOP_LOGGER, type Logger } from "../project/logger.ts";
import type { TranslationDocumentManager } from "../project/translation-document-manager.ts";
import {
  Glossary,
  type GlossaryTerm,
  type GlossaryTermCategory,
  type GlossaryTermStatus,
  type GlossaryTextBlock,
} from "./glossary.ts";

export const DEFAULT_FULL_TEXT_GLOSSARY_SCAN_MAX_CHARS = 16384;

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
  occurrenceTopK?: number;
  occurrenceTopP?: number;
  requestOptions?: ChatRequestOptions;
  seedTerms?: GlossaryTerm[];
  /** 每个批次扫描完成后的回调，参数为（已完成批次数, 总批次数）*/
  onBatchProgress?: (completed: number, total: number) => void;
};

export type FullTextGlossaryScanResult = {
  glossary: Glossary;
  lines: FullTextGlossaryScanLine[];
  batches: FullTextGlossaryScanBatch[];
};

type RawScannedEntity = {
  term: string;
  category?: GlossaryTermCategory;
};

export class FullTextGlossaryScanner {
  private readonly logger: Logger;

  constructor(
    private readonly chatClient: ChatClient,
    logger?: Logger,
  ) {
    this.logger = logger ?? NOOP_LOGGER;
  }

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

    this.logger.info?.(
      `开始全文术语扫描，共 ${lines.length} 行，分 ${batches.length} 个批次`,
    );

    let completedBatches = 0;
    const batchResults = await Promise.all(
      batches.map(async (batch) => {
        const extractedEntities = await this.scanBatch(batch, options);

        completedBatches += 1;
        this.logger.info?.(
          `批次 ${batch.batchIndex + 1}/${batches.length} 完成，本批提取 ${extractedEntities.length} 个候选术语`,
        );
        options.onBatchProgress?.(completedBatches, batches.length);

        return {
          batchIndex: batch.batchIndex,
          extractedEntities,
        };
      }),
    );

    for (const result of batchResults.sort((left, right) => left.batchIndex - right.batchIndex)) {
      for (const entity of result.extractedEntities) {
        const existing = glossary.getTerm(entity.term);
        glossary.addTerm(mergeScannedTerm(existing, entity));
      }
    }

    this.logger.info?.("正在统计术语频次...");
    glossary.updateOccurrenceStats(
      lines.map<GlossaryTextBlock>((line) => ({
        blockId: line.blockId,
        text: line.text,
      })),
    );
    const filteredTerms = glossary
      .getAllTerms()
      .filter(
        (term) => term.totalOccurrenceCount > 0 && term.textBlockOccurrenceCount > 1,
      )
      .sort(compareFormattedTerms);
    const retainedTerms = applyOccurrenceRankingFilters(filteredTerms, options);
    const retainedTermSet = new Set(retainedTerms.map((term) => term.term));

    for (const term of glossary.getAllTerms()) {
      if (!retainedTermSet.has(term.term)) {
        glossary.removeTerm(term.term);
      }
    }

    if (retainedTerms.length < filteredTerms.length) {
      this.logger.info?.(
        `频次裁剪完成，按排名保留 ${retainedTerms.length}/${filteredTerms.length} 个术语`,
      );
    }

    this.logger.info?.(`术语扫描完成，共提取 ${glossary.getAllTerms().length} 个术语`);

    return {
      glossary,
      lines: [...lines],
      batches,
    };
  }

  async scanBatch(
    batch: FullTextGlossaryScanBatch,
    options: Pick<FullTextGlossaryScanOptions, "requestOptions"> = {},
  ): Promise<RawScannedEntity[]> {
    const promptManager = await getDefaultPromptManager();
    this.logger.info?.(
      `扫描批次 ${batch.batchIndex + 1}（行 ${batch.startLineNumber}–${batch.endLineNumber}，约 ${batch.charCount} 字符）`,
    );

    const renderedPrompt = promptManager.renderPrompt("glossary.fullTextScan", {
      startLineLabel: formatScanLineLabel(batch.startLineNumber),
      endLineLabel: formatScanLineLabel(batch.endLineNumber),
      batchText: batch.text,
    });
    const response = await this.chatClient.singleTurnRequest(
      renderedPrompt.userPrompt,
      withRequestMeta(
        withOutputValidator(
          buildScanRequestOptions(options.requestOptions, renderedPrompt.systemPrompt),
          (responseText) => {
            parseScanResponse(responseText);
          },
        ),
        this.buildBatchRequestMeta(batch),
      ),
    );
    return parseScanResponse(response);
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

  private buildBatchRequestMeta(batch: FullTextGlossaryScanBatch): LlmRequestMetadata {
    return {
      label: "术语提取-全文扫描",
      feature: "术语提取",
      operation: "全文扫描",
      component: "FullTextGlossaryScanner",
      context: {
        batchIndex: batch.batchIndex + 1,
        startLineNumber: batch.startLineNumber,
        endLineNumber: batch.endLineNumber,
        charCount: batch.charCount,
      },
    };
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
      .map((line) => `${formatScanLineLabel(line.lineNumber)}: ${line.text}`)
      .join("\n"),
  };
}

function buildScanRequestOptions(
  requestOptions: ChatRequestOptions | undefined,
  systemPrompt: string,
): ChatRequestOptions {
  const requestConfig = requestOptions?.requestConfig;

  return {
    ...requestOptions,
    requestConfig: {
      ...requestConfig,
      temperature: requestConfig?.temperature ?? 0,
      systemPrompt: composeSystemPrompt(systemPrompt, requestConfig?.systemPrompt),
    },
  };
}

function formatScanLineLabel(lineNumber: number): string {
  return `L${lineNumber.toString().padStart(5, "0")}`;
}

function composeSystemPrompt(basePrompt: string, overridePrompt: string | undefined): string {
  const normalizedOverride = overridePrompt?.trim();
  if (!normalizedOverride) {
    return basePrompt;
  }

  return `${basePrompt}\n\n${normalizedOverride}`;
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
    return [
      {
        term,
        category,
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
      category: scanned.category,
    };
  }

  return {
    term: existing.term,
    translation: existing.translation,
    category: existing.category ?? scanned.category,
    totalOccurrenceCount: existing.totalOccurrenceCount,
    textBlockOccurrenceCount: existing.textBlockOccurrenceCount,
    description: existing.description,
  };
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
    right.textBlockOccurrenceCount - left.textBlockOccurrenceCount ||
    right.totalOccurrenceCount - left.totalOccurrenceCount ||
    left.term.localeCompare(right.term)
  );
}

function applyOccurrenceRankingFilters<T extends {
  totalOccurrenceCount: number;
  textBlockOccurrenceCount: number;
  term: string;
}>(
  terms: ReadonlyArray<T>,
  options: Pick<FullTextGlossaryScanOptions, "occurrenceTopK" | "occurrenceTopP">,
): T[] {
  if (terms.length === 0) {
    validateOccurrenceRankingOptions(options);
    return [];
  }

  validateOccurrenceRankingOptions(options);

  let retainCount = terms.length;
  if (options.occurrenceTopK !== undefined) {
    retainCount = Math.min(retainCount, options.occurrenceTopK);
  }
  if (options.occurrenceTopP !== undefined) {
    retainCount = Math.min(retainCount, Math.ceil(terms.length * options.occurrenceTopP));
  }

  return terms.slice(0, retainCount);
}

function validateOccurrenceRankingOptions(
  options: Pick<FullTextGlossaryScanOptions, "occurrenceTopK" | "occurrenceTopP">,
): void {
  const { occurrenceTopK, occurrenceTopP } = options;
  if (
    occurrenceTopK !== undefined &&
    (!Number.isInteger(occurrenceTopK) || occurrenceTopK <= 0)
  ) {
    throw new Error("occurrenceTopK 必须为正整数");
  }

  if (
    occurrenceTopP !== undefined &&
    (!Number.isFinite(occurrenceTopP) || occurrenceTopP <= 0 || occurrenceTopP > 1)
  ) {
    throw new Error("occurrenceTopP 必须大于 0 且不超过 1");
  }
}
