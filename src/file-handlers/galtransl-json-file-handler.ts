/**
 * 实现 Galtransl JSON 格式的读写，在结构化字段与内部翻译单元之间做转换。
 *
 * 文件格式示例：
 * ```json
 * [
 *   { "name": "角色名", "message": "对话内容" },
 *   { "message": "无角色名的文本" }
 * ]
 * ```
 *
 * 格式说明：
 * - name 字段：可选的角色名，会组合为【角色名】前缀
 * - message 字段：正文内容
 *
 * @module file-handlers/galtransl-json-file-handler
 */

import { readFile, writeFile } from "node:fs/promises";
import type { TranslationUnit } from "../project/types.ts";
import {
  type ParsedTranslationDocument,
  type ParsedTranslationUnitBlock,
  TranslationFileHandler,
  extractBracketNameAndText,
  normalizeBlankSourceUnit,
  restoreBlankText,
} from "./base.ts";

/**
 * Galtransl JSON 处理器，把结构化消息对象转换为内部翻译单元。
 *
 * 解析逻辑：
 * - 有 name 字段：组合为【name】message 格式
 * - 无 name 字段：直接使用 message
 *
 * 输出逻辑：
 * - 【角色名】正文格式：拆分为 name + message 字段
 * - 普通正文：只输出 message 字段
 */
export class GaltranslJsonFileHandler extends TranslationFileHandler {
  readonly formatName = "galtransl_json";
  readonly supportsComparable = false;

  override parseTranslationDocument(content: string): ParsedTranslationDocument {
    const data = JSON.parse(content) as Array<Record<string, unknown>>;
    const units = data.map<TranslationUnit>((item) => {
      const message = typeof item.message === "string" ? item.message : "";
      const name = typeof item.name === "string" ? item.name : undefined;
      return normalizeBlankSourceUnit({
        source: name ? `【${name}】${message}` : message,
        target: [],
      });
    });
    const blocks = units.map<ParsedTranslationUnitBlock>((unit, index) => ({
      unit,
      startLineNumber: index + 1,
      endLineNumber: index + 1,
      sourceLineNumber: index + 1,
      targetLineNumbers: [],
    }));
    return {
      units,
      blocks,
      rawLineCount: data.length,
    };
  }

  override formatTranslationUnits(units: TranslationUnit[]): string {
    const data = units.map((unit) => {
      const textToWrite = restoreBlankText(unit.target.at(-1) ?? unit.source);
      const parsed = extractBracketNameAndText(textToWrite);
      if (parsed.name) {
        return {
          name: parsed.name,
          message: parsed.body,
        };
      }

      return {
        message: parsed.body,
      };
    });
    return JSON.stringify(data, null, 4);
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
