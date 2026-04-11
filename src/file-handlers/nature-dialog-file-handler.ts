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
import {
  type ParsedTranslationDocument,
  type ParsedTranslationUnitBlock,
  TranslationFileHandler,
  extractBracketNameAndText,
  stripBom,
} from "./base.ts";

/**
 * Nature Dialog 处理器，负责解析和生成带有对话标记的文本格式。
 *
 * 解析规则：
 * - ○ 开头的行：首行为原文，后续为译文候选
 * - ● 开头的行：标记最后一个译文，表示该单元结束
 * - 空行：分隔翻译单元
 *
 * 输出格式：每个翻译单元原文用 ○，译文用 ○/●（最后一项用 ●）
 */
export class NatureDialogFileHandler extends TranslationFileHandler {
  readonly formatName: string = "naturedialog";
  readonly supportsComparable = true;

  override parseTranslationDocument(content: string): ParsedTranslationDocument {
    return parseNatureDialogDocument(stripBom(content));
  }

  override async readTranslationUnits(filePath: string): Promise<TranslationUnit[]> {
    const content = await readFile(filePath, "utf8");
    return this.parseTranslationDocument(content).units;
  }

  override async writeTranslationUnits(
    filePath: string,
    units: TranslationUnit[],
  ): Promise<void> {
    await writeFile(filePath, this.formatTranslationUnits(units), "utf8");
  }

  override formatTranslationUnits(units: TranslationUnit[]): string {
    return buildNatureDialogContent(units);
  }
}

/**
 * 保留原始角色名的 Nature Dialog 处理器。
 *
 * 与普通 Nature Dialog 处理器的区别：
 * - 读取时：保留原文的角色名信息
 * - 写入时：确保译文的角色名与原文一致
 *
 * 角色名处理规则：
 * - 原文有角色名，译文无：从原文复制角色名到译文
 * - 原文无角色名，译文有：移除译文的角色名
 * - 两者都有角色名：保留原文角色名，使用译文内容
 */
export class NatureDialogKeepNameFileHandler extends NatureDialogFileHandler {
  override readonly formatName: string = "naturedialog_keepname";

  override async readTranslationUnits(filePath: string): Promise<TranslationUnit[]> {
    const units = await super.readTranslationUnits(filePath);
    return units.map((unit) => ({
      ...unit,
      target: unit.target.map((target) =>
        this.processTranslationPair(unit.source, target),
      ),
    }));
  }

  override async writeTranslationUnits(
    filePath: string,
    units: TranslationUnit[],
  ): Promise<void> {
    await writeFile(filePath, this.formatTranslationUnits(units), "utf8");
  }

  override formatTranslationUnits(units: TranslationUnit[]): string {
    const processedUnits = units.map((unit) => ({
      ...unit,
      target: unit.target.map((target) =>
        this.processTranslationPair(unit.source, target),
      ),
    }));
    return super.formatTranslationUnits(processedUnits);
  }

  private processTranslationPair(source: string, target: string): string {
    const sourceParts = extractBracketNameAndText(source);
    const targetParts = extractBracketNameAndText(target);

    if (!sourceParts.name && targetParts.name) {
      const withoutName = this.removeNameBlock(target);
      return this.removeOuterQuotes(withoutName);
    }

    if (sourceParts.name && !targetParts.name) {
      const sourceQuoteType = this.extractQuoteType(sourceParts.body);
      const targetQuoteType = this.extractQuoteType(targetParts.body);
      let targetBody = targetParts.body;
      if (!targetQuoteType && sourceQuoteType) {
        targetBody = this.addQuotes(targetBody, sourceQuoteType);
      }
      return `【${sourceParts.name}】${targetBody}`;
    }

    if (sourceParts.name && targetParts.name) {
      return target.replace(/^【.+?】/, `【${sourceParts.name}】`);
    }

    return target;
  }

  private removeOuterQuotes(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1);
    }
    if (trimmed.startsWith("「") && trimmed.endsWith("」")) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  }

  private extractQuoteType(text: string): `"` | "「" | undefined {
    const trimmed = text.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return '"';
    }
    if (trimmed.startsWith("「") && trimmed.endsWith("」")) {
      return "「";
    }
    return undefined;
  }

  private addQuotes(text: string, quoteType: `"` | "「"): string {
    return quoteType === '"' ? `"${text}"` : `「${text}」`;
  }

  private removeNameBlock(text: string): string {
    return text.replace(/^【.+?】/, "").trim();
  }
}

function buildNatureDialogContent(units: TranslationUnit[]): string {
  const lines: string[] = [];

  for (const unit of units) {
    lines.push(`○ ${unit.source}`);
    for (const [index, targetText] of unit.target.entries()) {
      const prefix = index === unit.target.length - 1 ? "●" : "○";
      lines.push(`${prefix} ${targetText}`);
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
    if (currentSource === undefined || currentTargets.length === 0) {
      currentSource = undefined;
      currentTargets = [];
      currentStartLineNumber = undefined;
      currentSourceLineNumber = undefined;
      currentTargetLineNumbers = [];
      return;
    }

    const unit: TranslationUnit = {
      source: currentSource,
      target: [...currentTargets],
    };
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
