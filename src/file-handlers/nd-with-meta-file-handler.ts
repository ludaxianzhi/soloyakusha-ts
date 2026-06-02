/**
 * ND_WITH_META 翻译文件格式处理器。
 *
 * 格式定义：
 * - 原文行可选的 metadata 前缀 + 正文
 * - 译文行可选的 metadata 前缀 + 正文
 * - 空行分隔不同的翻译对
 * - metadata 必须位于句首，通过用户提供的 regex 提取
 *
 * 示例（▷\d+◁ 为 source regex，▶\d+◀ 为 target regex）：
 * ```
 * ▷000000◁いつも憂鬱な月曜の朝が…
 * ▶000000◀
 *
 * ▷000001◁【宗太】（どんな顔して…）
 * ▶000001◀【宗太】
 * ```
 *
 * 内部表示：
 * - metadata 以 Record 形式存储 { source: 原文字符串, target: 译文字符串 }
 * - 正文部分按原样保留
 *
 * @module file-handlers/nd-with-meta-file-handler
 */

import type {
  FileHandlerParamDef,
  ParsedTranslationDocument,
  ParsedTranslationUnitBlock,
} from "./base.ts";
import { TranslationFileHandler, stripBom } from "./base.ts";
import type { TranslationUnit } from "../project/types.ts";
import { writeFile } from "node:fs/promises";

const IMPORT_PARAMS: FileHandlerParamDef[] = [
  {
    key: "sourceMetaRegex",
    label: "原文 metadata 正则",
    type: "string",
    defaultValue: "▷\\d+◁",
    description: "匹配原文行首 metadata 的正则，如 ▷\\d+◁",
    required: true,
  },
  {
    key: "targetMetaRegex",
    label: "译文 metadata 正则",
    type: "string",
    defaultValue: "▶\\d+◀",
    description: "匹配译文行首 metadata 的正则，如 ▶\\d+◀",
    required: true,
  },
];

export class NdWithMetaFileHandler extends TranslationFileHandler {
  readonly formatName = "nd_with_meta";
  readonly supportsComparable = true;
  override readonly importParamDefs = IMPORT_PARAMS;

  private sourceMetaRegex: RegExp = /^▷\d+◁/;
  private targetMetaRegex: RegExp = /^▶\d+◀/;

  override applyParams(params: Record<string, unknown>): void {
    if (typeof params.sourceMetaRegex === "string") {
      this.sourceMetaRegex = compileStartRegex(params.sourceMetaRegex);
    }
    if (typeof params.targetMetaRegex === "string") {
      this.targetMetaRegex = compileStartRegex(params.targetMetaRegex);
    }
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

      if (!this.sourceMetaRegex.test(line)) {
        lineIdx++;
        continue;
      }

      const sourceMetaMatch = this.sourceMetaRegex.exec(line);
      if (!sourceMetaMatch) {
        lineIdx++;
        continue;
      }
      const sourceMeta = sourceMetaMatch[0];
      const sourceText = line.slice(sourceMeta.length);

      const sourceLineNumber = lineIdx;
      lineIdx++;

      const targetTexts: string[] = [];
      const targetLineNumbers: number[] = [];
      let targetMeta: string | undefined;

      while (lineIdx < rawLines.length) {
        const currentLine = rawLines[lineIdx]!;
        if (currentLine.trim().length === 0) {
          break;
        }

        const targetMetaMatch = this.targetMetaRegex.exec(currentLine);
        if (targetMetaMatch) {
          const curMeta = targetMetaMatch[0];
          const curText = currentLine.slice(curMeta.length);
          targetMeta = curMeta;
          targetTexts.push(curText);
          targetLineNumbers.push(lineIdx);
        }
        lineIdx++;
      }

      const metadata: Record<string, string> = {
        source: sourceMeta,
      };
      if (targetMeta !== undefined) {
        metadata.target = targetMeta;
      }

      const unit: TranslationUnit = {
        source: sourceText,
        target:
          targetTexts.length > 0
            ? [targetTexts[targetTexts.length - 1]!]
            : [],
        metadata,
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

    for (let i = 0; i < units.length; i++) {
      if (i > 0) {
        lines.push("");
      }

      const unit = units[i]!;

      const sourceMeta =
        typeof unit.metadata === "object" && unit.metadata !== null
          ? (unit.metadata as Record<string, string>).source ?? ""
          : "";
      const targetMeta =
        typeof unit.metadata === "object" && unit.metadata !== null
          ? (unit.metadata as Record<string, string>).target ?? ""
          : "";

      const sourceLine = `${sourceMeta}${unit.source}`;
      lines.push(sourceLine);

      const selectedTarget = unit.target.at(-1);
      if (selectedTarget !== undefined && selectedTarget.length > 0) {
        const targetLine = `${targetMeta}${selectedTarget}`;
        lines.push(targetLine);
      } else {
        lines.push(targetMeta);
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
}

function compileStartRegex(pattern: string): RegExp {
  const body = pattern.startsWith("^") ? pattern.slice(1) : pattern;
  return new RegExp(`^${body}`);
}
