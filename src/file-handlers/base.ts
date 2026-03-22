import type { TranslationUnit } from "../project/types.ts";

export abstract class TranslationFileHandler {
  abstract readonly formatName: string;
  abstract readonly supportsComparable: boolean;

  abstract readTranslationUnits(filePath: string): Promise<TranslationUnit[]>;
  abstract writeTranslationUnits(
    filePath: string,
    units: TranslationUnit[],
  ): Promise<void>;
}

export type TranslationFileHandlerResolver = (
  filePath: string,
) => TranslationFileHandler | undefined;

export function stripBom(content: string): string {
  return content.startsWith("\uFEFF") ? content.slice(1) : content;
}

export function extractBracketNameAndText(text: string): {
  name?: string;
  body: string;
} {
  const match = text.match(/^【(.+?)】([\s\S]+)$/);
  if (!match) {
    return {
      body: text,
    };
  }

  return {
    name: match[1] ?? undefined,
    body: match[2] ?? text,
  };
}
