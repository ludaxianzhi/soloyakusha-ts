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
  type ResolvedGlossaryTerm,
} from "./glossary.ts";

export type FullTextGlossaryTranscribeOptions = {
  requestOptions?: ChatRequestOptions;
  onBatchProgress?: (completed: number, total: number) => void;
};

export type TranscribedTerm = {
  term: string;
  translation: string;
  description: string;
};

export type FullTextGlossaryTranscribeResult = {
  appliedTermCount: number;
  totalBatches: number;
  completedBatches: number;
  skippedBatches: number;
};

type RawTranscribedTerm = {
  term: string;
  translation: string;
  description: string;
};

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

      const transcribedTerms = await this.transcribeBatch(batch, untranslatedTerms, {
        requestOptions: options.requestOptions,
      });

      const applied = this.applyTranscribedTerms(glossary, transcribedTerms);
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

  async transcribeBatch(
    batch: FullTextGlossaryScanBatch,
    untranslatedTerms: ReadonlyArray<ResolvedGlossaryTerm>,
    options: Pick<FullTextGlossaryTranscribeOptions, "requestOptions"> = {},
  ): Promise<RawTranscribedTerm[]> {
    const promptManager = await getDefaultPromptManager();
    const renderedPrompt = promptManager.renderPrompt("glossary.termTranscribe", {
      lines: batch.lines.map((line) => line.text),
      untranslatedTerms: untranslatedTerms.map((term) => ({
        term: term.term,
        description: term.description,
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
      const existing = glossary.getTerm(transcribed.term);
      if (!existing) {
        this.logger.warn?.(`术语不存在，无法更新: ${transcribed.term}`);
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
          description,
          category: existing.category,
          totalOccurrenceCount: existing.totalOccurrenceCount,
          textBlockOccurrenceCount: existing.textBlockOccurrenceCount,
        });
      }

      const translation = transcribed.translation?.trim();
      if (translation && existing.translation !== translation) {
        glossary.applyTranslations([{ term: transcribed.term, translation }]);
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
