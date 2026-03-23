/**
 * 实现 Nature Dialog 风格文本的读写，支持源文、译文和角色名保留等规则。
 */

import { readFile, writeFile } from "node:fs/promises";
import type { TranslationUnit } from "../project/types.ts";
import {
  TranslationFileHandler,
  extractBracketNameAndText,
  stripBom,
} from "./base.ts";

/**
 * Nature Dialog 处理器，负责解析和生成带有对话标记的文本格式。
 */
export class NatureDialogFileHandler extends TranslationFileHandler {
  readonly formatName: string = "naturedialog";
  readonly supportsComparable = true;

  override async readTranslationUnits(filePath: string): Promise<TranslationUnit[]> {
    const content = stripBom(await readFile(filePath, "utf8"));
    const lines = content.trim().split(/\r?\n/);
    const units: TranslationUnit[] = [];

    let currentSource: string | undefined;
    let currentTargets: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        if (currentSource !== undefined && currentTargets.length > 0) {
          units.push({
            source: currentSource,
            target: currentTargets,
          });
          currentSource = undefined;
          currentTargets = [];
        }
        continue;
      }

      if (line.startsWith("○")) {
        const text = line.slice(1).trim();
        if (currentSource === undefined) {
          currentSource = text;
        } else {
          currentTargets.push(text);
        }
        continue;
      }

      if (line.startsWith("●")) {
        const text = line.slice(1).trim();
        currentTargets.push(text);
        if (currentSource !== undefined) {
          units.push({
            source: currentSource,
            target: currentTargets,
          });
          currentSource = undefined;
          currentTargets = [];
        }
      }
    }

    if (currentSource !== undefined && currentTargets.length > 0) {
      units.push({
        source: currentSource,
        target: currentTargets,
      });
    }

    return units;
  }

  override async writeTranslationUnits(
    filePath: string,
    units: TranslationUnit[],
  ): Promise<void> {
    const lines: string[] = [];

    for (const unit of units) {
      lines.push(`○ ${unit.source}`);
      for (const [index, targetText] of unit.target.entries()) {
        const prefix = index === unit.target.length - 1 ? "●" : "○";
        lines.push(`${prefix} ${targetText}`);
      }
      lines.push("");
    }

    await writeFile(filePath, lines.join("\n"), "utf8");
  }
}

/**
 * 保留原始角色名的 Nature Dialog 处理器，用于只替换正文而不改写称谓。
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
    const processedUnits = units.map((unit) => ({
      ...unit,
      target: unit.target.map((target) =>
        this.processTranslationPair(unit.source, target),
      ),
    }));

    await super.writeTranslationUnits(filePath, processedUnits);
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
