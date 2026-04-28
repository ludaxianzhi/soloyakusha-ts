/**
 * 定义翻译流程处理器的公共接口、请求参数与结果结构。
 *
 * @module project/translation-processor
 */

import type { Glossary, GlossaryTranslationUpdate } from "../../glossary/glossary.ts";
import type { GlossaryUpdateExecutionResult } from "../../glossary/updater.ts";
import type { ChatClient } from "../../llm/base.ts";
import { LlmClientProvider } from "../../llm/provider.ts";
import type { ChatRequestOptions, JsonObject } from "../../llm/types.ts";
import type { TranslationContextView } from "../context/context-view.ts";
import type { TranslationWorkItem } from "../pipeline/pipeline.ts";
import type { TranslationDocumentManager } from "../document/translation-document-manager.ts";
import type { SlidingWindowOptions, SlidingWindowFragment } from "../types.ts";

export type TranslationProcessorRequest = {
  sourceText: string;
  contextView?: TranslationContextView;
  glossary?: Glossary;
  requirements?: ReadonlyArray<string>;
  editorRequirementsText?: string;
  requestOptions?: ChatRequestOptions;
  documentManager?: TranslationDocumentManager;
  slidingWindow?: SlidingWindowOptions;
  workItemRef?: {
    chapterId: number;
    fragmentIndex: number;
    stepId?: string;
  };
};

export type TranslationProcessorTranslation = {
  id: string;
  translation: string;
};

export type TranslationProcessorResult = {
  outputText: string;
  translations: TranslationProcessorTranslation[];
  glossaryUpdates: GlossaryTranslationUpdate[];
  glossaryUpdateResult?: GlossaryUpdateExecutionResult;
  responseText: string;
  responseSchema: JsonObject;
  promptName: string;
  systemPrompt: string;
  userPrompt: string;
  window?: SlidingWindowFragment;
};

export type TranslationProcessorClientResolver =
  | ChatClient
  | {
      provider: LlmClientProvider;
      modelName: string;
    };

export interface TranslationProcessor {
  processWorkItem(
    workItem: TranslationWorkItem,
    options?: Pick<
      TranslationProcessorRequest,
      "glossary" | "requestOptions" | "documentManager" | "slidingWindow" | "editorRequirementsText"
    >,
  ): Promise<TranslationProcessorResult>;

  process(request: TranslationProcessorRequest): Promise<TranslationProcessorResult>;
}
