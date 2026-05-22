/**
 * 提供全文级术语解释与翻译器：按预分批次为未翻译术语调用 LLM 生成解释和译文。
 *
 * 核心特性：
 * - 接收预分好的文本批次（复用 Scanner 的 FullTextGlossaryScanBatch）
 * - 对每个批次筛选在当前批次文本中出现的未翻译术语
 * - 跳过无未翻译术语的批次
 * - 调用 LLM 同时生成 description（解释）和 translation（译文）
 * - 支持进度回调、日志记录和模型输出记录
 *
 * @module glossary/transcriber
 */

import type { ChatClient } from "../llm/base.ts";
import { withOutputValidator, withRequestMeta } from "../llm/chat-request.ts";
import type { ChatRequestOptions, LlmRequestMetadata } from "../llm/types.ts";
import { getDefaultPromptManager } from "../prompts/index.ts";
import { NOOP_LOGGER, type Logger } from "../project/logger.ts";
import type { FullTextGlossaryScanBatch } from "./scanner.ts";
import {
  Glossary,
  buildGlossaryTermKey,
  type ResolvedGlossaryTerm,
} from "./glossary.ts";

export type FullTextGlossaryTranscribeOptions = {
  requestOptions?: ChatRequestOptions;
  onBatchProgress?: (completed: number, total: number) => void;
  maxTermsPerRequest?: number;
  onChunkProgress?: (progress: {
    chunkIndex: number;
    totalChunks: number;
    termCount: number;
  }) => void;
};

export type TranscribedTerm = {
  term: string;
  translation: string;
  description: string;
  from?: string;
};

export type GlossaryTranscribeReferenceTerm = {
  term: string;
  translation: string;
  from?: string;
  description?: string;
};

export type FullTextGlossaryTranscribeResult = {
  appliedTermCount: number;
  totalBatches: number;
  completedBatches: number;
  skippedBatches: number;
};

export type TranscribeBatchChunksResult = {
  appliedTermCount: number;
  chunkCount: number;
};

type RawTranscribedTerm = {
  term: string;
  translation: string;
  description: string;
  from?: string;
};

export const DEFAULT_GLOSSARY_TRANSCRIBE_MAX_TERMS_PER_REQUEST = 10;

export class FullTextGlossaryTranscriber {
  private readonly logger: Logger;

  constructor(
    private readonly chatClient: ChatClient,
    logger?: Logger,
  ) {
    this.logger = logger ?? NOOP_LOGGER;
  }

  async transcribeBatches(
    batches: ReadonlyArray<FullTextGlossaryScanBatch>,
    glossary: Glossary,
    options: FullTextGlossaryTranscribeOptions = {},
  ): Promise<FullTextGlossaryTranscribeResult> {
    let appliedTermCount = 0;
    let skippedBatches = 0;
    let completedBatches = 0;

    this.logger.info?.(
      `开始术语解释翻译，共 ${batches.length} 个批次`,
    );

    for (const batch of batches) {
      const untranslatedTerms = glossary.getUntranslatedTermsForText(batch.text);
      if (untranslatedTerms.length === 0) {
        skippedBatches += 1;
        completedBatches += 1;
        options.onBatchProgress?.(completedBatches, batches.length);
        this.logger.info?.(
          `批次 ${batch.batchIndex + 1}/${batches.length} 无未翻译术语，跳过`,
        );
        continue;
      }

      this.logger.info?.(
        `处理批次 ${batch.batchIndex + 1}/${batches.length}（${untranslatedTerms.length} 个未翻译术语）`,
      );

      const result = await this.transcribeBatchInChunks(batch, glossary, {
        requestOptions: options.requestOptions,
        maxTermsPerRequest: options.maxTermsPerRequest,
      });
      const applied = result.appliedTermCount;
      appliedTermCount += applied;
      completedBatches += 1;
      options.onBatchProgress?.(completedBatches, batches.length);

      this.logger.info?.(
        `批次 ${batch.batchIndex + 1}/${batches.length} 完成，应用 ${applied} 个术语解释/译文`,
      );
    }

    this.logger.info?.(
      `术语解释翻译完成：${appliedTermCount} 个术语更新，跳过 ${skippedBatches} 个批次`,
    );

    return {
      appliedTermCount,
      totalBatches: batches.length,
      completedBatches,
      skippedBatches,
    };
  }

