/**
 * 汇总导出提示词模板与 YAML 资源加载能力。
 *
 * 本模块提供三类提示词：
 * - static：静态文本
 * - interpolate：基于 ${variable} 的字符串内插模板
 * - liquid：支持变量、条件和循环的 Liquid 风格模板
 *
 * @module prompts
 */

export * from "./manager.ts";
export * from "./templates.ts";
export * from "./types.ts";