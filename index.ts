/**
 * 项目根导出模块，统一暴露文件处理、术语表、LLM、提示词管理、项目管理与文本对齐相关的公共 API。
 */

export * from "./src/file-handlers/index.ts";
export * from "./src/config/index.ts";
export * from "./src/glossary/index.ts";
export * from "./src/llm/index.ts";
export * from "./src/prompts/index.ts";
export * from "./src/project/context-view.ts";
export * from "./src/project/config.ts";
export * from "./src/project/default-translation-processor.ts";
export * from "./src/project/multi-stage-translation-processor.ts";
export * from "./src/project/global-pattern-scanner.ts";
export * from "./src/project/logger.ts";
export * from "./src/project/pipeline.ts";
export {
  PromptManager as ProjectPromptManager,
} from "./src/project/prompt-manager.ts";
export type {
  PromptTranslationUnit,
  TranslationStepPromptInput,
  RenderedPrompt as ProjectRenderedPrompt,
} from "./src/project/prompt-manager.ts";
export * from "./src/project/translation-document-manager.ts";
export * from "./src/project/translation-processor.ts";
export * from "./src/project/translation-processor-factory.ts";
export * from "./src/project/translation-project.ts";
export * from "./src/project/types.ts";
export * from "./src/utils/index.ts";
