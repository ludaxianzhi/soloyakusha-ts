/**
 * 定义翻译文件处理器的抽象契约与共用辅助函数。
 *
 * 本模块提供：
 * - {@link TranslationFileHandler}: 抽象基类，定义读写接口
 * - {@link TranslationFileHandlerResolver}: 按文件路径解析处理器的函数类型
 * - stripBom: 移除 UTF-8 BOM 的辅助函数
 * - extractBracketNameAndText: 解析【角色名】正文格式的辅助函数
 *
 * @module file-handlers/base
 */

import type { TranslationUnit } from "../project/types.ts";

export const BLANK_PLACEHOLDER = "<blank/>";

export interface ParsedTranslationUnitBlock {
  unit: TranslationUnit;
  startLineNumber: number;
  endLineNumber: number;
  sourceLineNumber: number;
  targetLineNumbers: number[];
  metadata?: {
    nameLineNumber?: number;
  };
}

export interface ParsedTranslationDocument {
  units: TranslationUnit[];
  blocks: ParsedTranslationUnitBlock[];
  rawLineCount: number;
}

/**
 * 翻译文件处理器的抽象基类，约定具体格式实现必须提供的读写能力。
 *
 * 子类需要实现：
 * - formatName: 格式名称标识
 * - supportsComparable: 是否支持显示对照（原文译文并行显示）
 * - readTranslationUnits: 从文件读取翻译单元列表
 * - writeTranslationUnits: 将翻译单元列表写入文件
 * - parseTranslationDocument: 从字符串解析翻译单元及行级块信息
 * - formatTranslationUnits: 将翻译单元列表格式化为字符串
 */
export abstract class TranslationFileHandler {
  abstract readonly formatName: string;
  abstract readonly supportsComparable: boolean;

  abstract parseTranslationDocument(content: string): ParsedTranslationDocument;
  abstract formatTranslationUnits(units: TranslationUnit[]): string;
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

export function isBlankText(text: string | undefined): boolean {
  return typeof text === "string" && text.trim().length === 0;
}

export function isBlankPlaceholder(text: string | undefined): boolean {
  return text === BLANK_PLACEHOLDER;
}

export function isBlankSourceText(text: string | undefined): boolean {
  return isBlankText(text) || isBlankPlaceholder(text);
}

export function normalizeBlankSourceUnit(unit: TranslationUnit): TranslationUnit {
  if (!isBlankSourceText(unit.source)) {
    return {
      ...unit,
      target: [...unit.target],
    };
  }

  return {
    source: BLANK_PLACEHOLDER,
    target: [BLANK_PLACEHOLDER],
    metadata: unit.metadata ?? null,
  };
}

export function restoreBlankText(text: string): string {
  return isBlankPlaceholder(text) ? "" : text;
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
