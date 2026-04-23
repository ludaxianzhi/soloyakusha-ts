import type { AlignmentRepairResult } from "../../utils/alignment-repair.ts";
import type { Logger } from "../logger.ts";
import type { PromptTranslationUnit } from "./prompt-manager.ts";
import type { TranslationProcessorTranslation } from "./translation-processor.ts";
import type { SlidingWindowFragment } from "../types.ts";

export const DEFAULT_ALIGNMENT_REPAIR_LINE_DIFF_RATIO = 0.15;

export type TranslationOutputRepairer = {
  repairMissingTranslations(
    sourceLines: ReadonlyArray<string>,
    targetLines: ReadonlyArray<string>,
  ): Promise<AlignmentRepairResult>;
};

export async function repairTranslationOutputLines(params: {
  sourceUnits: ReadonlyArray<PromptTranslationUnit>;
  translations: ReadonlyArray<TranslationProcessorTranslation>;
  outputText: string;
  window?: SlidingWindowFragment;
  outputRepairer?: TranslationOutputRepairer;
  logger?: Logger;
  processorName?: string;
  maxLineDifferenceRatio?: number;
}): Promise<{
  translations: TranslationProcessorTranslation[];
  outputText: string;
  repaired: boolean;
}> {
  const outputIndexes = resolveOutputIndexes(params.sourceUnits.length, params.window);
  const sourceLines = outputIndexes.map((index) => params.sourceUnits[index]!.text);
  const targetLines = splitOutputLines(params.outputText);
  if (sourceLines.length === 0 || sourceLines.length === targetLines.length) {
    return {
      translations: [...params.translations],
      outputText: params.outputText,
      repaired: false,
    };
  }

  const lineDifferenceRatio = Math.abs(sourceLines.length - targetLines.length) / sourceLines.length;
  const maxLineDifferenceRatio =
    params.maxLineDifferenceRatio ?? DEFAULT_ALIGNMENT_REPAIR_LINE_DIFF_RATIO;
  if (lineDifferenceRatio > maxLineDifferenceRatio) {
    throw new Error(
      [
        "译文与原文行数差异过大，已放弃对齐补翻。",
        `原文行数=${sourceLines.length}`,
        `译文行数=${targetLines.length}`,
        `差异比例=${(lineDifferenceRatio * 100).toFixed(1)}%`,
        `阈值=${(maxLineDifferenceRatio * 100).toFixed(1)}%`,
      ].join(" "),
    );
  }

  if (!params.outputRepairer) {
    throw new Error(
      [
        "检测到译文与原文行数不一致，但未配置对齐补翻。",
        `原文行数=${sourceLines.length}`,
        `译文行数=${targetLines.length}`,
        `差异比例=${(lineDifferenceRatio * 100).toFixed(1)}%`,
      ].join(" "),
    );
  }

  params.logger?.warn?.("检测到译文行数不一致，尝试对齐补翻", {
    processorName: params.processorName,
    sourceLineCount: sourceLines.length,
    outputLineCount: targetLines.length,
    lineDifferenceRatio,
  });
  const repairResult = await params.outputRepairer.repairMissingTranslations(
    sourceLines,
    targetLines,
  );
  const resolvedOutputLines = resolveRepairedLines(repairResult);
  const unresolvedUnitIds = repairResult.analysis.units
    .filter((unit, index) => !resolvedOutputLines[index])
    .map((unit) => unit.id);
  if (unresolvedUnitIds.length > 0) {
    throw new Error(`对齐补翻后仍有未解决行: ${unresolvedUnitIds.join(", ")}`);
  }

  const repairedTranslations = params.translations.map((translation) => ({ ...translation }));
  for (let outputIndex = 0; outputIndex < outputIndexes.length; outputIndex += 1) {
    const translationIndex = outputIndexes[outputIndex]!;
    const currentTranslation = repairedTranslations[translationIndex];
    const sourceUnit = params.sourceUnits[translationIndex];
    const resolvedLine = resolvedOutputLines[outputIndex];
    if (!currentTranslation || !sourceUnit || !resolvedLine) {
      continue;
    }

    repairedTranslations[translationIndex] = {
      id: sourceUnit.id,
      translation: resolvedLine,
    };
  }

  params.logger?.info?.("对齐补翻完成", {
    processorName: params.processorName,
    sourceLineCount: sourceLines.length,
    outputLineCountBeforeRepair: targetLines.length,
    outputLineCountAfterRepair: resolvedOutputLines.length,
    repairedLineCount: repairResult.repairs.length,
  });

  return {
    translations: repairedTranslations,
    outputText: resolvedOutputLines.join("\n"),
    repaired: true,
  };
}

function resolveOutputIndexes(
  totalCount: number,
  window: SlidingWindowFragment | undefined,
): number[] {
  if (!window) {
    return Array.from({ length: totalCount }, (_, index) => index);
  }

  return Array.from(
    { length: window.focusLineEnd - window.focusLineStart },
    (_, index) => window.focusLineStart + index,
  );
}

function splitOutputLines(outputText: string): string[] {
  if (outputText.length === 0) {
    return [];
  }

  return outputText.split("\n");
}

function resolveRepairedLines(result: AlignmentRepairResult): Array<string | undefined> {
  const repairMap = new Map(result.repairs.map((repair) => [repair.id, repair.translation]));
  return result.analysis.units.map((unit) =>
    unit.missing ? repairMap.get(unit.id) : unit.alignedTranslation,
  );
}
