import { readFile, writeFile } from "node:fs/promises";
import type { TranslationUnit } from "../project/types.ts";
import { TranslationFileHandler, stripBom } from "./base.ts";

export class PlainTextFileHandler extends TranslationFileHandler {
  readonly formatName = "plain_text";
  readonly supportsComparable = false;

  override async readTranslationUnits(filePath: string): Promise<TranslationUnit[]> {
    const content = stripBom(await readFile(filePath, "utf8"));
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map<TranslationUnit>((line) => ({
        source: line,
        target: [],
        metadata: null,
      }));
  }

  override async writeTranslationUnits(
    filePath: string,
    units: TranslationUnit[],
  ): Promise<void> {
    const lines = units.map((unit) => unit.target.at(-1) ?? unit.source);
    await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  }
}
