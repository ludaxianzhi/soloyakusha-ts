/**
 * 汇总导出通用文本处理与对齐工具。
 *
 * 本模块提供基于语义嵌入的文本对齐能力，用于将原文片段序列与译文片段序列进行智能匹配。
 * 核心应用场景包括：机器翻译后处理、双语语料对齐、翻译质量评估等。
 *
 * 导出的主要类：
 * - {@link TextAligner}: 文本对齐器抽象基类，定义对齐接口
 * - {@link DefaultTextAligner}: 默认对齐器，采用贪心启发式策略
 * - {@link DynamicTextAligner}: 动态规划对齐器，通过全局优化求解
 * - {@link SimplifiedDynamicTextAligner}: 简化版动态规划对齐器，适合常见场景
 * - {@link AlignmentRepairTool}: 对齐检查与漏翻补全工具
 *
 * @module utils
 */

export * from "./alignment-repair.ts";
export * from "./text-align.ts";
export * from "./text-post-processor.ts";
