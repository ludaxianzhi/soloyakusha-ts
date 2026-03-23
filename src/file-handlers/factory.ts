/**
 * 集中注册并创建不同翻译文件格式的处理器，同时提供按文件扩展名解析处理器的辅助能力。
 */

import { extname } from "node:path";
import type { TranslationFileHandlerResolver } from "./base.ts";
import { TranslationFileHandler } from "./base.ts";
import { GaltranslJsonFileHandler } from "./galtransl-json-file-handler.ts";
import { M3TFileHandler } from "./m3t-file-handler.ts";
import {
  NatureDialogFileHandler,
  NatureDialogKeepNameFileHandler,
} from "./nature-dialog-file-handler.ts";
import { PlainTextFileHandler } from "./plain-text-file-handler.ts";

type TranslationFileHandlerConstructor = new () => TranslationFileHandler;

/**
 * 翻译文件处理器工厂，负责按格式名或扩展名返回匹配的处理器实例。
 */
export class TranslationFileHandlerFactory {
  private static readonly handlers = new Map<string, TranslationFileHandlerConstructor>([
    ["plain_text", PlainTextFileHandler],
    ["naturedialog", NatureDialogFileHandler],
    ["naturedialog_keepname", NatureDialogKeepNameFileHandler],
    ["m3t", M3TFileHandler],
    ["galtransl_json", GaltranslJsonFileHandler],
  ]);

  static getHandler(formatName: string): TranslationFileHandler {
    const handlerClass = this.handlers.get(formatName.toLowerCase());
    if (!handlerClass) {
      const supported = Array.from(this.handlers.keys()).join(", ");
      throw new Error(
        `不支持的文件格式: ${formatName}。支持的格式: ${supported}`,
      );
    }

    return new handlerClass();
  }

  static registerHandler(
    formatName: string,
    handlerClass: TranslationFileHandlerConstructor,
  ): void {
    this.handlers.set(formatName.toLowerCase(), handlerClass);
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
