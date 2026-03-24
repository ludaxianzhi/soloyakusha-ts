/**
 * 提供面向 TranslationWorkItem 的最简翻译/文本处理接口。
 *
 * 该处理器会在同一步中同步完成：
 * - 基于 context-view 执行翻译
 * - 识别并回填命中的未翻译术语译文
 *
 * @module project/translation-processor
 */

import type {
  Glossary,
  GlossaryTranslationUpdate,
  ResolvedGlossaryTerm,
} from "../glossary/glossary.ts";
import type { ChatClient } from "../llm/base.ts";
import { LlmClientProvider } from "../llm/provider.ts";
import {
  resolveRequestConfig,
  type ChatRequestOptions,
  type JsonObject,
} from "../llm/types.ts";
import type { TranslationContextView } from "./context-view.ts";
import { NOOP_LOGGER, type Logger } from "./logger.ts";
import { PromptManager, type PromptTranslationUnit } from "./prompt-manager.ts";
import type { TranslationWorkItem } from "./pipeline.ts";
import { TranslationDocumentManager } from "./translation-document-manager.ts";
import type { SlidingWindowOptions, SlidingWindowFragment } from "./types.ts";

export type TranslationProcessorRequest = {
  sourceText: string;
  contextView?: TranslationContextView;
  glossary?: Glossary;
  requirements?: ReadonlyArray<string>;
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

export class TranslationProcessor {
  private readonly logger: Logger;
  private readonly defaultRequestOptions?: ChatRequestOptions;
  private readonly defaultSlidingWindow?: SlidingWindowOptions;
  private readonly translatorName?: string;

  constructor(
    private readonly clientResolver: TranslationProcessorClientResolver,
    options: {
      promptManager?: PromptManager;
      defaultRequestOptions?: ChatRequestOptions;
      defaultSlidingWindow?: SlidingWindowOptions;
      logger?: Logger;
      translatorName?: string;
    } = {},
  ) {
    this.promptManager = options.promptManager ?? new PromptManager();
    this.defaultRequestOptions = options.defaultRequestOptions;
    this.defaultSlidingWindow = options.defaultSlidingWindow;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.translatorName = options.translatorName;
  }

  private readonly promptManager: PromptManager;

  async processWorkItem(
    workItem: TranslationWorkItem,
    options: Pick<
      TranslationProcessorRequest,
      "glossary" | "requestOptions" | "documentManager" | "slidingWindow"
    > = {},
  ): Promise<TranslationProcessorResult> {
    return this.process({
      sourceText: workItem.inputText,
      contextView: workItem.contextView,
      glossary: options.glossary,
      requirements: workItem.requirements,
      requestOptions: options.requestOptions,
      documentManager: options.documentManager,
      slidingWindow: options.slidingWindow,
      workItemRef: {
        chapterId: workItem.chapterId,
        fragmentIndex: workItem.fragmentIndex,
        stepId: workItem.stepId,
      },
    });
  }

  async process(request: TranslationProcessorRequest): Promise<TranslationProcessorResult> {
    const window = resolveSlidingWindow(request, this.defaultSlidingWindow);
    const sourceUnits = window
      ? buildSourceUnitsFromLines(window.source.lines)
      : splitSourceTextIntoUnits(request.sourceText);
    if (sourceUnits.length === 0) {
      return {
        outputText: "",
        translations: [],
        glossaryUpdates: [],
        responseText: JSON.stringify({ translations: [], glossaryUpdates: [] }),
        responseSchema: buildEmptyResponseSchema(),
        promptName: "translation_pipeline_result",
        systemPrompt: "",
        userPrompt: "",
        window,
      };
    }

    this.logger.info?.("开始执行翻译处理", {
      translatorName: this.translatorName,
      modelName: getResolvedModelName(this.clientResolver),
      sourceUnitCount: sourceUnits.length,
      windowEnabled: Boolean(window),
      chapterId: request.workItemRef?.chapterId,
      fragmentIndex: request.workItemRef?.fragmentIndex,
      stepId: request.workItemRef?.stepId,
    });

    const translatedGlossaryTerms = resolveTranslatedGlossaryTerms(request);
    const untranslatedGlossaryTerms = resolveUntranslatedGlossaryTerms(request);
    const dependencyTranslations =
      request.contextView?.getDependencyTranslatedTexts() ?? [];
    const renderedPrompt = await this.promptManager.renderTranslationStepPrompt({
      sourceUnits,
      dependencyTranslations,
      translatedGlossaryTerms,
      untranslatedGlossaryTerms,
      requirements: [...(request.requirements ?? [])],
    });
    const responseText = await this.resolveChatClient().singleTurnRequest(
      renderedPrompt.userPrompt,
      buildTranslationRequestOptions(
        mergeChatRequestOptions(this.defaultRequestOptions, request.requestOptions),
        renderedPrompt,
      ),
    );
    const parsed = parseTranslationProcessorResponse(
      responseText,
      sourceUnits.map((unit) => unit.id),
      untranslatedGlossaryTerms.map((term) => term.term),
    );

    if (request.glossary && parsed.glossaryUpdates.length > 0) {
      request.glossary.applyTranslations(parsed.glossaryUpdates);
    }

    const outputText = buildOutputText(parsed.translations, window);
    this.logger.info?.("翻译处理完成", {
      translatorName: this.translatorName,
      modelName: getResolvedModelName(this.clientResolver),
      translatedUnitCount: parsed.translations.length,
      glossaryUpdateCount: parsed.glossaryUpdates.length,
      outputLineCount: outputText.length === 0 ? 0 : outputText.split("\n").length,
      windowEnabled: Boolean(window),
      chapterId: request.workItemRef?.chapterId,
      fragmentIndex: request.workItemRef?.fragmentIndex,
      stepId: request.workItemRef?.stepId,
    });

    return {
      outputText,
      translations: parsed.translations,
      glossaryUpdates: parsed.glossaryUpdates,
      responseText,
      responseSchema: renderedPrompt.responseSchema,
      promptName: renderedPrompt.name,
      systemPrompt: renderedPrompt.systemPrompt,
      userPrompt: renderedPrompt.userPrompt,
      window,
    };
  }

  private resolveChatClient(): ChatClient {
    if ("singleTurnRequest" in this.clientResolver) {
      return this.clientResolver;
    }

    return this.clientResolver.provider.getChatClient(this.clientResolver.modelName);
  }
}

function buildTranslationRequestOptions(
  requestOptions: ChatRequestOptions | undefined,
  prompt: {
    name: string;
    systemPrompt: string;
    responseSchema: JsonObject;
  },
): ChatRequestOptions {
  const requestConfig = requestOptions?.requestConfig;
  const extraSystemPrompt = requestConfig?.systemPrompt?.trim();

  return {
    ...requestOptions,
    requestConfig: {
      ...requestConfig,
      systemPrompt: extraSystemPrompt
        ? `${prompt.systemPrompt}\n${extraSystemPrompt}`
        : prompt.systemPrompt,
      extraBody: {
        ...(requestConfig?.extraBody ?? {}),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: prompt.name,
            strict: true,
            schema: prompt.responseSchema,
          },
        },
      },
    },
  };
}

