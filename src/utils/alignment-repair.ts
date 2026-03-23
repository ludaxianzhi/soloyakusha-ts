/**
 * 提供“对齐检查 + 补充翻译”工具：先检查行数，再通过对齐算法定位漏翻行，并调用 LLM 仅补齐缺失译文。
 *
 * 设计目标：
 * - 先做轻量行数检查，只有不等时才进入对齐与补翻流程
 * - 利用现有 TextAligner 找出可能遗漏的翻译单元
 * - 通过单元 ID + JSON Schema 约束 LLM 只返回“漏翻 ID + 补翻译文”
 *
 * @module utils/alignment-repair
 */

import type { ChatClient } from "../llm/base.ts";
import type { ChatRequestOptions, JsonObject } from "../llm/types.ts";
import { TEXT_ALIGN_PLACEHOLDER, TextAligner } from "./text-align.ts";

export const DEFAULT_ALIGNMENT_REPAIR_ID_PREFIX = "u";
export const ALIGNMENT_REPAIR_MISSING_MARKER = "<MISSING>";

export type AlignmentRepairUnit = {
  id: string;
  sourceIndex: number;
  sourceText: string;
  alignedTranslation?: string;
  missing: boolean;
};

export type AlignmentRepairAnalysis = {
  sourceLineCount: number;
  targetLineCount: number;
  lineCountMatches: boolean;
  missingUnitCount: number;
  missingUnitIds: string[];
  units: AlignmentRepairUnit[];
  comparisonText: string;
};

export type AlignmentRepairSuggestion = {
  id: string;
  translation: string;
};

export type AlignmentRepairAnalyzeOptions = {
  idPrefix?: string;
};

export type AlignmentRepairRequestOptions = AlignmentRepairAnalyzeOptions & {
  requestOptions?: ChatRequestOptions;
};

export type AlignmentRepairResult = {
  analysis: AlignmentRepairAnalysis;
  prompt?: string;
  responseText?: string;
  responseSchema?: JsonObject;
  repairs: AlignmentRepairSuggestion[];
  unresolvedIds: string[];
};

export class AlignmentRepairTool {
  constructor(
    private readonly aligner: TextAligner,
    private readonly chatClient: ChatClient,
  ) {}

  async analyze(
    sourceLines: ReadonlyArray<string>,
    targetLines: ReadonlyArray<string>,
    options: AlignmentRepairAnalyzeOptions = {},
  ): Promise<AlignmentRepairAnalysis> {
    const idPrefix = normalizeIdPrefix(options.idPrefix);
    const sourceTexts = [...sourceLines];
    const targetTexts = [...targetLines];

    if (sourceTexts.length === 0) {
      return {
        sourceLineCount: 0,
        targetLineCount: targetTexts.length,
        lineCountMatches: targetTexts.length === 0,
        missingUnitCount: 0,
        missingUnitIds: [],
        units: [],
        comparisonText: "",
      };
    }

    if (sourceTexts.length === targetTexts.length) {
      const units = sourceTexts.map<AlignmentRepairUnit>((sourceText, sourceIndex) => ({
        id: buildUnitId(idPrefix, sourceIndex),
        sourceIndex,
        sourceText,
        alignedTranslation: targetTexts[sourceIndex],
        missing: false,
      }));
      return createAnalysis(sourceTexts.length, targetTexts.length, units);
    }

    const alignedTranslations =
      targetTexts.length === 0
        ? Array<string>(sourceTexts.length).fill(TEXT_ALIGN_PLACEHOLDER)
        : await this.aligner.alignTexts(sourceTexts, targetTexts);
    const units = sourceTexts.map<AlignmentRepairUnit>((sourceText, sourceIndex) => {
      const alignedTranslation = alignedTranslations[sourceIndex];
      const missing =
        !alignedTranslation || alignedTranslation === TEXT_ALIGN_PLACEHOLDER;

      return {
        id: buildUnitId(idPrefix, sourceIndex),
        sourceIndex,
        sourceText,
        alignedTranslation: missing ? undefined : alignedTranslation,
        missing,
      };
    });

    return createAnalysis(sourceTexts.length, targetTexts.length, units);
  }

  async repairMissingTranslations(
    sourceLines: ReadonlyArray<string>,
    targetLines: ReadonlyArray<string>,
    options: AlignmentRepairRequestOptions = {},
  ): Promise<AlignmentRepairResult> {
    const analysis = await this.analyze(sourceLines, targetLines, options);
    if (analysis.lineCountMatches || analysis.missingUnitIds.length === 0) {
      return {
        analysis,
        repairs: [],
        unresolvedIds: [],
      };
    }

    const responseSchema = buildRepairResponseSchema(analysis.missingUnitIds);
    const prompt = buildAlignmentRepairPrompt(analysis, responseSchema);
    const responseText = await this.chatClient.singleTurnRequest(
      prompt,
      buildAlignmentRepairRequestOptions(options.requestOptions, responseSchema),
    );
    const repairs = parseAlignmentRepairResponse(responseText, new Set(analysis.missingUnitIds));

    return {
      analysis,
      prompt,
      responseText,
      responseSchema,
      repairs,
      unresolvedIds: analysis.missingUnitIds.filter(
        (id) => !repairs.some((repair) => repair.id === id),
      ),
    };
  }
}

