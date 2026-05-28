/**
 * 实现 M3T 对话格式的读写，处理角色名、正文与多种翻译状态的序列化。
 *
 * 文件格式示例：
 * ```
 * ○ NAME: 角色名
 *
 * ○ 正文内容
 * ○ 译文候选
 * ● 最终译文
 * ```
 *
 * 格式说明：
 * - NAME 行指定角色名，与下一行的正文组合为【角色名】正文格式
 * - 无 NAME 的按普通文本处理
 * - 译文同样支持多个候选，最后一个用 ● 标记
 *
 * @module file-handlers/m3t-file-handler
 */

import { readFile, writeFile } from "node:fs/promises";
import type { TranslationUnit } from "../project/types.ts";
import type { FileHandlerParamDef } from "./base.ts";
import {
  type ParsedTranslationDocument,
  type ParsedTranslationUnitBlock,
  TranslationFileHandler,
  extractBracketNameAndText,
  normalizeBlankSourceUnit,
  restoreBlankText,
  stripBom,
} from "./base.ts";

const EXPORT_PARAMS: FileHandlerParamDef[] = [
  { key: "exportAllTranslations", label: "导出所有译文", type: "boolean", defaultValue: false, description: "导出 targetGroups 中的历史译文，当前译文使用 ●，其他使用 ○" },
];

/**
 * M3T 格式处理器，负责在名称字段、正文和翻译状态之间做转换。
 *
 * 解析逻辑：
 * - ○ NAME: xxx 行识别角色名
 * - 下一行 ○ 开头为正文，组合为【角色名】正文
 * - 后续 ○/● 行为译文，最后一项用 ● 标记
 *
 * 输出逻辑：
 * - 有角色名：生成 NAME 行 + 正文行 + 译文行
 * - 无角色名：直接输出正文 + 译文
 */
export class M3TFileHandler extends TranslationFileHandler {
  readonly formatName = "m3t";
  readonly supportsComparable = true;
  override readonly exportParamDefs = EXPORT_PARAMS;

  private exportAllTranslations = false;

  override applyParams(params: Record<string, unknown>): void {
    if (typeof params.exportAllTranslations === "boolean") {
      this.exportAllTranslations = params.exportAllTranslations;
    }
  }

  override parseTranslationDocument(content: string): ParsedTranslationDocument {
    return parseM3TDocument(stripBom(content));
  }

  override async readTranslationUnits(filePath: string): Promise<TranslationUnit[]> {
    const content = await readFile(filePath, "utf8");
    return this.parseTranslationDocument(content).units;
  }

  /**
   * 仅译文模式：只读取 NAME 行和 ● 行，忽略所有 ○ 原文/候选行。
   * 专用于从压缩包更新译文的场景。
   */
  override async readTranslationUnitsForUpdate(filePath: string): Promise<TranslationUnit[]> {
    const content = await readFile(filePath, "utf8");
    return parseM3TDocumentTranslationOnly(stripBom(content));
  }

  override async writeTranslationUnits(
    filePath: string,
    units: TranslationUnit[],
  ): Promise<void> {
    await writeFile(filePath, this.formatTranslationUnits(units), "utf8");
  }

  override formatTranslationUnits(units: TranslationUnit[]): string {
    return formatM3TTranslationUnits(units, this.exportAllTranslations);
  }
}

function formatM3TTranslationUnits(units: TranslationUnit[], exportAllTranslations: boolean): string {
  const lines: string[] = [];

  for (const unit of units) {
    const parsed = extractBracketNameAndText(unit.source);
    if (parsed.name) {
      lines.push(`○ NAME: ${parsed.name}`);
      lines.push("");
      lines.push(`○ ${restoreBlankText(parsed.body)}`);

      if (exportAllTranslations && unit.target.length > 1) {
        for (let i = 0; i < unit.target.length - 1; i++) {
          const targetParsed = extractBracketNameAndText(unit.target[i]!);
          const text = restoreBlankText(targetParsed.body);
          if (text) {
            lines.push(`○ ${text}`);
          }
        }
        const lastParsed = extractBracketNameAndText(unit.target[unit.target.length - 1]!);
        lines.push(`● ${restoreBlankText(lastParsed.body)}`);
      } else if (unit.target.length > 0) {
        const lastParsed = extractBracketNameAndText(unit.target[unit.target.length - 1]!);
        lines.push(`● ${restoreBlankText(lastParsed.body)}`);
      } else {
        lines.push(`● `);
      }
    } else {
      lines.push(`○ ${restoreBlankText(unit.source)}`);

      if (exportAllTranslations && unit.target.length > 1) {
        for (let i = 0; i < unit.target.length - 1; i++) {
          const text = restoreBlankText(unit.target[i]!);
          if (text) {
            lines.push(`○ ${text}`);
          }
        }
        const lastText = restoreBlankText(unit.target[unit.target.length - 1]!);
        lines.push(`● ${lastText}`);
      } else if (unit.target.length > 0) {
        lines.push(`● ${restoreBlankText(unit.target[unit.target.length - 1]!)}`);
      } else {
        lines.push(`● `);
      }
    }

    lines.push("");
  }
  lines.push("");

  return lines.join("\n");
}

