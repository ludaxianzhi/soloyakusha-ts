/**
 * 集中注册并创建不同翻译文件格式的处理器。
 *
 * 本模块提供 {@link TranslationFileHandlerFactory} 类，用于：
 * - 按格式名获取处理器实例
 * - 注册自定义格式处理器
 * - 创建按扩展名解析处理器的辅助函数
 *
 * @module file-handlers/factory
 */

import { extname } from "node:path";
import type { FileHandlerParamDef, TranslationFileHandlerResolver } from "./base.ts";
import { TranslationFileHandler } from "./base.ts";
import { DblTp1FileHandler } from "./dbl-tp1-file-handler.ts";
import { DblTp2FileHandler } from "./dbl-tp2-file-handler.ts";
import { GaltranslJsonFileHandler } from "./galtransl-json-file-handler.ts";
import { M3TFileHandler } from "./m3t-file-handler.ts";
import { NdWithMetaFileHandler } from "./nd-with-meta-file-handler.ts";
import { NatureDialogFileHandler } from "./nature-dialog-file-handler.ts";
import { PlainTextFileHandler } from "./plain-text-file-handler.ts";

type TranslationFileHandlerFactoryFn = () => TranslationFileHandler;

/**
 * 翻译文件处理器工厂，负责按格式名或扩展名返回匹配的处理器实例。
 *
 * 使用方式：
 * - getHandler(formatName): 按格式名获取处理器
 * - getHandler(formatName, params): 按格式名获取处理器并应用参数
 * - getHandlerParamDefs(formatName, mode): 查询格式参数声明
 * - registerHandler(formatName, handlerClass): 注册自定义处理器
 * - registerFactory(formatName, factoryFn): 注册带参数的处理器工厂
 */
export class TranslationFileHandlerFactory {
  private static readonly factories = new Map<string, TranslationFileHandlerFactoryFn>([
    ["plain_text", () => new PlainTextFileHandler()],
    ["naturedialog", () => new NatureDialogFileHandler()],
    ["m3t", () => new M3TFileHandler()],
    ["galtransl_json", () => new GaltranslJsonFileHandler()],
    ["dbl_tp1", () => new DblTp1FileHandler()],
    ["dbl_tp2", () => new DblTp2FileHandler()],
    ["nd_with_meta", () => new NdWithMetaFileHandler()],
  ]);

  static getHandler(formatName: string): TranslationFileHandler;
  static getHandler(formatName: string, params?: Record<string, unknown>): TranslationFileHandler;
  static getHandler(
    formatName: string,
    params?: Record<string, unknown>,
  ): TranslationFileHandler {
    const factory = this.factories.get(formatName.toLowerCase());
    if (!factory) {
      const supported = Array.from(this.factories.keys()).join(", ");
      throw new Error(
        `不支持的文件格式: ${formatName}。支持的格式: ${supported}`,
      );
    }

    const handler = factory();
    if (params) {
      handler.applyParams(params);
    }
    return handler;
  }

  /**
   * 查询指定格式在导入/导出模式下的参数声明。
   */
  static getHandlerParamDefs(
    formatName: string,
    mode: "import" | "export",
  ): FileHandlerParamDef[] {
    const handler = this.getHandler(formatName);
    return mode === "import"
      ? handler.importParamDefs ?? []
      : handler.exportParamDefs ?? [];
  }

  static registerHandler(
    formatName: string,
    handlerClass: new () => TranslationFileHandler,
  ): void {
    this.factories.set(formatName.toLowerCase(), () => new handlerClass());
  }

  static registerFactory(
    formatName: string,
    factoryFn: TranslationFileHandlerFactoryFn,
  ): void {
    this.factories.set(formatName.toLowerCase(), factoryFn);
  }

  static createExtensionResolver(
    mapping: Record<string, string>,
  ): TranslationFileHandlerResolver {
    const normalizedMapping = Object.fromEntries(
      Object.entries(mapping).map(([extension, formatName]) => [
        extension.toLowerCase(),
        formatName,
      ]),
    );

    return (filePath) => {
      const extension = extname(filePath).toLowerCase();
      const formatName = normalizedMapping[extension];
      if (!formatName) {
        return undefined;
      }

      return this.getHandler(formatName);
    };
  }
}
