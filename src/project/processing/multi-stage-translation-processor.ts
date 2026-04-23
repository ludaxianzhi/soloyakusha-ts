/**
 * 多步骤文学翻译流程实现：分析 → 翻译 → 润色 → [编辑 + 校对 → 修改] × N 轮评审。
 *
 * ## 流程概览
 *
 * **大步骤一**（顺序执行，Pipeline 中不同文本块可并行）：
 * 1. LLM1（分析器）：分析场景、视角、风格和翻译难点。注入：参考原文 + 参考译文 + 原文 + 术语表
 * 2. LLM2（翻译器）：初步翻译。注入：参考译文 + 原文 + 术语表 + LLM1 分析
 * 3. LLM3（润色师）：润色译文。注入：参考译文 + LLM2 译文 + 术语表（仅译文列）
 * 4. 术语表更新：调用术语表模块更新未翻译术语。
 *
 * **大步骤二**（重复 `reviewIterations` 次）：
 * 1. LLM4（中文编辑）[与 LLM5 并行]：指出表达问题及润色建议。注入：参考译文 + 当前译文 + 术语表（仅译文列）
 * 2. LLM5（校对专家）[与 LLM4 并行]：指出理解或细节错误（尊重文学性和本地化改造）。注入：LLM1 分析 + 参考原文 + 原文 + 当前译文 + 术语表
 * 3. LLM6（修改器）：根据 LLM4 + LLM5 建议修改译文。注入：参考原文 + 参考译文 + 原文 + 当前译文 + 术语表
 *
 * @module project/multi-stage-translation-processor
 */

import type { ResolvedGlossaryTerm } from "../../glossary/glossary.ts";
import {
  DefaultGlossaryUpdater,
  type GlossaryUpdateTranslationUnit,
  type GlossaryUpdater,
} from "../../glossary/updater.ts";
import type { ChatClient } from "../../llm/base.ts";
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
import type { TranslationWorkItem } from "../pipeline/pipeline.ts";
import type {
  TranslationProcessor,
  TranslationProcessorClientResolver,
  TranslationProcessorRequest,
  TranslationProcessorResult,
  TranslationProcessorTranslation,
} from "./translation-processor.ts";
import { TranslationDocumentManager } from "../document/translation-document-manager.ts";
import {
  repairTranslationOutputLines,
  type TranslationOutputRepairer,
} from "./translation-output-repair.ts";
import type { SlidingWindowOptions, SlidingWindowFragment } from "../types.ts";

/** multi-stage 工作流各步骤的解析器标识。 */
export const MULTI_STAGE_STEP_NAMES = [
  "analyzer",
  "translator",
  "polisher",
  "editor",
  "proofreader",
  "reviser",
] as const;

export type MultiStageStepName = (typeof MULTI_STAGE_STEP_NAMES)[number];

export type MultiStageTranslationProcessorOptions = {
  promptManager?: PromptManager;
  defaultRequestOptions?: ChatRequestOptions;
  defaultSlidingWindow?: SlidingWindowOptions;
  logger?: Logger;
  processorName?: string;
  glossaryUpdater?: GlossaryUpdater;
  outputRepairer?: TranslationOutputRepairer;
  stepRequestOptions?: Partial<Record<MultiStageStepName, ChatRequestOptions>>;
  /** 评审迭代次数（大步骤二的重复次数）。默认值为 2。 */
  reviewIterations?: number;
};

export class MultiStageTranslationProcessor implements TranslationProcessor {
  private readonly logger: Logger;
  private readonly defaultRequestOptions?: ChatRequestOptions;
  private readonly defaultSlidingWindow?: SlidingWindowOptions;
  private readonly processorName?: string;
  private readonly glossaryUpdater: GlossaryUpdater;
  private readonly promptManager: PromptManager;
  private readonly stepRequestOptions?: Partial<Record<MultiStageStepName, ChatRequestOptions>>;
  private readonly reviewIterations: number;
  private readonly outputRepairer?: TranslationOutputRepairer;

