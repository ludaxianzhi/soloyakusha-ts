/**
 * DBL_TP2 翻译文件格式处理器。
 *
 * 格式定义：
 * - 每个人名/消息条目由一对源行和目标行组成（如 ☆/★ 起始行）
 * - 每行格式：元数据前缀 + 正文
 * - 元数据通过用户提供的 regex 提取，名称类型通过另一 regex 判断
 * - 人名条目（N 类型）与它后面紧随的消息条目（R/T 类型）合并，
 *   在内部表示为 【人名】正文 格式
 * - 空行分隔不同的条目组
 *
 * 内部表示：
 * - metadata 以 Record 存储 { source, target, nameSource?, nameTarget? }
 * - 合并后的文本以 【角色名】正文 格式存储在 source/target 中
 *
 * @module file-handlers/dbl-tp2-file-handler
 */

import type {
  FileHandlerParamDef,
  ParsedTranslationDocument,
  ParsedTranslationUnitBlock,
} from "./base.ts";
import { TranslationFileHandler, extractBracketNameAndText, stripBom } from "./base.ts";
import type { TranslationUnit } from "../project/types.ts";
import { writeFile } from "node:fs/promises";

const IMPORT_PARAMS: FileHandlerParamDef[] = [
  {
    key: "sourceMetaRegex",
    label: "原文元数据正则",
    type: "string",
    defaultValue: "☆\\d+\\w☆",
    description: "匹配原文行首元数据的正则，如 ☆\\d+\\w☆",
    required: true,
  },
    {
      key: "targetMetaRegex",
      label: "译文元数据正则",
      type: "string",
      defaultValue: "★\\d+\\w[☆★]",
      description: "匹配译文行首元数据的正则，如 ★\\d+\\w☆",
      required: true,
    },
  {
    key: "nameMetaRegex",
    label: "人名元数据正则",
    type: "string",
    defaultValue: "\\d+N",
    description: "从元数据中识别人名条目的正则，如 \\d+N",
    required: true,
  },
];

const EXPORT_PARAMS: FileHandlerParamDef[] = [
  {
    key: "keepSourceName",
    label: "保留人名",
    type: "boolean",
    defaultValue: false,
    description: "导出时译文侧的人名与原文保持一致",
  },
];

export class DblTp2FileHandler extends TranslationFileHandler {
  readonly formatName = "dbl_tp2";
  readonly supportsComparable = false;
  override readonly importParamDefs = IMPORT_PARAMS;
  override readonly exportParamDefs = EXPORT_PARAMS;

  private sourceMetaRegex: RegExp = /^☆\d+\w☆/;
  private targetMetaRegex: RegExp = /^★\d+\w[☆★]/;
  private nameMetaRegex: RegExp = /\d+N/;
  private keepSourceName = false;

  override applyParams(params: Record<string, unknown>): void {
    if (typeof params.sourceMetaRegex === "string") {
      this.sourceMetaRegex = compileStartRegex(params.sourceMetaRegex);
    }
    if (typeof params.targetMetaRegex === "string") {
      this.targetMetaRegex = compileStartRegex(params.targetMetaRegex);
    }
    if (typeof params.nameMetaRegex === "string") {
      this.nameMetaRegex = new RegExp(params.nameMetaRegex);
    }
    if (typeof params.keepSourceName === "boolean") {
      this.keepSourceName = params.keepSourceName;
    }
  }

  parseTranslationDocument(content: string): ParsedTranslationDocument {
    const rawLines = stripBom(content).split(/\r?\n/);
    const rawLineCount = rawLines.length;
    const units: TranslationUnit[] = [];
    const blocks: ParsedTranslationUnitBlock[] = [];

    interface PendingName {
      sourceMeta: string;
      targetMeta: string;
      sourceText: string;
      targetText: string;
    }

    let pendingName: PendingName | null = null;

    let lineIdx = 0;
    while (lineIdx < rawLines.length) {
      const line = rawLines[lineIdx]!;
      if (line.trim().length === 0) {
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

      const isName = this.nameMetaRegex.test(sourceMeta);

      if (isName) {
        pendingName = {
          sourceMeta,
          targetMeta: targetMeta ?? "",
          sourceText,
          targetText: targetTexts.length > 0 ? targetTexts[targetTexts.length - 1]! : "",
        };
      } else {
        const finalTargetText = targetTexts.length > 0 ? targetTexts[targetTexts.length - 1]! : "";

        let unitSource: string;
        let unitTarget: string[];
        const unitMetadata: Record<string, string> = {
          source: sourceMeta,
          target: targetMeta ?? "",
        };

        if (pendingName) {
          unitSource = `【${pendingName.sourceText}】${sourceText}`;
          unitTarget = finalTargetText.length > 0
            ? [`【${pendingName.targetText}】${finalTargetText}`]
            : [];
          unitMetadata.nameSource = pendingName.sourceMeta;
          unitMetadata.nameTarget = pendingName.targetMeta;
          pendingName = null;
        } else {
          unitSource = sourceText;
          unitTarget = finalTargetText.length > 0 ? [finalTargetText] : [];
        }

        const unit: TranslationUnit = {
          source: unitSource,
          target: unitTarget,
          metadata: unitMetadata,
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
      const rawMeta = unit.metadata;
      const metadata =
        typeof rawMeta === "object" && rawMeta !== null
          ? (rawMeta as Record<string, string>)
          : {};

      const sourceMeta = metadata.source ?? "";
      const targetMeta = metadata.target ?? "";

      const hasName = "nameSource" in metadata && "nameTarget" in metadata;
      if (hasName) {
        const sourceParsed = extractBracketNameAndText(unit.source);
        const sourceName = sourceParsed.name ?? "";
        const sourceBody = sourceParsed.body;

        const lastTarget = unit.target.at(-1);
        const targetParsed = lastTarget
          ? extractBracketNameAndText(lastTarget)
          : { body: "" };
        const targetBody = lastTarget ? targetParsed.body : "";

        const targetName = this.keepSourceName
          ? sourceName
          : (targetParsed.name ?? sourceName);

        lines.push(`${metadata.nameSource}${sourceName}`);
        lines.push(`${metadata.nameTarget}${targetName}`);
        lines.push("");
        lines.push(`${sourceMeta}${sourceBody}`);
        lines.push(targetBody.length > 0 ? `${targetMeta}${targetBody}` : targetMeta);
      } else {
        lines.push(`${sourceMeta}${unit.source}`);
        const lastTarget = unit.target.at(-1);
        if (lastTarget && lastTarget.length > 0) {
          lines.push(`${targetMeta}${lastTarget}`);
        } else {
          lines.push(targetMeta);
        }
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