function mergeChatRequestOptions(
  defaultOptions: ChatRequestOptions | undefined,
  overrideOptions: ChatRequestOptions | undefined,
): ChatRequestOptions | undefined {
  if (!defaultOptions && !overrideOptions) {
    return undefined;
  }

  const defaultRequestConfig = defaultOptions?.requestConfig;
  const overrideRequestConfig = overrideOptions?.requestConfig;

  return {
    outputValidator: overrideOptions?.outputValidator ?? defaultOptions?.outputValidator,
    outputValidationContext:
      overrideOptions?.outputValidationContext ??
      defaultOptions?.outputValidationContext,
    requestConfig:
      defaultRequestConfig || overrideRequestConfig
        ? resolveRequestConfig(overrideRequestConfig, defaultRequestConfig)
        : undefined,
  };
}

function splitSourceTextIntoUnits(sourceText: string): PromptTranslationUnit[] {
  return sourceText.split("\n").map((text, index) => ({
    id: (index + 1).toString(),
    text,
  }));
}

function buildSourceUnitsFromLines(lines: ReadonlyArray<string>): PromptTranslationUnit[] {
  return lines.map((text, index) => ({
    id: (index + 1).toString(),
    text,
  }));
}

function resolveTranslatedGlossaryTerms(
  request: TranslationProcessorRequest,
): ResolvedGlossaryTerm[] {
  if (request.contextView) {
    return request.contextView.getTranslatedGlossaryTerms();
  }

  return request.glossary?.getTranslatedTermsForText(request.sourceText) ?? [];
}

function resolveUntranslatedGlossaryTerms(
  request: TranslationProcessorRequest,
): ResolvedGlossaryTerm[] {
  if (request.contextView) {
    return request.contextView.getUntranslatedGlossaryTerms();
  }

  return request.glossary?.getUntranslatedTermsForText(request.sourceText) ?? [];
}

