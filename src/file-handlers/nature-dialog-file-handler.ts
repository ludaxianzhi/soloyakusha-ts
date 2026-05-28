/**
 * 实现 Nature Dialog 风格文本的读写，支持源文、译文和角色名保留等规则。
 *
 * 文件格式示例：
 * ```
 * ○ 原文第一句
 * ○ 译文候选1
 * ● 最终译文
 *
 * ○ 原文第二句
 * ● 译文
 * ```
 *
 * 格式说明：
 * - ○ 标记原文或译文候选
 * - ● 标记最终采用的译文（最后一个译文条目）
 * - 空行分隔不同的翻译单元
 * - 支持【角色名】正文格式
 *
 * @module file-handlers/nature-dialog-file-handler
 */

import { readFile, writeFile } from "node:fs/promises";
import type { TranslationUnit } from "../project/types.ts";
import type { FileHandlerParamDef } from "./base.ts";
import {
  BLANK_PLACEHOLDER,
  type ParsedTranslationDocument,
  type ParsedTranslationUnitBlock,
  TranslationFileHandler,
  extractBracketNameAndText,
  normalizeBlankSourceUnit,
  restoreBlankText,
  stripBom,
} from "./base.ts";

const EXPORT_PARAMS: FileHandlerParamDef[] = [
  { key: "keepSourceName", label: "保持名称", type: "boolean", defaultValue: false, description: "导出时角色名保持与原文一致" },
  { key: "includeComment", label: "导出评论", type: "boolean", defaultValue: false, description: "将校对评审的评论以 # 开头写入文件" },
  { key: "exportAllTranslations", label: "导出所有译文", type: "boolean", defaultValue: false, description: "导出 targetGroups 中的历史译文，当前译文使用 ●，其他使用 ○" },
];

/**
 * Nature Dialog 处理器，负责解析和生成带有对话标记的文本格式。
 *
 * 解析规则：
 * - ○ 开头的行：首行为原文，后续为译文候选
 * - ● 开头的行：标记最后一个译文，表示该单元结束
 * - 空行：分隔翻译单元
 *
 * 行为规则
 * - 默认：原文和译文的角色名各自独立
 * - keepSourceName=true：导出时译文的角色名与原文保持一致
 */
export class NatureDialogFileHandler extends TranslationFileHandler {
  readonly formatName: string = "naturedialog";
  readonly supportsComparable = true;
  override readonly exportParamDefs = EXPORT_PARAMS;

  private keepSourceName = false;
  private includeComment = false;
  private exportAllTranslations = false;

  override applyParams(params: Record<string, unknown>): void {
    if (typeof params.keepSourceName === "boolean") {
      this.keepSourceName = params.keepSourceName;
    }
    if (typeof params.includeComment === "boolean") {
      this.includeComment = params.includeComment;
    }
    if (typeof params.exportAllTranslations === "boolean") {
      this.exportAllTranslations = params.exportAllTranslations;
    }
  }

  override parseTranslationDocument(content: string): ParsedTranslationDocument {
    return parseNatureDialogDocument(stripBom(content));
  }

  override async readTranslationUnits(filePath: string): Promise<TranslationUnit[]> {
    const content = await readFile(filePath, "utf8");
    return this.parseTranslationDocument(content).units;
  }

  /**
   * 仅译文模式：只解析 ● 行，跳过所有 ○ 原文/候选行。
   * 专用于从压缩包更新译文的场景。
   */
  override async readTranslationUnitsForUpdate(filePath: string): Promise<TranslationUnit[]> {
    const content = await readFile(filePath, "utf8");
    return parseNatureDialogDocumentTranslationOnly(stripBom(content));
  }

  override async writeTranslationUnits(
    filePath: string,
    units: TranslationUnit[],
  ): Promise<void> {
    await writeFile(filePath, this.formatTranslationUnits(units), "utf8");
  }

  override formatTranslationUnits(units: TranslationUnit[]): string {
    const processedUnits = this.keepSourceName
      ? units.map((unit) => ({
          ...unit,
          target: unit.target.map((target) =>
            processTranslationPair(unit.source, target),
          ),
        }))
      : units;
    return buildNatureDialogContent(
      processedUnits,
      this.includeComment,
      this.exportAllTranslations,
    );
  }
}

function processTranslationPair(source: string, target: string): string {
  const sourceParts = extractBracketNameAndText(source);
  const targetParts = extractBracketNameAndText(target);

  if (!sourceParts.name && targetParts.name) {
    const withoutName = removeNameBlock(target);
    return removeOuterQuotes(withoutName);
  }

  if (sourceParts.name && !targetParts.name) {
    const sourceQuoteType = extractQuoteType(sourceParts.body);
    const targetQuoteType = extractQuoteType(targetParts.body);
    let targetBody = targetParts.body;
    if (!targetQuoteType && sourceQuoteType) {
      targetBody = addQuotes(targetBody, sourceQuoteType);
    }
    return `【${sourceParts.name}】${targetBody}`;
  }

  if (sourceParts.name && targetParts.name) {
    return target.replace(/^【.+?】/, `【${sourceParts.name}】`);
  }

  return target;
}

