/**
 * 风格迁移翻译流程实现：分析 → 翻译 → 风格迁移。
 *
 * @module project/style-transfer-translation-processor
 */

import type { ResolvedGlossaryTerm } from "../../glossary/glossary.ts";
import {
  DefaultGlossaryUpdater,
  type GlossaryUpdateTranslationUnit,
  type GlossaryUpdater,
} from "../../glossary/updater.ts";
import type { ChatClient } from "../../llm/base.ts";
import { StyleLibraryService } from "../../style-library/service.ts";
import {
  buildJsonSchemaChatRequestOptions,
  mergeChatRequestOptions,
  withRequestMeta,
  withOutputValidator,
} from "../../llm/chat-request.ts";
import type {
  ChatRequestOptions,
  JsonObject,
  LlmRequestMetadata,
} from "../../llm/types.ts";
import { parseJsonResponseText } from "../../llm/utils.ts";
import { NOOP_LOGGER, type Logger } from "../logger.ts";
import { PromptManager, type PromptTranslationUnit } from "./prompt-manager.ts";
import type { PromptReferenceUnit } from "./prompt-manager.ts";
import type { TranslationWorkItem } from "../pipeline/pipeline.ts";
import type {
  TranslationProcessor,
  TranslationProcessorClientResolver,
  TranslationProcessorRequest,
  TranslationProcessorResult,
  TranslationProcessorTranslation,
} from "./translation-processor.ts";
import {
  repairTranslationOutputLines,
  type TranslationOutputRepairer,
} from "./translation-output-repair.ts";
import type { SlidingWindowOptions, SlidingWindowFragment } from "../types.ts";
import type { FragmentAuxDataContract } from "../types.ts";

export const STYLE_TRANSFER_STEP_NAMES = ["analyzer", "translator", "styleTransfer"] as const;

export type StyleTransferStepName = (typeof STYLE_TRANSFER_STEP_NAMES)[number];

type StyleTransferModification = {
  id: string;
  styleAnalysis: string;
  translation: string;
};

/**
 * 风格迁移处理器的辅助数据契约。
 * 提供分析阶段的输出文本，共下游流程（如独立校对）复用。
 */
export const STYLE_TRANSFER_AUX_DATA_CONTRACT: FragmentAuxDataContract = {
  provides: [
    {
      key: "styleTransfer.analysis.v1",
      description: "分析阶段输出的文本分析报告，包含场景、视角、风格和翻译难点分析",
    },
  ],
};

export type StyleTransferTranslationProcessorOptions = {
  promptManager?: PromptManager;
  defaultRequestOptions?: ChatRequestOptions;
  defaultSlidingWindow?: SlidingWindowOptions;
  logger?: Logger;
  processorName?: string;
  glossaryUpdater?: GlossaryUpdater;
  outputRepairer?: TranslationOutputRepairer;
  styleLibraryService?: StyleLibraryService;
  stepRequestOptions?: Partial<Record<StyleTransferStepName, ChatRequestOptions>>;
};

export class StyleTransferTranslationProcessor implements TranslationProcessor {
  private readonly logger: Logger;
  private readonly defaultRequestOptions?: ChatRequestOptions;
  private readonly defaultSlidingWindow?: SlidingWindowOptions;
  private readonly processorName?: string;
  private readonly glossaryUpdater: GlossaryUpdater;
  private readonly promptManager: PromptManager;
  private readonly stepRequestOptions?: Partial<Record<StyleTransferStepName, ChatRequestOptions>>;
  private readonly outputRepairer?: TranslationOutputRepairer;
  private readonly styleLibraryService?: StyleLibraryService;

  constructor(
    private readonly defaultClientResolver: TranslationProcessorClientResolver,
    private readonly stepResolvers: Partial<
      Record<StyleTransferStepName, TranslationProcessorClientResolver>
    >,
    options: StyleTransferTranslationProcessorOptions = {},
  ) {
    this.promptManager = options.promptManager ?? new PromptManager();
    this.defaultRequestOptions = options.defaultRequestOptions;
    this.defaultSlidingWindow = options.defaultSlidingWindow;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.processorName = options.processorName;
    this.stepRequestOptions = options.stepRequestOptions;
    this.outputRepairer = options.outputRepairer;
    this.styleLibraryService = options.styleLibraryService;
    this.glossaryUpdater =
      options.glossaryUpdater ??
      new DefaultGlossaryUpdater(this.resolveClient("styleTransfer"), {
        defaultRequestOptions: this.defaultRequestOptions,
        logger: this.logger,
        updaterName: this.processorName ? `${this.processorName}:glossary` : undefined,
      });
  }

