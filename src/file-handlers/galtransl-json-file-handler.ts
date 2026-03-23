/**
 * 实现 Galtransl JSON 格式的读写，在结构化字段与内部翻译单元之间做转换。
 */

import { readFile, writeFile } from "node:fs/promises";
import type { TranslationUnit } from "../project/types.ts";
import {
  TranslationFileHandler,
  extractBracketNameAndText,
} from "./base.ts";

/**
 * Galtransl JSON 处理器，把结构化消息对象转换为内部翻译单元。
 */
export class GaltranslJsonFileHandler extends TranslationFileHandler {
  readonly formatName = "galtransl_json";
  readonly supportsComparable = false;

  override async readTranslationUnits(filePath: string): Promise<TranslationUnit[]> {
    const content = await readFile(filePath, "utf8");
    const data = JSON.parse(content) as Array<Record<string, unknown>>;

    return data.map<TranslationUnit>((item) => {
      const message = typeof item.message === "string" ? item.message : "";
      const name = typeof item.name === "string" ? item.name : undefined;
      return {
        source: name ? `【${name}】${message}` : message,
        target: [],
      };
    });
  }

  override async writeTranslationUnits(
    filePath: string,
    units: TranslationUnit[],
  ): Promise<void> {
    const data = units.map((unit) => {
      const textToWrite = unit.target.at(-1) ?? unit.source;
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

    await writeFile(filePath, JSON.stringify(data, null, 4), "utf8");
  }
}
