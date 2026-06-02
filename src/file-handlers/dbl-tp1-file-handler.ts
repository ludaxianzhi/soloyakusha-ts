/**
 * DBL_TP1 翻译文件格式处理器。
 *
 * 格式定义：
 * - 源行以 sourceChar（默认 ☆）起始
 * - 目标行以 targetChar（默认 ★）起始
 * - 每行格式: 标记 + 数字ID + 标记 + [角色名 + 标记] + 正文
 * - 无名条目使用额外标记占位：标记 + ID + 标记 + 标记 + 正文
 * - 空行分隔不同的翻译对
 *
 * 内部表示：
 * - metadata 以字符串形式存储数字 ID
 * - 角色名以 【角色名】正文 格式保留在文本中
 *
 * @module file-handlers/dbl-tp1-file-handler
 */

import type {
  FileHandlerParamDef,
  ParsedTranslationDocument,
  ParsedTranslationUnitBlock,
} from "./base.ts";
import { TranslationFileHandler } from "./base.ts";
import type { TranslationUnit } from "../project/types.ts";
import { extractBracketNameAndText, stripBom } from "./base.ts";
import { writeFile } from "node:fs/promises";

const IMPORT_PARAMS: FileHandlerParamDef[] = [
  { key: "sourceChar", label: "原文标记字符", type: "string", defaultValue: "☆", description: "原文行起始字符，如 ☆" },
  { key: "targetChar", label: "译文标记字符", type: "string", defaultValue: "★", description: "译文行起始字符，如 ★" },
];

const EXPORT_PARAMS: FileHandlerParamDef[] = [
  { key: "sourceChar", label: "原文标记字符", type: "string", defaultValue: "☆" },
  { key: "targetChar", label: "译文标记字符", type: "string", defaultValue: "★" },
  { key: "keepSourceName", label: "保持名称", type: "boolean", defaultValue: false, description: "导出时角色名保持与原文一致" },
];

export class DblTp1FileHandler extends TranslationFileHandler {
  readonly formatName = "dbl_tp1";
  readonly supportsComparable = false;
  override readonly importParamDefs = IMPORT_PARAMS;
  override readonly exportParamDefs = EXPORT_PARAMS;

  private sourceChar = "☆";
  private targetChar = "★";

  override applyParams(params: Record<string, unknown>): void {
    if (typeof params.sourceChar === "string") this.sourceChar = params.sourceChar;
    if (typeof params.targetChar === "string") this.targetChar = params.targetChar;
  }

  parseTranslationDocument(content: string): ParsedTranslationDocument {
    const rawLines = stripBom(content).split(/\r?\n/);
    const rawLineCount = rawLines.length;
    const units: TranslationUnit[] = [];
    const blocks: ParsedTranslationUnitBlock[] = [];

    let lineIdx = 0;
    while (lineIdx < rawLines.length) {
      const line = rawLines[lineIdx]!;
      if (line.trim().length === 0) {
        lineIdx++;
        continue;
      }

      if (!line.startsWith(this.sourceChar)) {
        lineIdx++;
        continue;
      }

      const parsedSource = this.parseLine(line);
      if (!parsedSource) {
        lineIdx++;
        continue;
      }
      if (parsedSource.type !== "source") {
        lineIdx++;
        continue;
      }

      const sourceLineNumber = lineIdx;
      lineIdx++;

      const targetTexts: string[] = [];
      const targetLineNumbers: number[] = [];

      while (lineIdx < rawLines.length) {
        const currentLine = rawLines[lineIdx]!;
        if (currentLine.trim().length === 0) {
          break;
        }

        if (currentLine.startsWith(this.targetChar)) {
          const parsedTarget = this.parseLine(currentLine);
          if (parsedTarget && parsedTarget.type === "target") {
            targetTexts.push(
              this.toInternalText(parsedTarget.name, parsedTarget.text),
            );
            targetLineNumbers.push(lineIdx);
          }
        }
        lineIdx++;
      }

      const sourceText = this.toInternalText(
        parsedSource.name,
        parsedSource.text,
      );

      const target =
        targetTexts.length > 0
          ? [targetTexts[targetTexts.length - 1]!]
          : [];

      const unit: TranslationUnit = {
        source: sourceText,
        target,
        metadata: parsedSource.id,
      };

      units.push(unit);
      blocks.push({
        unit,
        startLineNumber: sourceLineNumber,
        endLineNumber:
          targetLineNumbers.length > 0
            ? targetLineNumbers[targetLineNumbers.length - 1]!
            : sourceLineNumber,
        sourceLineNumber,
        targetLineNumbers,
      });
    }

    return { units, blocks, rawLineCount };
  }

  formatTranslationUnits(units: TranslationUnit[]): string {
    if (units.length === 0) return "";

    const lines: string[] = [];
    let fallbackId = 1;

    for (let i = 0; i < units.length; i++) {
      if (i > 0) {
        lines.push("");
      }

      const unit = units[i]!;
      const id =
        typeof unit.metadata === "string" && unit.metadata.length > 0
          ? unit.metadata
          : String(fallbackId++).padStart(8, "0");

      const sourceLine = this.formatLine(this.sourceChar, id, unit.source);
      lines.push(sourceLine);

      const selectedTarget = unit.target.at(-1);
      if (selectedTarget && selectedTarget.length > 0) {
        const targetLine = this.formatLine(
          this.targetChar,
          id,
          selectedTarget,
        );
        lines.push(targetLine);
      } else {
        lines.push(`${this.targetChar}${id}${this.targetChar}${this.targetChar}`);
      }
    }

    return lines.join("\n");
  }

  async readTranslationUnits(filePath: string): Promise<TranslationUnit[]> {
    const { content } = await this.readFileContent(filePath);
    return this.parseTranslationDocument(content).units;
  }

  async writeTranslationUnits(
    filePath: string,
    units: TranslationUnit[],
  ): Promise<void> {
    const content = this.formatTranslationUnits(units);
    await writeFile(filePath, content, "utf-8");
  }

  private parseLine(
    line: string,
  ): {
    type: "source" | "target";
    id: string;
    name?: string;
    text: string;
  } | null {
    const marker = line[0];
    if (marker !== this.sourceChar && marker !== this.targetChar) return null;

    const type = marker === this.sourceChar ? "source" : "target";

    let pos = 1;
    const idStart = pos;
    while (pos < line.length && /\d/.test(line[pos]!)) pos++;
    if (pos === idStart) return null;

    const id = line.slice(idStart, pos);

    if (pos >= line.length || line[pos] !== marker) return null;
    pos++;

    if (pos < line.length && line[pos] === marker) {
      pos++;
      return { type, id, text: line.slice(pos) };
    }

    const nameStart = pos;
    while (pos < line.length && line[pos] !== marker) pos++;
    const name = line.slice(nameStart, pos);

    if (pos < line.length && line[pos] === marker) {
      pos++;
    }

    return { type, id, name, text: line.slice(pos) };
  }

  private toInternalText(name: string | undefined, text: string): string {
    if (name) {
      return `【${name}】${text}`;
    }
    return text;
  }

  private formatLine(marker: string, id: string, text: string): string {
    const parsed = extractBracketNameAndText(text);
    if (parsed.name) {
      return `${marker}${id}${marker}${parsed.name}${marker}${parsed.body}`;
    }
    return `${marker}${id}${marker}${marker}${text}`;
  }
}
