/**
 * 汇总导出所有翻译文件处理器相关的公共接口与实现。
 *
 * 本模块提供多种翻译文件格式的读写能力：
 * - {@link TranslationFileHandler}: 抽象基类，定义读写接口
 * - {@link TranslationFileHandlerFactory}: 工厂类，按格式名或扩展名创建处理器
 *
 * 支持的文件格式：
 * - plain_text: 纯文本，每行一个翻译单元
 * - naturedialog: Nature Dialog 风格，使用 ○● 标记原文译文
 * - naturedialog_keepname: 保留角色名的 Nature Dialog 格式
 * - m3t: M3T 对话格式，带 NAME 字段
 * - galtransl_json: Galtransl JSON 格式，结构化消息对象
 *
 * @module file-handlers
 */

export * from "./base.ts";
export * from "./factory.ts";
export * from "./galtransl-json-file-handler.ts";
export * from "./m3t-file-handler.ts";
export * from "./nature-dialog-file-handler.ts";
export * from "./plain-text-file-handler.ts";
