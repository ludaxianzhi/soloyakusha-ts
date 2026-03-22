import { readFile, writeFile } from "node:fs/promises";
import type { TranslationUnit } from "../project/types.ts";
import {
  TranslationFileHandler,
  extractBracketNameAndText,
  stripBom,
} from "./base.ts";

export class M3TFileHandler extends TranslationFileHandler {
  readonly formatName = "m3t";
  readonly supportsComparable = true;

  override async readTranslationUnits(filePath: string): Promise<TranslationUnit[]> {
    const content = stripBom(await readFile(filePath, "utf8"));
    const lines = content.trim().split(/\r?\n/);
    const units: TranslationUnit[] = [];

    let index = 0;
    while (index < lines.length) {
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
        index += 1;
        while (index < lines.length && !lines[index]!.trim()) {
          index += 1;
        }

        const dialogLine = lines[index]?.trim();
        if (!dialogLine?.startsWith("○")) {
          index += 1;
          continue;
        }

        const sourceDialog = dialogLine.slice(1).trim();
        const source = `【${name}】${sourceDialog}`;
        index += 1;
        const targets: string[] = [];

        while (index < lines.length) {
          const targetLine = lines[index]!.trim();
          if (!targetLine) {
            break;
          }
          if (targetLine.startsWith("○") || targetLine.startsWith("●")) {
            targets.push(`【${name}】${targetLine.slice(1).trim()}`);
            index += 1;
            if (targetLine.startsWith("●")) {
              units.push({
                source,
                target: targets,
              });
              break;
            }
            continue;
          }
          break;
        }
        continue;
      }

      const source = text;
      const targets: string[] = [];
      index += 1;

      while (index < lines.length) {
        const targetLine = lines[index]!.trim();
        if (!targetLine) {
          break;
        }
        if (targetLine.startsWith("○") || targetLine.startsWith("●")) {
          targets.push(targetLine.slice(1).trim());
          index += 1;
          if (targetLine.startsWith("●")) {
            units.push({
              source,
              target: targets,
            });
            break;
          }
          continue;
        }
        break;
      }
    }

    return units;
  }

  override async writeTranslationUnits(
    filePath: string,
    units: TranslationUnit[],
  ): Promise<void> {
    const lines: string[] = [];

    for (const unit of units) {
      const parsed = extractBracketNameAndText(unit.source);
      if (parsed.name) {
        lines.push(`○ NAME: ${parsed.name}`);
        lines.push("");
        lines.push(`○ ${parsed.body}`);

        for (const [index, targetText] of unit.target.entries()) {
          const targetParsed = extractBracketNameAndText(targetText);
          const prefix = index === unit.target.length - 1 ? "●" : "○";
          lines.push(`${prefix} ${targetParsed.body}`);
        }
      } else {
        lines.push(`○ ${unit.source}`);
        for (const [index, targetText] of unit.target.entries()) {
          const prefix = index === unit.target.length - 1 ? "●" : "○";
          lines.push(`${prefix} ${targetText}`);
        }
      }

      lines.push("");
    }

    await writeFile(filePath, lines.join("\n"), "utf8");
  }
}
