/**
 * 定义翻译文件处理器的抽象契约，以及多种文件格式共用的文本解析辅助函数。
 */

import type { TranslationUnit } from "../project/types.ts";

/**
 * 翻译文件处理器的抽象基类，约定具体格式实现必须提供的读写能力。
 */
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
