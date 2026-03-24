/**
 * 定义提示词模板与渲染结果所使用的数据结构。
 *
 * 本模块主要用于描述提示词目录的 YAML/JSON 形状，以及模板渲染时
 * 可传入的变量集合和最终产物结构。
 *
 * @module prompts/types
 */

/**
 * 定义提示词模板与渲染结果所使用的数据结构。
 *
 * 本模块主要用于描述提示词目录的 YAML/JSON 形状，以及模板渲染时
 * 可传入的变量集合和最终产物结构。
 *
 * @module prompts/types
 */
export type PromptTemplateKind = "static" | "interpolate" | "liquid";

export type PromptRenderVariables = Record<string, unknown>;

export type PromptMessageTemplateDefinition = {
  type: PromptTemplateKind;
  template: string;
};

export type PromptDefinition = {
  system: PromptMessageTemplateDefinition;
  user: PromptMessageTemplateDefinition;
};

export type PromptCatalogDocument = {
  version?: number;
  prompts: Record<string, PromptDefinition>;
};

export type RenderedPrompt = {
  promptId: string;
  systemPrompt: string;
  userPrompt: string;
};