function createAnalysis(
  sourceLineCount: number,
  targetLineCount: number,
  units: AlignmentRepairUnit[],
): AlignmentRepairAnalysis {
  const missingUnitIds = units.filter((unit) => unit.missing).map((unit) => unit.id);
  return {
    sourceLineCount,
    targetLineCount,
    lineCountMatches: sourceLineCount === targetLineCount,
    missingUnitCount: missingUnitIds.length,
    missingUnitIds,
    comparisonText: buildComparisonText(units),
    units,
  };
}

function buildComparisonText(units: ReadonlyArray<AlignmentRepairUnit>): string {
  return units
    .map((unit) =>
      [
        `${unit.id} | SOURCE | ${unit.sourceText}`,
        `${unit.id} | TARGET | ${
          unit.missing
            ? ALIGNMENT_REPAIR_MISSING_MARKER
            : (unit.alignedTranslation ?? ALIGNMENT_REPAIR_MISSING_MARKER)
        }`,
      ].join("\n"),
    )
    .join("\n");
}

function buildAlignmentRepairPrompt(
  analysis: AlignmentRepairAnalysis,
  responseSchema: JsonObject,
): string {
  return [
    "你是翻译补漏助手。下面给出按翻译单元编号后的原文/现有译文对照表。",
    "请只补全 TARGET 为 <MISSING> 的单元。",
    "不要输出完整译文，不要重复输出已有译文，不要解释原因。",
    "只返回满足 JSON Schema 的 JSON 对象。",
    "",
    `原文行数: ${analysis.sourceLineCount}`,
    `译文行数: ${analysis.targetLineCount}`,
    `待补翻 ID: ${analysis.missingUnitIds.join(", ")}`,
    "",
    "对照表：",
    analysis.comparisonText,
    "",
    "JSON Schema：",
    JSON.stringify(responseSchema, null, 2),
  ].join("\n");
}

function buildAlignmentRepairRequestOptions(
  requestOptions: ChatRequestOptions | undefined,
  responseSchema: JsonObject,
): ChatRequestOptions {
  return {
    ...requestOptions,
    requestConfig: {
      ...(requestOptions?.requestConfig ?? {}),
      extraBody: {
        ...(requestOptions?.requestConfig?.extraBody ?? {}),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "alignment_repair_result",
            strict: true,
            schema: responseSchema,
          },
        },
      },
    },
  };
}

function buildRepairResponseSchema(missingIds: ReadonlyArray<string>): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      repairs: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              enum: [...missingIds],
            },
            translation: {
              type: "string",
              minLength: 1,
            },
          },
          required: ["id", "translation"],
        },
      },
    },
    required: ["repairs"],
  };
}

function parseAlignmentRepairResponse(
  responseText: string,
  allowedIds: ReadonlySet<string>,
): AlignmentRepairSuggestion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch (error) {
    throw new Error(
      `补翻返回结果不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("补翻返回结果必须是 JSON 对象");
  }

  const repairsValue = parsed.repairs;
  if (!Array.isArray(repairsValue)) {
    throw new Error("补翻返回结果缺少 repairs 数组");
  }

  const seenIds = new Set<string>();
  return repairsValue.map<AlignmentRepairSuggestion>((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`repairs[${index}] 必须是对象`);
    }

    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const translation =
      typeof entry.translation === "string" ? entry.translation.trim() : "";
    if (!id) {
      throw new Error(`repairs[${index}].id 必须是非空字符串`);
    }
    if (!allowedIds.has(id)) {
      throw new Error(`补翻返回了未请求的 ID: ${id}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`补翻返回了重复的 ID: ${id}`);
    }
    if (!translation) {
      throw new Error(`repairs[${index}].translation 必须是非空字符串`);
    }

    seenIds.add(id);
    return {
      id,
      translation,
    };
  });
}

function buildUnitId(idPrefix: string, sourceIndex: number): string {
  return `${idPrefix}${(sourceIndex + 1).toString().padStart(4, "0")}`;
}

function normalizeIdPrefix(idPrefix: string | undefined): string {
  const normalized = (idPrefix ?? DEFAULT_ALIGNMENT_REPAIR_ID_PREFIX).trim();
  if (!normalized) {
    throw new Error("idPrefix 不能为空");
  }

  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
