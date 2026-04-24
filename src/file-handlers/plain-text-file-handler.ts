/**
 * 实现纯文本行级格式的读写逻辑，将每个非空行视为一个翻译单元。
 *
 * 文件格式示例：
 * ```
 * 第一行原文
 * 第二行原文
 * 第三行原文
 * ```
 *
 * 读取时：每个非空行成为一个翻译单元，空行被忽略
 * 写入时：每个翻译单元的最后译文占一行
 *
 * @module file-handlers/plain-text-file-handler
 */

import { readFile, writeFile } from "node:fs/promises";
import type { TranslationUnit } from "../project/types.ts";
import {
  type ParsedTranslationDocument,
  type ParsedTranslationUnitBlock,
  TranslationFileHandler,
  restoreBlankText,
  stripBom,
} from "./base.ts";

/**
 * 纯文本处理器，把每个非空行映射为一个独立的翻译单元。
 *
 * 特点：
 * - 简单直接，无格式要求
 * - 不支持原名对照（supportsComparable = false）
 * - 自动移除 UTF-8 BOM
 */
export class PlainTextFileHandler extends TranslationFileHandler {
  readonly formatName = "plain_text";
  readonly supportsComparable = false;

  override parseTranslationDocument(content: string): ParsedTranslationDocument {
    const lines = stripBom(content)
      .split(/\r?\n/)
      .map((line) => line.trim());
    const units: TranslationUnit[] = [];
    const blocks: ParsedTranslationUnitBlock[] = [];

    lines.forEach((line, index) => {
      if (!line) {
        return;
      }
      const unit: TranslationUnit = {
        source: line,
        target: [],
        metadata: null,
      };
      units.push(unit);
      blocks.push({
        unit,
        startLineNumber: index + 1,
        endLineNumber: index + 1,
        sourceLineNumber: index + 1,
        targetLineNumbers: [],
      });
    });

    return {
      units,
      blocks,
      rawLineCount: lines.length,
    };
  }

  override formatTranslationUnits(units: TranslationUnit[]): string {
    const lines = units.map((unit) => restoreBlankText(unit.target.at(-1) ?? unit.source));
    return `${lines.join("\n")}\n`;
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
}
