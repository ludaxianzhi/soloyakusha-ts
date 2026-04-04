/**
 * 默认翻译流程实现：先生成译文，再单独触发术语表更新。
 *
 * @module project/default-translation-processor
 */

import {
  DefaultGlossaryUpdater,
  type GlossaryUpdateTranslationUnit,
  type GlossaryUpdater,
} from "../glossary/updater.ts";
import type { ChatClient } from "../llm/base.ts";
import { buildJsonSchemaChatRequestOptions, mergeChatRequestOptions } from "../llm/chat-request.ts";
import type { ChatRequestOptions, JsonObject } from "../llm/types.ts";
import { NOOP_LOGGER, type Logger } from "./logger.ts";
import { PromptManager, type PromptTranslationUnit } from "./prompt-manager.ts";
import type { TranslationWorkItem } from "./pipeline.ts";
import type {
  TranslationProcessor,
  TranslationProcessorClientResolver,
  TranslationProcessorRequest,
  TranslationProcessorResult,
  TranslationProcessorTranslation,
} from "./translation-processor.ts";
import { TranslationDocumentManager } from "./translation-document-manager.ts";
import {
  repairTranslationOutputLines,
  type TranslationOutputRepairer,
} from "./translation-output-repair.ts";
import {
  buildSourceUnitsFromLines,
  renderSimpleTranslationPrompt,
  resolveTranslatedGlossaryTerms,
  resolveUntranslatedGlossaryTerms,
  splitSourceTextIntoUnits,
} from "./translation-prompt-context.ts";
import type { SlidingWindowOptions, SlidingWindowFragment } from "./types.ts";

export class DefaultTranslationProcessor implements TranslationProcessor {
  private readonly logger: Logger;
  private readonly defaultRequestOptions?: ChatRequestOptions;
  private readonly defaultSlidingWindow?: SlidingWindowOptions;
  private readonly processorName?: string;
  private readonly glossaryUpdater: GlossaryUpdater;
  private readonly promptManager: PromptManager;

  constructor(
    private readonly clientResolver: TranslationProcessorClientResolver,
    options: {
      promptManager?: PromptManager;
      defaultRequestOptions?: ChatRequestOptions;
      defaultSlidingWindow?: SlidingWindowOptions;
      logger?: Logger;
      processorName?: string;
      glossaryUpdater?: GlossaryUpdater;
      outputRepairer?: TranslationOutputRepairer;
    } = {},
  ) {
    this.promptManager = options.promptManager ?? new PromptManager();
    this.defaultRequestOptions = options.defaultRequestOptions;
    this.defaultSlidingWindow = options.defaultSlidingWindow;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.processorName = options.processorName;
    this.glossaryUpdater =
      options.glossaryUpdater ??
      new DefaultGlossaryUpdater(this.clientResolver, {
        defaultRequestOptions: this.defaultRequestOptions,
        logger: this.logger,
        updaterName: this.processorName ? `${this.processorName}:glossary` : undefined,
      });
    this.outputRepairer = options.outputRepairer;
  }

  private readonly outputRepairer?: TranslationOutputRepairer;

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
        responseText: JSON.stringify({ translations: [] }),
        responseSchema: buildEmptyResponseSchema(),
        promptName: "translation_pipeline_result",
        systemPrompt: "",
        userPrompt: "",
        window,
      };
    }

    this.logger.info?.("开始执行翻译处理", {
      processorName: this.processorName,
      modelName: getResolvedModelName(this.clientResolver),
      sourceUnitCount: sourceUnits.length,
      windowEnabled: Boolean(window),
      chapterId: request.workItemRef?.chapterId,
      fragmentIndex: request.workItemRef?.fragmentIndex,
      stepId: request.workItemRef?.stepId,
    });

    const translatedGlossaryTerms = resolveTranslatedGlossaryTerms(request);
    const untranslatedGlossaryTerms = resolveUntranslatedGlossaryTerms(request);
    const renderedPrompt = await renderSimpleTranslationPrompt({
      sourceText: request.sourceText,
      sourceUnits,
      contextView: request.contextView,
      glossary: request.glossary,
      requirements: request.requirements,
      promptManager: this.promptManager,
    });
    const responseText = await this.resolveChatClient().singleTurnRequest(
      renderedPrompt.userPrompt,
      buildJsonSchemaChatRequestOptions(
        mergeChatRequestOptions(this.defaultRequestOptions, request.requestOptions),
        renderedPrompt,
      ),
    );
    let translations = parseTranslationResponse(
      responseText,
      sourceUnits.map((unit) => unit.id),
    );
    let outputText = buildOutputText(translations, window);
    const repairedOutput = await repairTranslationOutputLines({
      sourceUnits,
      translations,
      outputText,
      window,
      outputRepairer: this.outputRepairer,
      logger: this.logger,
      processorName: this.processorName,
    });
    translations = repairedOutput.translations;
    outputText = repairedOutput.outputText;

    let glossaryUpdates: TranslationProcessorResult["glossaryUpdates"] = [];
    let glossaryUpdateResult = undefined;
    if (request.glossary && untranslatedGlossaryTerms.length > 0) {
      glossaryUpdateResult = await this.glossaryUpdater.updateGlossary({
        glossary: request.glossary,
        untranslatedTerms: untranslatedGlossaryTerms,
        translationUnits: buildGlossaryUpdateTranslationUnits(sourceUnits, translations),
        requirements: request.requirements,
        requestOptions: request.requestOptions,
      });
      glossaryUpdates = glossaryUpdateResult.updates;
    }

    this.logger.info?.("翻译处理完成", {
      processorName: this.processorName,
      modelName: getResolvedModelName(this.clientResolver),
      translatedUnitCount: translations.length,
      glossaryUpdateCount: glossaryUpdates.length,
      outputLineCount: outputText.length === 0 ? 0 : outputText.split("\n").length,
      windowEnabled: Boolean(window),
      chapterId: request.workItemRef?.chapterId,
      fragmentIndex: request.workItemRef?.fragmentIndex,
      stepId: request.workItemRef?.stepId,
    });

    return {
      outputText,
      translations,
      glossaryUpdates,
      glossaryUpdateResult,
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

function parseTranslationResponse(
  responseText: string,
  expectedIds: ReadonlyArray<string>,
): TranslationProcessorTranslation[] {
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

  return translations;
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
    },
    required: ["translations"],
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

function buildGlossaryUpdateTranslationUnits(
  sourceUnits: ReadonlyArray<PromptTranslationUnit>,
  translations: ReadonlyArray<TranslationProcessorTranslation>,
): GlossaryUpdateTranslationUnit[] {
  return sourceUnits.map((unit, index) => ({
    id: unit.id,
    sourceText: unit.text,
    translatedText: translations[index]?.translation ?? "",
  }));
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
