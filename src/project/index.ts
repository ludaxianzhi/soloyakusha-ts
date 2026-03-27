/**
 * 汇总导出翻译项目模块的公共类型与核心实现。
 *
 * 本模块提供翻译项目的完整生命周期管理，包括：
 * - 项目初始化与配置解析
 * - 章节加载与文本切分
 * - 基于 Pipeline 的并发任务分发
 * - 上下文视图构建（术语表、依赖链翻译参考）
 * - 步骤工作队列
 * - 运行生命周期管理（start / stop / resume）
 * - 项目状态与队列快照
 * - 翻译结果提交与持久化
 * - 进度统计与保存点
 *
 * 导出的主要类：
 * - {@link TranslationProject}: 翻译项目协调器，串联所有组件
 * - {@link TranslationDocumentManager}: 文档管理器，负责章节读写与片段持久化
 * - {@link TranslationContextView}: 上下文视图，聚合当前片段的翻译参考
 * - {@link DefaultTextSplitter}: 默认文本切分器，按字符上限划分片段
 * - {@link GlobalAssociationPatternScanner}: 全局关联模式扫描器
 *
 * @module project
 */

export * from "./context-view.ts";
export * from "./plot-summarizer.ts";
export * from "./config.ts";
export * from "./default-translation-processor.ts";
export * from "./global-pattern-scanner.ts";
export * from "./logger.ts";
export * from "./pipeline.ts";
export * from "./prompt-manager.ts";
export * from "./translation-document-manager.ts";
export * from "./translation-processor.ts";
export * from "./translation-processor-factory.ts";
export * from "./translation-project.ts";
export * from "./types.ts";
