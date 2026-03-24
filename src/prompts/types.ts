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