function parseTranslationProcessorResponse(
  responseText: string,
  expectedIds: ReadonlyArray<string>,
  allowedGlossaryTerms: ReadonlyArray<string>,
): {
  translations: TranslationProcessorTranslation[];
  glossaryUpdates: GlossaryTranslationUpdate[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch (error) {
    throw new Error(
      `翻译处理结果不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("翻译处理结果必须是 JSON 对象");
  }

  const translationValues = parsed.translations;
  if (!Array.isArray(translationValues)) {
    throw new Error("翻译处理结果缺少 translations 数组");
  }

  const expectedIdSet = new Set(expectedIds);
  const seenTranslationIds = new Set<string>();
  const translationMap = new Map<string, string>();
  const translations = translationValues.map<TranslationProcessorTranslation>((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`translations[${index}] 必须是对象`);
    }

    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const translation =
      typeof entry.translation === "string" ? entry.translation.trim() : "";
    if (!id) {
      throw new Error(`translations[${index}].id 必须是非空字符串`);
    }
    if (!expectedIdSet.has(id)) {
      throw new Error(`翻译处理结果返回了未请求的 id: ${id}`);
    }
    if (seenTranslationIds.has(id)) {
      throw new Error(`翻译处理结果返回了重复的 id: ${id}`);
    }
    if (!translation) {
      throw new Error(`translations[${index}].translation 必须是非空字符串`);
    }

    seenTranslationIds.add(id);
    translationMap.set(id, translation);
    return { id, translation };
  });

  const missingIds = expectedIds.filter((id) => !translationMap.has(id));
  if (missingIds.length > 0) {
    throw new Error(`翻译处理结果缺少以下 id: ${missingIds.join(", ")}`);
  }

  const allowedGlossaryTermSet = new Set(allowedGlossaryTerms);
  const glossaryValues = parsed.glossaryUpdates;
  if (!Array.isArray(glossaryValues)) {
    throw new Error("翻译处理结果缺少 glossaryUpdates 数组");
  }

  const seenGlossaryTerms = new Set<string>();
  const glossaryUpdates = glossaryValues.map<GlossaryTranslationUpdate>((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`glossaryUpdates[${index}] 必须是对象`);
    }

    const term = typeof entry.term === "string" ? entry.term.trim() : "";
    const translation =
      typeof entry.translation === "string" ? entry.translation.trim() : "";
    if (!term) {
      throw new Error(`glossaryUpdates[${index}].term 必须是非空字符串`);
    }
    if (!allowedGlossaryTermSet.has(term)) {
      throw new Error(`glossaryUpdates 返回了未请求的术语: ${term}`);
    }
    if (seenGlossaryTerms.has(term)) {
      throw new Error(`glossaryUpdates 返回了重复术语: ${term}`);
    }
    if (!translation) {
      throw new Error(
        `glossaryUpdates[${index}].translation 必须是非空字符串`,
      );
    }

    seenGlossaryTerms.add(term);
    return { term, translation };
  });

  return {
    translations: expectedIds.map((id) => ({
      id,
      translation: translationMap.get(id)!,
    })),
    glossaryUpdates,
  };
}

function buildEmptyResponseSchema(): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      translations: {
        type: "array",
        maxItems: 0,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
      glossaryUpdates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
    },
    required: ["translations", "glossaryUpdates"],
  };
}

function resolveSlidingWindow(
  request: TranslationProcessorRequest,
  defaultSlidingWindow: SlidingWindowOptions | undefined,
): SlidingWindowFragment | undefined {
  if (!request.documentManager || !request.workItemRef) {
    return undefined;
  }

  const slidingWindow = request.slidingWindow ?? defaultSlidingWindow;
  if (!slidingWindow) {
    return undefined;
  }

  return request.documentManager.getSlidingWindowFragment(
    request.workItemRef.chapterId,
    request.workItemRef.fragmentIndex,
    slidingWindow,
  );
}

function buildOutputText(
  translations: ReadonlyArray<TranslationProcessorTranslation>,
  window: SlidingWindowFragment | undefined,
): string {
  if (!window) {
    return translations.map((entry) => entry.translation).join("\n");
  }

  return translations
    .slice(window.focusLineStart, window.focusLineEnd)
    .map((entry) => entry.translation)
    .join("\n");
}

function getResolvedModelName(
  clientResolver: TranslationProcessorClientResolver,
): string | undefined {
  if ("singleTurnRequest" in clientResolver) {
    return clientResolver.modelName;
  }

  return clientResolver.modelName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
