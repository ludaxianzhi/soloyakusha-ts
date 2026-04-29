/**
 * 项目根导出模块，统一暴露文件处理、术语表、LLM、提示词管理、项目管理与文本对齐相关的公共 API。
 */

export * from "./src/file-handlers/index.ts";
export * from "./src/config/index.ts";
export * from "./src/glossary/index.ts";
export * from "./src/llm/index.ts";
export * from "./src/prompts/index.ts";
export * from "./src/project/context/index.ts";
export * from "./src/project/config.ts";
export * from "./src/project/document/index.ts";
export * from "./src/project/logger.ts";
export * from "./src/project/processing/default-translation-processor.ts";
export * from "./src/project/processing/multi-stage-translation-processor.ts";
export * from "./src/project/processing/proofread-processor-factory.ts";
export * from "./src/project/processing/proofread-processor.ts";
export * from "./src/project/processing/translation-output-repair.ts";
export * from "./src/project/processing/translation-processor-factory.ts";
export * from "./src/project/processing/translation-processor.ts";
export * from "./src/project/processing/translation-prompt-context.ts";
export * from "./src/project/pipeline/index.ts";
export * from "./src/project/analysis/index.ts";
export {
  PromptManager as ProjectPromptManager,
} from "./src/project/processing/prompt-manager.ts";
export type {
  PromptTranslationUnit,
  TranslationStepPromptInput,
  RenderedPrompt as ProjectRenderedPrompt,
} from "./src/project/processing/prompt-manager.ts";
export * from "./src/project/types.ts";
export * from "./src/style-library/index.ts";
export * from "./src/utils/index.ts";
export * from "./src/vector/index.ts";