function parseM3TDocument(content: string): ParsedTranslationDocument {
  const lines = content.split(/\r?\n/);
  const units: TranslationUnit[] = [];
  const blocks: ParsedTranslationUnitBlock[] = [];

  let index = 0;
  while (index < lines.length) {
    const startLineNumber = index + 1;
    const line = lines[index]!.trim();
    if (!line) {
      index += 1;
      continue;
    }

    if (!line.startsWith("○")) {
      index += 1;
      continue;
    }

    const text = line.slice(1).trim();
    if (text.startsWith("NAME:")) {
      const name = text.slice(5).trim();
      const nameLineNumber = index + 1;
      index += 1;
      while (index < lines.length && !lines[index]!.trim()) {
        index += 1;
      }

      const dialogLine = lines[index]?.trim();
      if (!dialogLine?.startsWith("○")) {
        index += 1;
        continue;
      }

      const sourceLineNumber = index + 1;
      const sourceDialog = dialogLine.slice(1).trim();
      const source = `【${name}】${sourceDialog}`;
      index += 1;
      const targets: string[] = [];
      const targetLineNumbers: number[] = [];
      let endLineNumber = sourceLineNumber;

      while (index < lines.length) {
        const targetLine = lines[index]!.trim();
        if (!targetLine) {
          break;
        }
        if (targetLine.startsWith("○") || targetLine.startsWith("●")) {
          targets.push(`【${name}】${targetLine.slice(1).trim()}`);
          targetLineNumbers.push(index + 1);
          endLineNumber = index + 1;
          index += 1;
          if (targetLine.startsWith("●")) {
            const unit: TranslationUnit = {
              source,
              target: targets,
            };
            units.push(unit);
            blocks.push({
              unit,
              startLineNumber,
              endLineNumber,
              sourceLineNumber,
              targetLineNumbers,
              metadata: {
                nameLineNumber,
              },
            });
            break;
          }
          continue;
        }
        break;
      }
      continue;
    }

    const sourceLineNumber = index + 1;
    const source = text;
    const targets: string[] = [];
    const targetLineNumbers: number[] = [];
    let endLineNumber = sourceLineNumber;
    let hasEmittedUnit = false;
    index += 1;

    while (index < lines.length) {
      const targetLine = lines[index]!.trim();
      if (!targetLine) {
        break;
      }
      if (targetLine.startsWith("○") || targetLine.startsWith("●")) {
        targets.push(targetLine.slice(1).trim());
        targetLineNumbers.push(index + 1);
        endLineNumber = index + 1;
        index += 1;
        if (targetLine.startsWith("●")) {
            const unit = normalizeBlankSourceUnit({
            source,
            target: targets,
            });
          units.push(unit);
          blocks.push({
            unit,
            startLineNumber,
            endLineNumber,
            sourceLineNumber,
            targetLineNumbers,
          });
            hasEmittedUnit = true;
          break;
        }
        continue;
      }
      break;
    }

      if (!hasEmittedUnit && source.trim().length === 0) {
        const unit = normalizeBlankSourceUnit({
          source,
          target: targets,
        });
        units.push(unit);
        blocks.push({
          unit,
          startLineNumber,
          endLineNumber,
          sourceLineNumber,
          targetLineNumbers,
        });
      }
  }

  return {
    units,
    blocks,
    rawLineCount: lines.length,
  };
}

/**
 * 仅译文模式解析：只读取 NAME 行和 ● 行，跳过所有 ○ 原文/候选行。
 * 每个 ● 行生成一个 TranslationUnit，source 为空，target 为译文文本。
 * 若当前 NAME 上下文存在，则为译文添加【角色名】前缀。
 */
function parseM3TDocumentTranslationOnly(content: string): TranslationUnit[] {
  const lines = content.split(/\r?\n/);
  const units: TranslationUnit[] = [];
  let currentName: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("○")) {
      const text = line.slice(1).trim();
      if (text.startsWith("NAME:")) {
        currentName = text.slice(5).trim() || undefined;
      }
      continue;
    }

    if (line.startsWith("●")) {
      const text = line.slice(1).trim();
      const target = currentName ? `【${currentName}】${text}` : text;
      units.push({ source: "", target: [target] });
      currentName = undefined;
    }
  }

  return units;
}