  /**
   * 各步骤的 LLM 解析器。若未为某步骤显式提供，则回退至 defaultClientResolver。
   * 顺序：analyzer, translator, polisher, editor, proofreader, reviser
   */
  constructor(
    private readonly defaultClientResolver: TranslationProcessorClientResolver,
    private readonly stepResolvers: Partial<
      Record<MultiStageStepName, TranslationProcessorClientResolver>
    >,
    options: MultiStageTranslationProcessorOptions = {},
  ) {
    this.promptManager = options.promptManager ?? new PromptManager();
    this.defaultRequestOptions = options.defaultRequestOptions;
    this.defaultSlidingWindow = options.defaultSlidingWindow;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.processorName = options.processorName;
    this.stepRequestOptions = options.stepRequestOptions;
    this.reviewIterations = options.reviewIterations ?? 2;
    this.outputRepairer = options.outputRepairer;
    this.glossaryUpdater =
      options.glossaryUpdater ??
      new DefaultGlossaryUpdater(this.resolveClient("reviser"), {
        defaultRequestOptions: this.defaultRequestOptions,
        logger: this.logger,
        updaterName: this.processorName ? `${this.processorName}:glossary` : undefined,
      });
  }

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
      return buildEmptyResult(window);
    }

    this.logger.info?.("开始执行多步骤翻译", {
      processorName: this.processorName,
      sourceUnitCount: sourceUnits.length,
      reviewIterations: this.reviewIterations,
      windowEnabled: Boolean(window),
      chapterId: request.workItemRef?.chapterId,
      fragmentIndex: request.workItemRef?.fragmentIndex,
    });

    const requirements = [...(request.requirements ?? [])];
    const referenceContext = resolveDependencyPromptContext(request);
    const { referenceSourceTexts, referenceTranslations, plotSummaries } = referenceContext;
    const translatedGlossaryTerms = resolveTranslatedGlossaryTerms(request);
    const untranslatedGlossaryTerms = resolveUntranslatedGlossaryTerms(request);

    // ── 大步骤一 ──────────────────────────────────────────────────────────

    // Step 1: LLM1 分析
    const analyzerPrompt = await this.promptManager.renderMultiStageAnalyzerPrompt({
      sourceUnits,
      referenceSourceTexts,
      referenceTranslations,
      plotSummaries,
      translatedGlossaryTerms,
      requirements,
    });
    this.logger.info?.("LLM1 分析阶段", { processorName: this.processorName });
    const analyzerClient = this.resolveClient("analyzer");
    const analysisText = await analyzerClient.singleTurnRequest(
      analyzerPrompt.userPrompt,
      withRequestMeta(
        withSystemPrompt(
          this.buildStepRequestOptions("analyzer", request.requestOptions),
          analyzerPrompt.systemPrompt,
        ),
        this.buildStepRequestMeta("analyzer", request),
      ),
    );

    // Step 2: LLM2 初步翻译
    const translatorPrompt = await this.promptManager.renderMultiStageTranslatorPrompt({
      sourceUnits,
      referenceTranslations,
      translatedGlossaryTerms,
      analysisText,
      requirements,
    });
    this.logger.info?.("LLM2 翻译阶段", { processorName: this.processorName });
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
      sourceUnits.map((u) => u.id),
    );

    // Step 3: LLM3 润色
    const polisherPrompt = await this.promptManager.renderMultiStagePolisherPrompt({
      sourceUnits,
      currentTranslations: toPromptUnits(currentTranslations),
      referenceTranslations,
      translatedGlossaryTerms,
      requirements,
    });
    this.logger.info?.("LLM3 润色阶段", { processorName: this.processorName });
    const polisherClient = this.resolveClient("polisher");
    const polishedResponseText = await polisherClient.singleTurnRequest(
      polisherPrompt.userPrompt,
      withRequestMeta(
        withOutputValidator(
          buildJsonSchemaChatRequestOptions(
            this.buildStepRequestOptions("polisher", request.requestOptions),
            {
              name: polisherPrompt.name,
              systemPrompt: polisherPrompt.systemPrompt,
              responseSchema: polisherPrompt.responseSchema,
            },
            polisherClient.supportsStructuredOutput,
          ),
          (candidateResponseText) => {
            parseTranslationResponse(
              candidateResponseText,
              sourceUnits.map((unit) => unit.id),
            );
          },
        ),
        this.buildStepRequestMeta("polisher", request),
      ),
    );
    currentTranslations = parseTranslationResponse(
      polishedResponseText,
      sourceUnits.map((u) => u.id),
    );

    // Step 4: 术语表更新（在评审阶段进行时异步执行）
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

    // ── 大步骤二（重复 reviewIterations 次）────────────────────────────────

    let lastEditorFeedback = "";
    let lastProofreaderFeedback = "";
    let finalPromptName = polisherPrompt.name;
    let finalResponseSchema = polisherPrompt.responseSchema;
    let lastReviserSystemPrompt = "";
    let lastReviserUserPrompt = "";
    let lastReviserResponseText = "";

    for (let round = 0; round < this.reviewIterations; round++) {
      this.logger.info?.(`大步骤二 第 ${round + 1}/${this.reviewIterations} 轮`, {
        processorName: this.processorName,
      });

      const translationsAtRoundStart = currentTranslations;

      // LLM4 + LLM5 并行
      const editorPrompt = await this.promptManager.renderMultiStageEditorPrompt({
        currentTranslations: toPromptUnits(currentTranslations),
        referenceTranslations,
        translatedGlossaryTerms,
        requirements,
      });

      const proofreaderPrompt = await this.promptManager.renderMultiStageProofreaderPrompt({
        sourceUnits,
        currentTranslations: toPromptUnits(currentTranslations),
        referenceSourceTexts,
        plotSummaries,
        translatedGlossaryTerms,
        analysisText,
        requirements,
      });

      const [editorFeedback, proofreaderFeedback] = await Promise.all([
        this.resolveClient("editor").singleTurnRequest(
          editorPrompt.userPrompt,
          withRequestMeta(
            withSystemPrompt(
              this.buildStepRequestOptions("editor", request.requestOptions),
              editorPrompt.systemPrompt,
            ),
            this.buildStepRequestMeta("editor", request, round),
          ),
        ),
        this.resolveClient("proofreader").singleTurnRequest(
          proofreaderPrompt.userPrompt,
          withRequestMeta(
            withSystemPrompt(
              this.buildStepRequestOptions("proofreader", request.requestOptions),
              proofreaderPrompt.systemPrompt,
            ),
            this.buildStepRequestMeta("proofreader", request, round),
          ),
        ),
      ]);

      lastEditorFeedback = editorFeedback;
      lastProofreaderFeedback = proofreaderFeedback;

      // LLM6 修改
      const reviserPrompt = await this.promptManager.renderMultiStageReviserPrompt({
        sourceUnits,
        currentTranslations: toPromptUnits(translationsAtRoundStart),
        referenceSourceTexts,
        referenceTranslations,
        plotSummaries,
        translatedGlossaryTerms,
        editorFeedback,
        proofreaderFeedback,
        requirements,
      });

      finalPromptName = reviserPrompt.name;
      finalResponseSchema = reviserPrompt.responseSchema;
      lastReviserSystemPrompt = reviserPrompt.systemPrompt;
      lastReviserUserPrompt = reviserPrompt.userPrompt;

      const reviserClient = this.resolveClient("reviser");
      const reviserResponseText = await reviserClient.singleTurnRequest(
        reviserPrompt.userPrompt,
        withRequestMeta(
          withOutputValidator(
            buildJsonSchemaChatRequestOptions(
              this.buildStepRequestOptions("reviser", request.requestOptions),
              {
                name: reviserPrompt.name,
                systemPrompt: reviserPrompt.systemPrompt,
                responseSchema: reviserPrompt.responseSchema,
              },
              reviserClient.supportsStructuredOutput,
            ),
            (candidateResponseText) => {
              parseTranslationResponse(
                candidateResponseText,
                sourceUnits.map((unit) => unit.id),
              );
            },
          ),
          this.buildStepRequestMeta("reviser", request, round),
        ),
      );

      lastReviserResponseText = reviserResponseText;
      currentTranslations = parseTranslationResponse(
        reviserResponseText,
        sourceUnits.map((u) => u.id),
      );
    }

    // 等待术语表更新完成
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

    this.logger.info?.("多步骤翻译完成", {
      processorName: this.processorName,
      translatedUnitCount: currentTranslations.length,
      glossaryUpdateCount: glossaryUpdateResult?.updates.length ?? 0,
      reviewIterations: this.reviewIterations,
    });

    return {
      outputText,
      translations: currentTranslations,
      glossaryUpdates: glossaryUpdateResult?.updates ?? [],
      glossaryUpdateResult,
      responseText: lastReviserResponseText || polishedResponseText,
      responseSchema: finalResponseSchema,
      promptName: finalPromptName,
      systemPrompt: lastReviserSystemPrompt || polisherPrompt.systemPrompt,
      userPrompt: lastReviserUserPrompt || polisherPrompt.userPrompt,
      window,
    };
  }

  private resolveClient(step: MultiStageStepName): ChatClient {
    const resolver = this.stepResolvers[step] ?? this.defaultClientResolver;
    if ("singleTurnRequest" in resolver) {
      return resolver;
    }

    return resolver.provider.getChatClient(resolver.modelName);
  }

  private buildStepRequestMeta(
    step: MultiStageStepName,
    request: TranslationProcessorRequest,
    round?: number,
  ): LlmRequestMetadata {
    const operation = getMultiStageOperationLabel(step);
    const context = buildProcessorRequestContext(this.processorName, request);
    if (round !== undefined) {
      context.reviewRound = round + 1;
    }

    return {
      label: `翻译-${operation}`,
      feature: "翻译",
      operation,
      component: "MultiStageTranslationProcessor",
      workflow: "multi-stage",
      stage: step,
      context,
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
      component: "MultiStageTranslationProcessor",
      workflow: "multi-stage",
      context: {
        ...buildProcessorRequestContext(this.processorName, request),
        glossaryTermCount,
      },
    };
  }

  private buildStepRequestOptions(
    step: MultiStageStepName,
    requestOptions: ChatRequestOptions | undefined,
  ): ChatRequestOptions | undefined {
    return mergeChatRequestOptions(
      mergeChatRequestOptions(this.defaultRequestOptions, this.stepRequestOptions?.[step]),
      requestOptions,
    );
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
      `多步骤翻译结果不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("多步骤翻译结果必须是 JSON 对象");
  }

  const translationValues = parsed.translations;
  if (!Array.isArray(translationValues)) {
    throw new Error("多步骤翻译结果缺少 translations 数组");
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
    throw new Error(`多步骤翻译结果缺少 id: ${missingIds.join(", ")}`);
  }

  return translations;
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

function getMultiStageOperationLabel(step: MultiStageStepName): string {
  switch (step) {
    case "analyzer":
      return "分析";
    case "translator":
      return "初步翻译";
    case "polisher":
      return "润色";
    case "editor":
      return "编辑建议";
    case "proofreader":
      return "校对建议";
    case "reviser":
      return "最终翻译";
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
    promptName: "multi_stage_revision",
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