  async transcribeBatchInChunks(
    batch: FullTextGlossaryScanBatch,
    glossary: Glossary,
    options: Pick<
      FullTextGlossaryTranscribeOptions,
      "requestOptions" | "maxTermsPerRequest" | "onChunkProgress"
    > = {},
  ): Promise<TranscribeBatchChunksResult> {
    const untranslatedTerms = glossary.getUntranslatedTermsForText(batch.text);
    const maxTermsPerRequest = options.maxTermsPerRequest ?? DEFAULT_GLOSSARY_TRANSCRIBE_MAX_TERMS_PER_REQUEST;
    if (untranslatedTerms.length === 0) {
      return {
        appliedTermCount: 0,
        chunkCount: 0,
      };
    }

    if (!Number.isInteger(maxTermsPerRequest) || maxTermsPerRequest <= 0) {
      throw new Error("maxTermsPerRequest 必须为正整数");
    }

    const termChunks = chunkTerms(untranslatedTerms, maxTermsPerRequest);
    let appliedTermCount = 0;

    for (const [chunkIndex, termChunk] of termChunks.entries()) {
      const pendingChunkTerms = termChunk.filter((term) => glossary.getTerm(term.term, term.from)?.status === "untranslated");
      if (pendingChunkTerms.length === 0) {
        continue;
      }

      // TODO: 未来可在这里实现基于滑动窗口的上下文优化，而不是直接复用整块文本。
      this.logger.info?.(
        `处理术语解释翻译子批次 ${chunkIndex + 1}/${termChunks.length}（${pendingChunkTerms.length} 个术语）`,
      );
      options.onChunkProgress?.({
        chunkIndex: chunkIndex + 1,
        totalChunks: termChunks.length,
        termCount: pendingChunkTerms.length,
      });
      const knownTranslatedTerms = glossary.getTranslatedTermsForText(batch.text);
      const transcribedTerms = await this.transcribeBatch(batch, pendingChunkTerms, {
        knownTranslatedTerms,
        requestOptions: options.requestOptions,
      });
      appliedTermCount += this.applyTranscribedTerms(glossary, transcribedTerms);
    }

    return {
      appliedTermCount,
      chunkCount: termChunks.length,
    };
  }

  async transcribeBatch(
    batch: FullTextGlossaryScanBatch,
    untranslatedTerms: ReadonlyArray<ResolvedGlossaryTerm>,
    options: Pick<FullTextGlossaryTranscribeOptions, "requestOptions"> & {
      knownTranslatedTerms?: ReadonlyArray<GlossaryTranscribeReferenceTerm>;
    } = {},
  ): Promise<RawTranscribedTerm[]> {
    const promptManager = await getDefaultPromptManager();
    const renderedPrompt = promptManager.renderPrompt("glossary.termTranscribe", {
      lines: batch.lines.map((line) => line.text),
      knownTranslatedTerms: options.knownTranslatedTerms?.map((term) => ({
        term: term.term,
        translation: term.translation,
        description: term.description,
        from: term.from,
      })) ?? [],
      untranslatedTerms: untranslatedTerms.map((term) => ({
        term: term.term,
        description: term.description,
        from: term.from,
      })),
    });

    const response = await this.chatClient.singleTurnRequest(
      renderedPrompt.userPrompt,
      withRequestMeta(
        withOutputValidator(
          buildTranscribeRequestOptions(options.requestOptions, renderedPrompt.systemPrompt),
          (responseText) => {
            parseTranscribeResponse(responseText, untranslatedTerms);
          },
        ),
        this.buildBatchRequestMeta(batch, untranslatedTerms.length),
      ),
    );

    return parseTranscribeResponse(response, untranslatedTerms);
  }

  formatResult(result: FullTextGlossaryTranscribeResult): string {
    return [
      `术语解释翻译完成。`,
      `总批次: ${result.totalBatches}`,
      `已完成: ${result.completedBatches}`,
      `已跳过: ${result.skippedBatches}`,
      `已更新术语: ${result.appliedTermCount}`,
    ].join("\n");
  }

