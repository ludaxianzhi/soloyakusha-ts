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
import type { ReadTextFileResult } from "./encoding-utils.ts";
import { readTextFile } from "./encoding-utils.ts";

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
 * 文件格式参数定义，前端根据此描述自动渲染参数输入控件。
 */
export interface FileHandlerParamDef {
  /** 参数键名，传入 applyParams 时的键 */
  key: string;
  /** UI 显示标签 */
  label: string;
  /** 参数类型 */
  type: "string" | "boolean" | "select" | "number";
  /** 默认值 */
  defaultValue?: unknown;
  /** select 类型的候选项 */
  options?: { label: string; value: string }[];
  /** 帮助提示文本 */
  description?: string;
  /** 是否必填 */
  required?: boolean;
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
 *
 * 可选覆盖：
 * - importParamDefs / exportParamDefs: 声明导入/导出参数（前端自动渲染）
 * - applyParams: 应用用户传入的参数值
 */
export abstract class TranslationFileHandler {
  abstract readonly formatName: string;
  abstract readonly supportsComparable: boolean;

  /** 导入参数声明（前端据此自动渲染表单） */
  readonly importParamDefs?: FileHandlerParamDef[];
  /** 导出参数声明 */
  readonly exportParamDefs?: FileHandlerParamDef[];

  /** 应用运行时参数（来自用户前端填写的值） */
  applyParams(_params: Record<string, unknown>): void {}

  abstract parseTranslationDocument(content: string): ParsedTranslationDocument;
  abstract formatTranslationUnits(units: TranslationUnit[]): string;
  abstract readTranslationUnits(filePath: string): Promise<TranslationUnit[]>;
  abstract writeTranslationUnits(
    filePath: string,
    units: TranslationUnit[],
  ): Promise<void>;

  /**
   * 自动检测编码读取文件内容，返回解码后的 UTF-8 字符串。
   * 子类的 readTranslationUnits 应优先使用此方法而非直接 readFile。
   */
  protected async readFileContent(filePath: string): Promise<ReadTextFileResult> {
    return readTextFile(filePath);
  }

  /**
   * 以"仅译文"模式读取翻译单元，专用于从压缩包更新译文的场景。
   * 默认行为与 readTranslationUnits 相同；格式处理器可覆盖此方法
   * 仅提取译文行（如 m3t 的 ● 行、nd 的 ● 行），跳过原文行。
   */
  async readTranslationUnitsForUpdate(filePath: string): Promise<TranslationUnit[]> {
    return this.readTranslationUnits(filePath);
  }
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
    comment: unit.comment,
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

/**
 * 将译文数组中的角色名替换为原文角色名。
 * 原文无角色名的单元保持不变。
 */
export function keepSourceNameInTarget(units: TranslationUnit[]): TranslationUnit[] {
  return units.map((unit) => {
    const sourceParsed = extractBracketNameAndText(unit.source);
    if (!sourceParsed.name) {
      return { ...unit, target: [...unit.target] };
    }

    return {
      ...unit,
      target: unit.target.map((t) => {
        const targetParsed = extractBracketNameAndText(t);
        if (targetParsed.name) {
          return `【${sourceParsed.name}】${targetParsed.body}`;
        }
        return t;
      }),
    };
  });
}
