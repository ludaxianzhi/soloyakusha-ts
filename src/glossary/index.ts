/**
 * 汇总导出术语表模型及其持久化实现。
 *
 * 本模块提供翻译项目中的术语表管理能力：
 * - {@link Glossary}: 内存中的术语表模型，支持增删查改、状态/统计维护与筛选渲染
 * - {@link FullTextGlossaryScanner}: 全文级 LLM 术语扫描器
 * - {@link GlossaryPersister}: 抽象持久化接口
 * - 多格式持久化实现：JSON、CSV、TSV、YAML、XML
 * - {@link GlossaryPersisterFactory}: 按文件扩展名选择持久化器
 *
 * @module glossary
 */

export * from "./glossary.ts";
export * from "./persister.ts";
export * from "./scanner.ts";
export * from "./updater.ts";