  applyTranscribedTerms(
    glossary: Glossary,
    transcribedTerms: ReadonlyArray<RawTranscribedTerm>,
  ): number {
    let applied = 0;
    for (const transcribed of transcribedTerms) {
      const existing = glossary.getTerm(transcribed.term, transcribed.from);
      if (!existing) {
        this.logger.warn?.(`术语不存在，无法更新: ${transcribed.term}${transcribed.from ? ` (from: ${transcribed.from})` : ""}`);
        continue;
      }

      if (existing.status !== "untranslated") {
        continue;
      }

      const description = transcribed.description?.trim();
      if (description && description !== existing.description) {
        glossary.updateTerm(transcribed.term, {
          term: transcribed.term,
          translation: existing.translation,
          from: existing.from,
          description,
          category: existing.category,
          totalOccurrenceCount: existing.totalOccurrenceCount,
          textBlockOccurrenceCount: existing.textBlockOccurrenceCount,
        }, existing.from);
      }

      const translation = transcribed.translation?.trim();
      if (translation && existing.translation !== translation) {
        glossary.applyTranslations([{ term: transcribed.term, translation, from: existing.from }]);
      }

      applied += 1;
    }

    return applied;
  }

  private buildBatchRequestMeta(
    batch: FullTextGlossaryScanBatch,
    untranslatedTermCount: number,
  ): LlmRequestMetadata {
    return {
      label: "术语解释翻译",
      feature: "术语处理",
      operation: "解释翻译",
      component: "FullTextGlossaryTranscriber",
      context: {
        batchIndex: batch.batchIndex + 1,
        startLineNumber: batch.startLineNumber,
        endLineNumber: batch.endLineNumber,
        untranslatedTermCount,
      },
    };
  }
}

function chunkTerms(
  terms: ReadonlyArray<ResolvedGlossaryTerm>,
  chunkSize: number,
): ResolvedGlossaryTerm[][] {
  const result: ResolvedGlossaryTerm[][] = [];
  for (let index = 0; index < terms.length; index += chunkSize) {
    result.push(terms.slice(index, index + chunkSize));
  }
  return result;
}

function buildTranscribeRequestOptions(
  requestOptions: ChatRequestOptions | undefined,
  systemPrompt: string,
): ChatRequestOptions {
  const requestConfig = requestOptions?.requestConfig;

  return {
    ...requestOptions,
    requestConfig: {
      ...requestConfig,
      temperature: requestConfig?.temperature ?? 0.3,
      systemPrompt: composeSystemPrompt(systemPrompt, requestConfig?.systemPrompt),
    },
  };
}

function composeSystemPrompt(basePrompt: string, overridePrompt: string | undefined): string {
  const normalizedOverride = overridePrompt?.trim();
  if (!normalizedOverride) {
    return basePrompt;
  }

  return `${basePrompt}\n\n${normalizedOverride}`;
}

function parseTranscribeResponse(
  responseText: string,
  allowedTerms: ReadonlyArray<ResolvedGlossaryTerm>,
): RawTranscribedTerm[] {
  const jsonText = extractJsonPayload(responseText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("术语解释翻译结果不是合法 JSON");
  }

  if (!isRecord(parsed)) {
    throw new Error("术语解释翻译结果必须是 JSON 对象");
  }

  const termsArray = parsed.terms;
  if (!Array.isArray(termsArray)) {
    throw new Error("术语解释翻译结果缺少 terms 数组");
  }

  const allowedTermSet = new Set(allowedTerms.map((t) => t.term));
  const seenTerms = new Set<string>();
  const results: RawTranscribedTerm[] = [];

  for (const [index, entry] of termsArray.entries()) {
    if (!isRecord(entry)) {
      throw new Error(`terms[${index}] 必须是对象`);
    }

    const term = typeof entry.term === "string" ? entry.term.trim() : "";
    const translation = typeof entry.translation === "string" ? entry.translation.trim() : "";
    const description = typeof entry.description === "string" ? entry.description.trim() : "";

    if (!term) {
      throw new Error(`terms[${index}].term 不能为空`);
    }
    if (!allowedTermSet.has(term)) {
      continue;
    }
    if (seenTerms.has(term)) {
      throw new Error(`terms 返回了重复术语: ${term}`);
    }

    seenTerms.add(term);
    results.push({ term, translation, description });
  }

  return results;
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

  throw new Error("LLM 未返回可解析的 JSON 术语解释翻译结果");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
