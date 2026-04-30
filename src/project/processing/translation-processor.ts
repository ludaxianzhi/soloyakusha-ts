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
import type { StyleGuidanceMode } from "../types.ts";
import type { FragmentAuxData, FragmentAuxDataPatch, SlidingWindowOptions, SlidingWindowFragment } from "../types.ts";

export type TranslationProcessorRequest = {
  sourceText: string;
  contextView?: TranslationContextView;
  glossary?: Glossary;
  requirements?: ReadonlyArray<string>;
  editorRequirementsText?: string;
  styleGuidanceMode?: StyleGuidanceMode;
  styleRequirementsText?: string;
  styleLibraryName?: string;
  requestOptions?: ChatRequestOptions;
  documentManager?: TranslationDocumentManager;
  slidingWindow?: SlidingWindowOptions;
  workItemRef?: {
    chapterId: number;
    fragmentIndex: number;
    stepId?: string;
  };
  /** 该文本块当前已持久化的辅助数据，供消费方按需读取。 */
  fragmentAuxData?: FragmentAuxData;
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
  /** 处理器希望写入此文本块辅助数据的增量补丁；undefined 表示不修改辅助数据。 */
  fragmentAuxDataPatch?: FragmentAuxDataPatch;
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
      | "glossary"
      | "requestOptions"
      | "documentManager"
      | "slidingWindow"
      | "editorRequirementsText"
      | "styleGuidanceMode"
      | "styleRequirementsText"
      | "styleLibraryName"
    >,
  ): Promise<TranslationProcessorResult>;

  process(request: TranslationProcessorRequest): Promise<TranslationProcessorResult>;
}