  async processWorkItem(
    workItem: TranslationWorkItem,
    options: Pick<
      TranslationProcessorRequest,
      | "glossary"
      | "requestOptions"
      | "documentManager"
      | "slidingWindow"
      | "styleGuidanceMode"
      | "styleRequirementsText"
      | "styleLibraryName"
    > = {},
  ): Promise<TranslationProcessorResult> {
    return this.process({
      sourceText: workItem.inputText,
      contextView: workItem.contextView,
      glossary: options.glossary,
      requirements: workItem.requirements,
      styleGuidanceMode: options.styleGuidanceMode,
      styleRequirementsText: options.styleRequirementsText,
      styleLibraryName: options.styleLibraryName,
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
      return buildEmptyResult(window);
    }

    this.logger.info?.("开始执行风格迁移翻译", {
      processorName: this.processorName,
      sourceUnitCount: sourceUnits.length,
      windowEnabled: Boolean(window),
      chapterId: request.workItemRef?.chapterId,
      fragmentIndex: request.workItemRef?.fragmentIndex,
    });

    const requirements = [...(request.requirements ?? [])];
    const referenceContext = resolveDependencyPromptContext(request);
    const { referencePairs, referenceTranslations, plotSummaries } = referenceContext;
    const translatedGlossaryTerms = resolveTranslatedGlossaryTerms(request);
    const untranslatedGlossaryTerms = resolveUntranslatedGlossaryTerms(request);

    const analyzerPrompt = await this.promptManager.renderMultiStageAnalyzerPrompt({
      sourceUnits,
      referencePairs: toPromptReferenceUnits(referencePairs),
      plotSummaries,
      translatedGlossaryTerms,
      requirements,
    });
    this.logger.info?.("分析阶段", { processorName: this.processorName });
    const analysisText = await this.resolveClient("analyzer").singleTurnRequest(
      analyzerPrompt.userPrompt,
      withRequestMeta(
        withSystemPrompt(
          this.buildStepRequestOptions("analyzer", request.requestOptions),
          analyzerPrompt.systemPrompt,
        ),
        this.buildStepRequestMeta("analyzer", request),
      ),
    );

    const translatorPrompt = await this.promptManager.renderMultiStageTranslatorPrompt({
      sourceUnits,
      referenceTranslations,
      translatedGlossaryTerms,
      analysisText,
      requirements,
    });
    this.logger.info?.("初步翻译阶段", { processorName: this.processorName });
    const translatorClient = this.resolveClient("translator");
    const initialResponseText = await translatorClient.singleTurnRequest(
      translatorPrompt.userPrompt,
      withRequestMeta(
        withOutputValidator(
          buildJsonSchemaChatRequestOptions(
            this.buildStepRequestOptions("translator", request.requestOptions),
            {
              name: translatorPrompt.name,
              systemPrompt: translatorPrompt.systemPrompt,
              responseSchema: translatorPrompt.responseSchema,
            },
            translatorClient.supportsStructuredOutput,
          ),
          (candidateResponseText) => {
            parseTranslationResponse(
              candidateResponseText,
              sourceUnits.map((unit) => unit.id),
            );
          },
        ),
        this.buildStepRequestMeta("translator", request),
      ),
    );
    let currentTranslations = parseTranslationResponse(
      initialResponseText,
      sourceUnits.map((unit) => unit.id),
    );

    const glossaryUpdatePromise =
      request.glossary && untranslatedGlossaryTerms.length > 0
        ? this.glossaryUpdater.updateGlossary({
            glossary: request.glossary,
            untranslatedTerms: untranslatedGlossaryTerms,
            translationUnits: buildGlossaryUpdateUnits(sourceUnits, currentTranslations),
            requirements: request.requirements,
            requestOptions: withRequestMeta(
              request.requestOptions,
              this.buildGlossaryUpdateRequestMeta(request, untranslatedGlossaryTerms.length),
            ),
          })
        : Promise.resolve(undefined);

    const styleExamples = await this.resolveStyleExamples(request);

    const styleTransferPrompt = await this.promptManager.renderStyleTransferPrompt({
      sourceUnits,
      currentTranslations: toPromptUnits(currentTranslations),
      referenceTranslations,
      translatedGlossaryTerms,
      analysisText,
      requirements,
      styleRequirementsText:
        request.styleGuidanceMode === "requirements"
          ? request.styleRequirementsText
          : undefined,
      styleExamples,
    });
    this.logger.info?.("风格迁移阶段", { processorName: this.processorName });
    const styleTransferClient = this.resolveClient("styleTransfer");
    const styleTransferResponseText = await styleTransferClient.singleTurnRequest(
      styleTransferPrompt.userPrompt,
      withRequestMeta(
        withOutputValidator(
          buildJsonSchemaChatRequestOptions(
            this.buildStepRequestOptions("styleTransfer", request.requestOptions),
            {
              name: styleTransferPrompt.name,
              systemPrompt: styleTransferPrompt.systemPrompt,
              responseSchema: styleTransferPrompt.responseSchema,
            },
            styleTransferClient.supportsStructuredOutput,
          ),
          (candidateResponseText) => {
            parseStyleTransferResponse(
              candidateResponseText,
              sourceUnits.map((unit) => unit.id),
            );
          },
        ),
        this.buildStepRequestMeta("styleTransfer", request),
      ),
    );
    const styleTransferModifications = parseStyleTransferResponse(
      styleTransferResponseText,
      sourceUnits.map((unit) => unit.id),
    );
    currentTranslations = applyStyleTransferModifications(
      currentTranslations,
      styleTransferModifications,
    );

    const glossaryUpdateResult = await glossaryUpdatePromise;

    let outputText = buildOutputText(currentTranslations, window);
    const repairedOutput = await repairTranslationOutputLines({
      sourceUnits,
      translations: currentTranslations,
      outputText,
      window,
      outputRepairer: this.outputRepairer,
      logger: this.logger,
      processorName: this.processorName,
    });
    currentTranslations = repairedOutput.translations;
    outputText = repairedOutput.outputText;

    this.logger.info?.("风格迁移翻译完成", {
      processorName: this.processorName,
      translatedUnitCount: currentTranslations.length,
      glossaryUpdateCount: glossaryUpdateResult?.updates.length ?? 0,
    });

    return {
      outputText,
      translations: currentTranslations,
      glossaryUpdates: glossaryUpdateResult?.updates ?? [],
      glossaryUpdateResult,
      responseText: styleTransferResponseText,
      responseSchema: styleTransferPrompt.responseSchema,
      promptName: styleTransferPrompt.name,
      systemPrompt: styleTransferPrompt.systemPrompt,
      userPrompt: styleTransferPrompt.userPrompt,
      window,
      fragmentAuxDataPatch: { "styleTransfer.analysis.v1": analysisText },
    };
  }

  private resolveClient(step: StyleTransferStepName): ChatClient {
    const resolver = this.stepResolvers[step] ?? this.defaultClientResolver;
    if ("singleTurnRequest" in resolver) {
      return resolver;
    }

    return resolver.provider.getChatClient(resolver.modelName);
  }

  private buildStepRequestMeta(
    step: StyleTransferStepName,
    request: TranslationProcessorRequest,
  ): LlmRequestMetadata {
    return {
      label: `翻译-${getStyleTransferOperationLabel(step)}`,
      feature: "翻译",
      operation: getStyleTransferOperationLabel(step),
      component: "StyleTransferTranslationProcessor",
      workflow: "style-transfer",
      stage: step,
      context: buildProcessorRequestContext(this.processorName, request),
    };
  }

  private buildGlossaryUpdateRequestMeta(
    request: TranslationProcessorRequest,
    glossaryTermCount: number,
  ): LlmRequestMetadata {
    return {
      label: "术语更新",
      feature: "术语",
      operation: "术语更新",
      component: "StyleTransferTranslationProcessor",
      workflow: "style-transfer",
      context: {
        ...buildProcessorRequestContext(this.processorName, request),
        glossaryTermCount,
      },
    };
  }

  private buildStepRequestOptions(
    step: StyleTransferStepName,
    requestOptions: ChatRequestOptions | undefined,
  ): ChatRequestOptions | undefined {
    return mergeChatRequestOptions(
      mergeChatRequestOptions(this.defaultRequestOptions, this.stepRequestOptions?.[step]),
      requestOptions,
    );
  }

  private async resolveStyleExamples(
    request: TranslationProcessorRequest,
  ): Promise<string[]> {
    if (request.styleGuidanceMode !== "examples") {
      return [];
    }

    const libraryName = request.styleLibraryName?.trim();
    if (!libraryName || !this.styleLibraryService) {
      return [];
    }

    try {
      const queryResult = await this.styleLibraryService.queryLibrary(libraryName, request.sourceText, {
        topKPerChunk: "source-ratio",
      });
      const targetExampleCount = queryResult.chunks.length;
      if (targetExampleCount === 0) {
        return [];
      }

      const seenExamples = new Set<string>();
      const examples: string[] = [];
      for (const match of queryResult.matches) {
        const example = match.document?.trim();
        if (!example || seenExamples.has(example)) {
          continue;
        }

        seenExamples.add(example);
        examples.push(example);
        if (examples.length >= targetExampleCount) {
          break;
        }
      }

      return examples;
    } catch (error) {
      this.logger.warn?.("风格库检索失败，已跳过风格示例注入", {
        processorName: this.processorName,
        styleLibraryName: libraryName,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}

function toPromptUnits(
  translations: ReadonlyArray<TranslationProcessorTranslation>,
): PromptTranslationUnit[] {
  return translations.map((translation) => ({
    id: translation.id,
    text: translation.translation,
  }));
}

function toPromptReferenceUnits(
  references: ReadonlyArray<{ sourceText: string; translatedText: string }>,
): PromptReferenceUnit[] {
  return references.map((reference, index) => ({
    id: (index + 1).toString(),
    sourceText: reference.sourceText,
    translation: reference.translatedText,
  }));
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

function parseTranslationResponse(
  responseText: string,
  expectedIds: ReadonlyArray<string>,
): TranslationProcessorTranslation[] {
  let parsed: unknown;
  try {
    parsed = parseJsonResponseText(responseText);
  } catch (error) {
    throw new Error(
      `风格迁移翻译结果不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("风格迁移翻译结果必须是 JSON 对象");
  }

  const translationValues = parsed.translations;
  if (!Array.isArray(translationValues)) {
    throw new Error("风格迁移翻译结果缺少 translations 数组");
  }

  const expectedIdSet = new Set(expectedIds);
  const seenIds = new Set<string>();
  const translationMap = new Map<string, string>();

  const translations = translationValues.map<TranslationProcessorTranslation>((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`translations[${index}] 必须是对象`);
    }

    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const translation = typeof entry.translation === "string" ? entry.translation.trim() : "";

    if (!id || !expectedIdSet.has(id)) {
      throw new Error(`translations[${index}].id 无效或未请求: ${id}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`translations[${index}].id 重复: ${id}`);
    }
    if (!translation) {
      throw new Error(`translations[${index}].translation 不能为空`);
    }

    seenIds.add(id);
    translationMap.set(id, translation);
    return { id, translation };
  });

  const missingIds = expectedIds.filter((id) => !translationMap.has(id));
  if (missingIds.length > 0) {
    throw new Error(`风格迁移翻译结果缺少 id: ${missingIds.join(", ")}`);
  }

  return translations;
}

function parseStyleTransferResponse(
  responseText: string,
  expectedIds: ReadonlyArray<string>,
): StyleTransferModification[] {
  let parsed: unknown;
  try {
    parsed = parseJsonResponseText(responseText);
  } catch (error) {
    throw new Error(
      `风格迁移结果不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("风格迁移结果必须是 JSON 对象");
  }

  const modificationValues = parsed.modifications;
  if (!Array.isArray(modificationValues)) {
    throw new Error("风格迁移结果缺少 modifications 数组");
  }

  const expectedIdSet = new Set(expectedIds);
  const seenIds = new Set<string>();

  return modificationValues.map<StyleTransferModification>((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`modifications[${index}] 必须是对象`);
    }

    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const styleAnalysis =
      typeof entry.styleAnalysis === "string" ? entry.styleAnalysis.trim() : "";
    const translation = typeof entry.translation === "string" ? entry.translation.trim() : "";

    if (!id || !expectedIdSet.has(id)) {
      throw new Error(`modifications[${index}].id 无效或未请求: ${id}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`modifications[${index}].id 重复: ${id}`);
    }
    if (!styleAnalysis) {
      throw new Error(`modifications[${index}].styleAnalysis 不能为空`);
    }
    if (!translation) {
      throw new Error(`modifications[${index}].translation 不能为空`);
    }

    seenIds.add(id);
    return { id, styleAnalysis, translation };
  });
}

function applyStyleTransferModifications(
  translations: ReadonlyArray<TranslationProcessorTranslation>,
  modifications: ReadonlyArray<StyleTransferModification>,
): TranslationProcessorTranslation[] {
  if (modifications.length === 0) {
    return [...translations];
  }

  const modificationMap = new Map(
    modifications.map((modification) => [modification.id, modification.translation]),
  );

  return translations.map((translation) => ({
    id: translation.id,
    translation: modificationMap.get(translation.id) ?? translation.translation,
  }));
}

function buildGlossaryUpdateUnits(
  sourceUnits: ReadonlyArray<PromptTranslationUnit>,
  translations: ReadonlyArray<TranslationProcessorTranslation>,
): GlossaryUpdateTranslationUnit[] {
  return sourceUnits.map((unit, index) => ({
    id: unit.id,
    sourceText: unit.text,
    translatedText: translations[index]?.translation ?? "",
  }));
}

function getStyleTransferOperationLabel(step: StyleTransferStepName): string {
  switch (step) {
    case "analyzer":
      return "分析";
    case "translator":
      return "初步翻译";
    case "styleTransfer":
      return "风格迁移";
  }
}

function buildProcessorRequestContext(
  processorName: string | undefined,
  request: TranslationProcessorRequest,
): JsonObject {
  const context: JsonObject = {};
  if (processorName) {
    context.processorName = processorName;
  }

  if (request.workItemRef) {
    context.chapterId = request.workItemRef.chapterId;
    context.fragmentIndex = request.workItemRef.fragmentIndex;
    if (request.workItemRef.stepId) {
      context.stepId = request.workItemRef.stepId;
    }
  }

  context.sourceTextLength = request.sourceText.length;
  context.sourceUnitCount = splitSourceTextIntoUnits(request.sourceText).length;

  return context;
}

function buildOutputText(
  translations: ReadonlyArray<TranslationProcessorTranslation>,
  window: SlidingWindowFragment | undefined,
): string {
  if (!window) {
    return translations.map((t) => t.translation).join("\n");
  }

  return translations
    .slice(window.focusLineStart, window.focusLineEnd)
    .map((t) => t.translation)
    .join("\n");
}

function buildEmptyResult(window: SlidingWindowFragment | undefined): TranslationProcessorResult {
  return {
    outputText: "",
    translations: [],
    glossaryUpdates: [],
    responseText: JSON.stringify({ translations: [] }),
    responseSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        translations: { type: "array", maxItems: 0, items: { type: "object", properties: {} } },
      },
      required: ["translations"],
    },
    promptName: "style_transfer_translation",
    systemPrompt: "",
    userPrompt: "",
    window,
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

function resolveDependencyPromptContext(request: TranslationProcessorRequest) {
  return (
    request.contextView?.getDependencyPromptContext() ?? {
      referencePairs: [],
      referenceSourceTexts: [],
      referenceTranslations: [],
      plotSummaries: [],
    }
  );
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

function withSystemPrompt(
  base: ChatRequestOptions | undefined,
  systemPrompt: string,
): ChatRequestOptions {
  return {
    ...base,
    requestConfig: {
      ...(base?.requestConfig ?? {}),
      systemPrompt,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}