function removeOuterQuotes(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("「") && trimmed.endsWith("」")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractQuoteType(text: string): `"` | "「" | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return '"';
  }
  if (trimmed.startsWith("「") && trimmed.endsWith("」")) {
    return "「";
  }
  return undefined;
}

function addQuotes(text: string, quoteType: `"` | "「"): string {
  return quoteType === '"' ? `"${text}"` : `「${text}」`;
}

function removeNameBlock(text: string): string {
  return text.replace(/^【.+?】/, "").trim();
}

function buildNatureDialogContent(
  units: TranslationUnit[],
  includeComment: boolean,
  exportAllTranslations: boolean,
): string {
  const lines: string[] = [];

  for (const unit of units) {
    const sourceText = restoreBlankText(unit.source);
    const isBlank = unit.source === BLANK_PLACEHOLDER;

    if (isBlank) {
      lines.push(`○ `);
      lines.push(`● `);
      if (includeComment && unit.comment) {
        lines.push(`# ${unit.comment}`);
      }
      lines.push("");
      continue;
    }

    lines.push(`○ ${sourceText}`);

    const targets = unit.target;
    if (exportAllTranslations && targets.length > 0) {
      for (let i = 0; i < targets.length - 1; i++) {
        const text = restoreBlankText(targets[i]!);
        if (text) {
          lines.push(`○ ${text}`);
        }
      }
      const lastText = restoreBlankText(targets[targets.length - 1]!);
      lines.push(`● ${lastText}`);
    } else if (targets.length > 0) {
      lines.push(`● ${restoreBlankText(targets[targets.length - 1]!)}`);
    } else {
      lines.push(`● `);
    }

    if (includeComment && unit.comment) {
      lines.push(`# ${unit.comment}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

function parseNatureDialogDocument(content: string): ParsedTranslationDocument {
  const lines = content.split(/\r?\n/);
  const units: TranslationUnit[] = [];
  const blocks: ParsedTranslationUnitBlock[] = [];

  let currentSource: string | undefined;
  let currentTargets: string[] = [];
  let currentStartLineNumber: number | undefined;
  let currentSourceLineNumber: number | undefined;
  let currentTargetLineNumbers: number[] = [];

  const flushCurrentUnit = (endLineNumber: number) => {
    if (
      currentSource === undefined ||
      (currentTargets.length === 0 && currentSource.trim().length > 0)
    ) {
      currentSource = undefined;
      currentTargets = [];
      currentStartLineNumber = undefined;
      currentSourceLineNumber = undefined;
      currentTargetLineNumbers = [];
      return;
    }

    const unit = normalizeBlankSourceUnit({
      source: currentSource,
      target: [...currentTargets],
    });
    units.push(unit);
    blocks.push({
      unit,
      startLineNumber: currentStartLineNumber ?? currentSourceLineNumber ?? endLineNumber,
      endLineNumber,
      sourceLineNumber: currentSourceLineNumber ?? endLineNumber,
      targetLineNumbers: [...currentTargetLineNumbers],
    });
    currentSource = undefined;
    currentTargets = [];
    currentStartLineNumber = undefined;
    currentSourceLineNumber = undefined;
    currentTargetLineNumbers = [];
  };

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line) {
      flushCurrentUnit(lineNumber);
      return;
    }

    if (line.startsWith("○")) {
      const text = line.slice(1).trim();
      if (currentSource === undefined) {
        currentSource = text;
        currentStartLineNumber = lineNumber;
        currentSourceLineNumber = lineNumber;
      } else {
        currentTargets.push(text);
        currentTargetLineNumbers.push(lineNumber);
      }
      return;
    }

    if (line.startsWith("●")) {
      const text = line.slice(1).trim();
      currentTargets.push(text);
      currentTargetLineNumbers.push(lineNumber);
      flushCurrentUnit(lineNumber);
    }
  });

  flushCurrentUnit(lines.length);

  return {
    units,
    blocks,
    rawLineCount: lines.length,
  };
}

/**
 * 仅译文模式解析：只解析 ● 行，跳过所有 ○ 原文/候选行。
 * 每个 ● 行生成一个 TranslationUnit，source 为空，target 为译文文本。
 */
function parseNatureDialogDocumentTranslationOnly(content: string): TranslationUnit[] {
  const lines = content.split(/\r?\n/);
  const units: TranslationUnit[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("●")) {
      const text = line.slice(1).trim();
      units.push({ source: "", target: [text] });
    }
  }

  return units;
}
