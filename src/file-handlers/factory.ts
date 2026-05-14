/**
 * 集中注册并创建不同翻译文件格式的处理器。
 *
 * 本模块提供 {@link TranslationFileHandlerFactory} 类，用于：
 * - 按格式名获取处理器实例
 * - 注册自定义格式处理器
 * - 创建按扩展名解析处理器的辅助函数
 *
 * 内置格式：plain_text、naturedialog、naturedialog_keepname、m3t、galtransl_json
 *
 * @module file-handlers/factory
 */

import { extname } from "node:path";
import type { TranslationFileHandlerResolver } from "./base.ts";
import { TranslationFileHandler } from "./base.ts";
import { DblTp1FileHandler } from "./dbl-tp1-file-handler.ts";
import { GaltranslJsonFileHandler } from "./galtransl-json-file-handler.ts";
import { M3TFileHandler } from "./m3t-file-handler.ts";
import {
  NatureDialogFileHandler,
  NatureDialogKeepNameFileHandler,
} from "./nature-dialog-file-handler.ts";
import { PlainTextFileHandler } from "./plain-text-file-handler.ts";

type TranslationFileHandlerFactoryFn = () => TranslationFileHandler;

/**
 * 翻译文件处理器工厂，负责按格式名或扩展名返回匹配的处理器实例。
 *
 * 使用方式：
 * - getHandler(formatName): 按格式名获取处理器
 * - registerHandler(formatName, handlerClass): 注册自定义处理器
 * - registerFactory(formatName, factoryFn): 注册带参数的处理器工厂
 * - createExtensionResolver(mapping): 创建扩展名到处理器的映射函数
 */
export class TranslationFileHandlerFactory {
  private static readonly factories = new Map<string, TranslationFileHandlerFactoryFn>([
    ["plain_text", () => new PlainTextFileHandler()],
    ["naturedialog", () => new NatureDialogFileHandler()],
    ["naturedialog_keepname", () => new NatureDialogKeepNameFileHandler()],
    ["m3t", () => new M3TFileHandler()],
    ["galtransl_json", () => new GaltranslJsonFileHandler()],
    ["dbl_tp1", () => new DblTp1FileHandler()],
  ]);

  static getHandler(formatName: string): TranslationFileHandler {
    const factory = this.factories.get(formatName.toLowerCase());
    if (!factory) {
      const supported = Array.from(this.factories.keys()).join(", ");
      throw new Error(
        `不支持的文件格式: ${formatName}。支持的格式: ${supported}`,
      );
    }

    return factory();
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
