import type { ResolvedGlossaryTerm } from "../../glossary/glossary.ts";
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
import type { TranslationContextView } from "../context/context-view.ts";
import type { TranslationDocumentManager } from "../document/translation-document-manager.ts";
import {
  repairTranslationOutputLines,
  type TranslationOutputRepairer,
} from "./translation-output-repair.ts";
import { normalizeInlineLineBreaks } from "./translation-processor.ts";
import type {
  TranslationProcessorClientResolver,
  TranslationProcessorResult,
  TranslationProcessorTranslation,
} from "./translation-processor.ts";
import type { ChatClient } from "../../llm/base.ts";
import { AbortError } from "../../llm/utils.ts";
import type { StoryTopology } from "../context/story-topology.ts";
import type { SlidingWindowFragment, SlidingWindowOptions, FragmentAuxData, FragmentAuxDataContract } from "../types.ts";
import { applyPreProcessingToLines } from "./translation-prompt-context.ts";

export const PROOFREAD_STEP_NAMES = ["editor", "proofreader"] as const;

export type ProofreadStepName = (typeof PROOFREAD_STEP_NAMES)[number];

/**
 * 独立校对处理器的辅助数据契约。
 * 消费风格迁移流程分析阶段产出的分析报告，注入校对者提示词以提升校对质量。
 */
export const PROOFREAD_AUX_DATA_CONTRACT: FragmentAuxDataContract = {
  consumes: [
    {
      key: "styleTransfer.analysis.v1",
      description: "风格迁移分析结果，供校对者参考",
      required: false,
    },
  ],
};

type ProofreadModification = {
  id: string;
  reason: string;
  translation: string;
};

export type ProofreadProcessorRequest = {
  sourceText: string;
  currentTranslationText: string;
  contextView?: TranslationContextView;
  requirements?: ReadonlyArray<string>;
  editorRequirementsText?: string;
  glossary?: {
    getTranslatedTermsForText(text: string): ResolvedGlossaryTerm[];
  };
  requestOptions?: ChatRequestOptions;
  documentManager?: TranslationDocumentManager;
  slidingWindow?: SlidingWindowOptions;
  disableSlidingWindow?: boolean;
  workItemRef?: {
    chapterId: number;
    fragmentIndex: number;
    stepId?: string;
  };
  workItemRefs?: Array<{
    chapterId: number;
    fragmentIndex: number;
    stepId?: string;
  }>;
  orderedFragments?: Array<{
    chapterId: number;
    fragmentIndex: number;
  }>;
  storyTopology?: StoryTopology;
  dependencyTrackingSourceRevision?: number;
  /** 该文本块当前已持久化的辅助数据，供消费方按需读取。 */
  fragmentAuxData?: FragmentAuxData;
  /** 原文预处理步骤配置，用于对滑动窗口中的原文行执行预处理。 */
  preProcessors?: ReadonlyArray<{ id: string; params?: Record<string, unknown> }>;
  /** 用于在请求进行中取消 LLM 调用。 */
  signal?: AbortSignal;
};

export interface ProofreadProcessor {
  process(request: ProofreadProcessorRequest): Promise<TranslationProcessorResult>;
}

export type MultiStageProofreadProcessorOptions = {
  promptManager?: PromptManager;
  defaultRequestOptions?: ChatRequestOptions;
  defaultSlidingWindow?: SlidingWindowOptions;
  logger?: Logger;
  processorName?: string;
  outputRepairer?: TranslationOutputRepairer;
  stepRequestOptions?: Partial<Record<ProofreadStepName, ChatRequestOptions>>;
  reviewIterations?: number;
  /** 是否在 response schema 中包含 reason 字段；默认 true。 */
  includeReason?: boolean;
  /** 各步骤独立的 includeReason 覆盖，key 为步骤名（editor/proofreader）。 */
  stepIncludeReason?: Partial<Record<ProofreadStepName, boolean>>;
};

export type ConsistencyCheckProofreadProcessorOptions = {
  promptManager?: PromptManager;
  defaultRequestOptions?: ChatRequestOptions;
  defaultSlidingWindow?: SlidingWindowOptions;
  logger?: Logger;
  processorName?: string;
  outputRepairer?: TranslationOutputRepairer;
  maxSourceChars?: number;
  maxAdditionalRelatedContexts?: number;
  randomContextCount?: number;
  /** 是否在 response schema 中包含 reason 字段；默认 true。 */
  includeReason?: boolean;
};

export type SingleStepProofreadProcessorOptions = {
  promptManager?: PromptManager;
  defaultRequestOptions?: ChatRequestOptions;
  defaultSlidingWindow?: SlidingWindowOptions;
  logger?: Logger;
  processorName?: string;
  outputRepairer?: TranslationOutputRepairer;
  step: ProofreadStepName;
  /** 是否在 response schema 中包含 reason 字段；默认 true。 */
  includeReason?: boolean;
  /** 是否注入待编辑文本的原文；仅 editor 步骤有效，默认 true（保持原行为）。 */
  includeSourceText?: boolean;
};

export class MultiStageProofreadProcessor implements ProofreadProcessor {
  private readonly logger: Logger;
  private readonly defaultRequestOptions?: ChatRequestOptions;
  private readonly defaultSlidingWindow?: SlidingWindowOptions;
  private readonly processorName?: string;
  private readonly promptManager: PromptManager;
  private readonly stepRequestOptions?: Partial<Record<ProofreadStepName, ChatRequestOptions>>;
  private readonly reviewIterations: number;
  private readonly outputRepairer?: TranslationOutputRepairer;
  private readonly includeReason: boolean;
  private readonly stepIncludeReason?: Partial<Record<ProofreadStepName, boolean>>;

  constructor(
    private readonly defaultClientResolver: TranslationProcessorClientResolver,
    private readonly stepResolvers: Partial<
      Record<ProofreadStepName, TranslationProcessorClientResolver>
    >,
    options: MultiStageProofreadProcessorOptions = {},
  ) {
    this.promptManager = options.promptManager ?? new PromptManager();
    this.defaultRequestOptions = options.defaultRequestOptions;
    this.defaultSlidingWindow = options.defaultSlidingWindow;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.processorName = options.processorName;
    this.stepRequestOptions = options.stepRequestOptions;
    this.reviewIterations = options.reviewIterations ?? 1;
    this.outputRepairer = options.outputRepairer;
    this.includeReason = options.includeReason ?? true;
    this.stepIncludeReason = options.stepIncludeReason;
  }

  private resolveIncludeReason(step: ProofreadStepName): boolean {
    return this.stepIncludeReason?.[step] ?? this.includeReason;
  }

  async process(request: ProofreadProcessorRequest): Promise<TranslationProcessorResult> {
    const window = resolveSlidingWindow(request, this.defaultSlidingWindow);
    const sourceUnits = window
      ? (() => {
          const preprocessed = applyPreProcessingToLines(window.source.lines, request.preProcessors);
          this.logger.info?.("[PreProcess] MultiStageProofreadProcessor: 滑动窗口+预处理", {
            windowLines: window.source.lines.length,
            preprocessedLines: preprocessed.length,
            steps: request.preProcessors?.length ?? 0,
          });
          return buildSourceUnitsFromLines(preprocessed);
        })()
      : (() => {
          this.logger.info?.("[PreProcess] MultiStageProofreadProcessor: 非滑动窗口", {
            sourceTextLength: request.sourceText.length,
            hasPreProcessors: Boolean(request.preProcessors),
          });
          return splitTextIntoUnits(request.sourceText);
        })();
    const currentTranslations = window
      ? buildSourceUnitsFromLines(window.translation.lines)
      : splitTextIntoUnits(request.currentTranslationText);

    if (sourceUnits.length === 0) {
      return buildEmptyResult(window);
    }

    if (sourceUnits.length !== currentTranslations.length) {
      throw new Error(
        `校对输入的原文与译文行数不一致: source=${sourceUnits.length}, translation=${currentTranslations.length}`,
      );
    }

    const requirements = [...(request.requirements ?? [])];
    const referencePairs = request.contextView?.getDependencyPairs() ?? [];
    const referenceTranslations =
      request.contextView?.getDependencyTranslatedTexts() ?? [];
    const plotSummaries = request.contextView?.getPlotSummaryTexts() ?? [];
    const translatedGlossaryTerms =
      request.contextView?.getTranslatedGlossaryTerms() ??
      request.glossary?.getTranslatedTermsForText(request.sourceText) ??
      [];

    this.logger.info?.("开始执行校对流程", {
      processorName: this.processorName,
      sourceUnitCount: sourceUnits.length,
      reviewIterations: this.reviewIterations,
      chapterId: request.workItemRef?.chapterId,
      fragmentIndex: request.workItemRef?.fragmentIndex,
    });

    let latestTranslations = currentTranslations.map((unit) => ({
      id: unit.id,
      translation: unit.text,
    }));
    let lastResponseText = "";
    let lastSystemPrompt = "";
    let lastUserPrompt = "";
    let lastPromptName = "multi_stage_revision";
    let lastResponseSchema: JsonObject = buildTranslationResponseSchema(sourceUnits);

    for (let round = 0; round < this.reviewIterations; round++) {
      if (request.signal?.aborted) {
        throw new AbortError("校对流程已被取消");
      }

      const editorIncludeReason = this.resolveIncludeReason("editor");
      const editorPrompt = await this.promptManager.renderMultiStageEditorPrompt({
        sourceUnits,
        currentTranslations: toPromptUnits(latestTranslations),
        referenceTranslations,
        plotSummaries,
        translatedGlossaryTerms,
        requirements,
        editorRequirementsText: request.editorRequirementsText,
        includeReason: editorIncludeReason,
      });

      this.logger.info?.("编辑修订阶段", {
        processorName: this.processorName,
        round: round + 1,
        reviewIterations: this.reviewIterations,
      });

      const editorClient = this.resolveClient("editor");
      const editorResponseText = await editorClient.singleTurnRequest(
        editorPrompt.userPrompt,
        {
          ...withRequestMeta(
            withOutputValidator(
              buildJsonSchemaChatRequestOptions(
                this.buildStepRequestOptions("editor", request.requestOptions),
                {
                  name: editorPrompt.name,
                  systemPrompt: editorPrompt.systemPrompt,
                  responseSchema: editorPrompt.responseSchema,
                },
                editorClient.supportsStructuredOutput,
              ),
              (candidateResponseText) => {
                parseProofreadModificationResponse(
                  candidateResponseText,
                  sourceUnits.map((unit) => unit.id),
                  false,
                );
              },
            ),
            this.buildStepRequestMeta("editor", request, round),
          ),
          signal: request.signal,
        },
      );
      latestTranslations = applyProofreadModifications(
        latestTranslations,
        parseProofreadModificationResponse(
          editorResponseText,
          sourceUnits.map((unit) => unit.id),
          false,
        ),
      );

      const proofreaderIncludeReason = this.resolveIncludeReason("proofreader");
      const proofreaderPrompt = await this.promptManager.renderProofreadProofreaderPrompt({
        sourceUnits,
        currentTranslations: toPromptUnits(latestTranslations),
        referencePairs: toPromptReferenceUnits(referencePairs),
        plotSummaries,
        translatedGlossaryTerms,
        requirements,
        analysisText: request.fragmentAuxData?.["styleTransfer.analysis.v1"] as string | undefined,
        includeReason: proofreaderIncludeReason,
      });

      this.logger.info?.("校对修订阶段", {
        processorName: this.processorName,
        round: round + 1,
        reviewIterations: this.reviewIterations,
      });

      const proofreaderClient = this.resolveClient("proofreader");
      const proofreaderResponseText = await proofreaderClient.singleTurnRequest(
        proofreaderPrompt.userPrompt,
        {
          ...withRequestMeta(
            withOutputValidator(
              buildJsonSchemaChatRequestOptions(
                this.buildStepRequestOptions("proofreader", request.requestOptions),
                {
                  name: proofreaderPrompt.name,
                  systemPrompt: proofreaderPrompt.systemPrompt,
                  responseSchema: proofreaderPrompt.responseSchema,
                },
                proofreaderClient.supportsStructuredOutput,
              ),
              (candidateResponseText) => {
                parseProofreadModificationResponse(
                  candidateResponseText,
                  sourceUnits.map((unit) => unit.id),
                  false,
                );
              },
            ),
            this.buildStepRequestMeta("proofreader", request, round),
          ),
          signal: request.signal,
        },
      );
      latestTranslations = applyProofreadModifications(
        latestTranslations,
        parseProofreadModificationResponse(
          proofreaderResponseText,
          sourceUnits.map((unit) => unit.id),
          false,
        ),
      );
      lastResponseText = proofreaderResponseText;
      lastSystemPrompt = proofreaderPrompt.systemPrompt;
      lastUserPrompt = proofreaderPrompt.userPrompt;
      lastPromptName = proofreaderPrompt.name;
      lastResponseSchema = proofreaderPrompt.responseSchema;
    }

    let outputText = buildOutputText(latestTranslations, window);
    const repairedOutput = await repairTranslationOutputLines({
      sourceUnits,
      translations: latestTranslations,
      outputText,
      window,
      mismatchBehavior: "strict",
      logger: this.logger,
      processorName: this.processorName,
    });
    latestTranslations = repairedOutput.translations;
    outputText = repairedOutput.outputText;

    this.logger.info?.("校对流程完成", {
      processorName: this.processorName,
      translatedUnitCount: latestTranslations.length,
      reviewIterations: this.reviewIterations,
    });

    return {
      outputText,
      translations: latestTranslations,
      glossaryUpdates: [],
      responseText: lastResponseText,
      responseSchema: lastResponseSchema,
      promptName: lastPromptName,
      systemPrompt: lastSystemPrompt,
      userPrompt: lastUserPrompt,
      window,
    };
  }

  private resolveClient(step: ProofreadStepName): ChatClient {
    const resolver = this.stepResolvers[step] ?? this.defaultClientResolver;
    if ("singleTurnRequest" in resolver) {
      return resolver;
    }

    return resolver.provider.getChatClient(resolver.modelName);
  }

  private buildStepRequestOptions(
    step: ProofreadStepName,
    requestOptions: ChatRequestOptions | undefined,
  ): ChatRequestOptions | undefined {
    return mergeChatRequestOptions(
      mergeChatRequestOptions(this.defaultRequestOptions, this.stepRequestOptions?.[step]),
      requestOptions,
    );
  }

  private buildStepRequestMeta(
    step: ProofreadStepName,
    request: ProofreadProcessorRequest,
    round?: number,
  ): LlmRequestMetadata {
    const context: JsonObject = {
      sourceTextLength: request.sourceText.length,
      sourceUnitCount: splitTextIntoUnits(request.sourceText).length,
    };
    if (this.processorName) {
      context.processorName = this.processorName;
    }
    if (request.workItemRef) {
      context.chapterId = request.workItemRef.chapterId;
      context.fragmentIndex = request.workItemRef.fragmentIndex;
      if (request.workItemRef.stepId) {
        context.stepId = request.workItemRef.stepId;
      }
    }
    if (round !== undefined) {
      context.reviewRound = round + 1;
    }

    return {
      label: `校对-${getProofreadOperationLabel(step)}`,
      feature: "校对",
      operation: getProofreadOperationLabel(step),
      component: "MultiStageProofreadProcessor",
      workflow: "proofread-multi-stage",
      stage: step,
      context,
    };
  }
}

export class SingleStepProofreadProcessor implements ProofreadProcessor {
  private readonly logger: Logger;
  private readonly defaultRequestOptions?: ChatRequestOptions;
  private readonly defaultSlidingWindow?: SlidingWindowOptions;
  private readonly processorName?: string;
  private readonly promptManager: PromptManager;
  private readonly outputRepairer?: TranslationOutputRepairer;

  constructor(
    private readonly clientResolver: TranslationProcessorClientResolver,
    private readonly options: SingleStepProofreadProcessorOptions,
  ) {
    this.promptManager = options.promptManager ?? new PromptManager();
    this.defaultRequestOptions = options.defaultRequestOptions;
    this.defaultSlidingWindow = options.defaultSlidingWindow;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.processorName = options.processorName;
    this.outputRepairer = options.outputRepairer;
  }

  async process(request: ProofreadProcessorRequest): Promise<TranslationProcessorResult> {
    const window = resolveSlidingWindow(request, this.defaultSlidingWindow);
    const sourceUnits = window
      ? (() => {
          const preprocessed = applyPreProcessingToLines(window.source.lines, request.preProcessors);
          this.logger.info?.("[PreProcess] SingleStepProofreadProcessor: 滑动窗口+预处理", {
            windowLines: window.source.lines.length,
            preprocessedLines: preprocessed.length,
          });
          return buildSourceUnitsFromLines(preprocessed);
        })()
      : (() => {
          this.logger.info?.("[PreProcess] SingleStepProofreadProcessor: 非滑动窗口", {
            sourceTextLength: request.sourceText.length,
            hasPreProcessors: Boolean(request.preProcessors),
          });
          return splitTextIntoUnits(request.sourceText);
        })();
    const currentTranslations = window
      ? buildSourceUnitsFromLines(window.translation.lines)
      : splitTextIntoUnits(request.currentTranslationText);

    if (sourceUnits.length === 0) {
      return buildEmptyResult(window);
    }

    if (sourceUnits.length !== currentTranslations.length) {
      throw new Error(
        `校对输入的原文与译文行数不一致: source=${sourceUnits.length}, translation=${currentTranslations.length}`,
      );
    }

    const requirements = [...(request.requirements ?? [])];
    const plotSummaries = request.contextView?.getPlotSummaryTexts() ?? [];
    const translatedGlossaryTerms =
      request.contextView?.getTranslatedGlossaryTerms() ??
      request.glossary?.getTranslatedTermsForText(request.sourceText) ??
      [];
    const latestTranslations = currentTranslations.map((unit) => ({
      id: unit.id,
      translation: unit.text,
    }));

    const includeReason = this.options.includeReason ?? true;
    const prompt =
      this.options.step === "editor"
        ? await this.promptManager.renderMultiStageEditorPrompt({
            sourceUnits,
            currentTranslations: toPromptUnits(latestTranslations),
            referenceTranslations: request.contextView?.getDependencyTranslatedTexts() ?? [],
            plotSummaries,
            translatedGlossaryTerms,
            requirements,
            editorRequirementsText: request.editorRequirementsText,
            includeReason,
            includeSourceText: this.options.includeSourceText,
          })
        : await this.promptManager.renderProofreadProofreaderPrompt({
            sourceUnits,
            currentTranslations: toPromptUnits(latestTranslations),
            referencePairs: toPromptReferenceUnits(request.contextView?.getDependencyPairs() ?? []),
            plotSummaries,
            translatedGlossaryTerms,
            requirements,
            analysisText: request.fragmentAuxData?.["styleTransfer.analysis.v1"] as
              | string
              | undefined,
            includeReason,
          });

    this.logger.info?.(
      this.options.step === "editor" ? "开始执行单步编辑校对" : "开始执行单步校对校验",
      {
        processorName: this.processorName,
        step: this.options.step,
        sourceUnitCount: sourceUnits.length,
        chapterId: request.workItemRef?.chapterId,
        fragmentIndex: request.workItemRef?.fragmentIndex,
      },
    );

    const client = this.resolveClient();
    const responseText = await client.singleTurnRequest(
      prompt.userPrompt,
      {
        ...withRequestMeta(
          withOutputValidator(
            buildJsonSchemaChatRequestOptions(
              mergeChatRequestOptions(this.defaultRequestOptions, request.requestOptions),
              {
                name: prompt.name,
                systemPrompt: prompt.systemPrompt,
                responseSchema: prompt.responseSchema,
              },
              client.supportsStructuredOutput,
            ),
            (candidateResponseText) => {
              parseProofreadModificationResponse(
                candidateResponseText,
                sourceUnits.map((unit) => unit.id),
                false,
              );
            },
          ),
          buildSingleStepRequestMeta(this.options.step, request, this.processorName),
        ),
        signal: request.signal,
      },
    );

    let translations = applyProofreadModifications(
      latestTranslations,
      parseProofreadModificationResponse(
        responseText,
        sourceUnits.map((unit) => unit.id),
        false,
      ),
    );

    let outputText = buildOutputText(translations, window);
    const repairedOutput = await repairTranslationOutputLines({
      sourceUnits,
      translations,
      outputText,
      window,
      mismatchBehavior: "strict",
      logger: this.logger,
      processorName: this.processorName,
    });
    translations = repairedOutput.translations;
    outputText = repairedOutput.outputText;

    return {
      outputText,
      translations,
      glossaryUpdates: [],
      responseText,
      responseSchema: prompt.responseSchema,
      promptName: prompt.name,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      window,
    };
  }

  private resolveClient(): ChatClient {
    if ("singleTurnRequest" in this.clientResolver) {
      return this.clientResolver;
    }

    return this.clientResolver.provider.getChatClient(this.clientResolver.modelName);
  }
}

export class ConsistencyCheckProofreadProcessor implements ProofreadProcessor {
  private readonly logger: Logger;
  private readonly promptManager: PromptManager;
  private readonly defaultRequestOptions?: ChatRequestOptions;
  private readonly defaultSlidingWindow?: SlidingWindowOptions;
  private readonly processorName?: string;
  private readonly outputRepairer?: TranslationOutputRepairer;
  private readonly maxSourceChars?: number;
  private readonly maxAdditionalRelatedContexts: number;
  private readonly randomContextCount: number;
  private readonly includeReason: boolean;

  constructor(
    private readonly clientResolver: TranslationProcessorClientResolver,
    options: ConsistencyCheckProofreadProcessorOptions = {},
  ) {
    this.promptManager = options.promptManager ?? new PromptManager();
    this.defaultRequestOptions = options.defaultRequestOptions;
    this.defaultSlidingWindow = options.defaultSlidingWindow;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.processorName = options.processorName;
    this.outputRepairer = options.outputRepairer;
    this.maxSourceChars = options.maxSourceChars;
    this.maxAdditionalRelatedContexts = Math.max(0, options.maxAdditionalRelatedContexts ?? 3);
    this.randomContextCount = Math.max(0, options.randomContextCount ?? 2);
    this.includeReason = options.includeReason ?? true;
  }

  async process(request: ProofreadProcessorRequest): Promise<TranslationProcessorResult> {
    const window = resolveSlidingWindow(request, this.defaultSlidingWindow);
    const sourceUnits = window
      ? (() => {
          const preprocessed = applyPreProcessingToLines(window.source.lines, request.preProcessors);
          this.logger.info?.("[PreProcess] ConsistencyCheckProofreadProcessor: 滑动窗口+预处理", {
            windowLines: window.source.lines.length,
            preprocessedLines: preprocessed.length,
          });
          return buildSourceUnitsFromLines(preprocessed);
        })()
      : (() => {
          this.logger.info?.("[PreProcess] ConsistencyCheckProofreadProcessor: 非滑动窗口", {
            sourceTextLength: request.sourceText.length,
            hasPreProcessors: Boolean(request.preProcessors),
          });
          return splitTextIntoUnits(request.sourceText);
        })();
    const currentTranslations = window
      ? buildSourceUnitsFromLines(window.translation.lines)
      : splitTextIntoUnits(request.currentTranslationText);

    if (sourceUnits.length === 0) {
      return buildEmptyResult(window);
    }

    if (sourceUnits.length !== currentTranslations.length) {
      throw new Error(
        `校对输入的原文与译文行数不一致: source=${sourceUnits.length}, translation=${currentTranslations.length}`,
      );
    }

    if (this.maxSourceChars !== undefined && request.sourceText.length > this.maxSourceChars) {
      throw new Error(
        `一致性检查校对输入超出上限: sourceChars=${request.sourceText.length}, maxSourceChars=${this.maxSourceChars}`,
      );
    }

    const requirements = [...(request.requirements ?? [])];
    const plotSummaries = request.contextView?.getPlotSummaryTexts() ?? [];
    const translatedGlossaryTerms =
      request.contextView?.getTranslatedGlossaryTerms() ??
      request.glossary?.getTranslatedTermsForText(request.sourceText) ??
      [];
    const { relatedReferencePairs, randomReferencePairs } = await this.collectConsistencyReferencePairs(
      request,
    );

    this.logger.info?.("开始执行一致性检查校对", {
      processorName: this.processorName,
      sourceUnitCount: sourceUnits.length,
      relatedReferenceCount: relatedReferencePairs.length,
      randomReferenceCount: randomReferencePairs.length,
      chapterId: request.workItemRef?.chapterId,
      fragmentIndex: request.workItemRef?.fragmentIndex,
    });

    const prompt = await this.promptManager.renderConsistencyProofreadPrompt({
      sourceUnits,
      currentTranslations,
      relatedReferencePairs: toPromptReferenceUnits(relatedReferencePairs),
      randomReferencePairs: toPromptReferenceUnits(randomReferencePairs),
      plotSummaries,
      translatedGlossaryTerms,
      requirements,
      includeReason: this.includeReason,
    });

    const client = this.resolveClient();
    const responseText = await client.singleTurnRequest(
      prompt.userPrompt,
      {
        ...withRequestMeta(
          withOutputValidator(
            buildJsonSchemaChatRequestOptions(
              this.defaultRequestOptions,
              {
                name: prompt.name,
                systemPrompt: prompt.systemPrompt,
                responseSchema: prompt.responseSchema,
              },
              client.supportsStructuredOutput,
            ),
            (candidateResponseText) => {
              parseProofreadModificationResponse(
                candidateResponseText,
                sourceUnits.map((unit) => unit.id),
                false,
              );
            },
          ),
          this.buildRequestMeta(request, relatedReferencePairs.length, randomReferencePairs.length),
        ),
        signal: request.signal,
      },
    );

    let translations = applyProofreadModifications(
      currentTranslations.map((unit) => ({
        id: unit.id,
        translation: unit.text,
      })),
      parseProofreadModificationResponse(
        responseText,
        sourceUnits.map((unit) => unit.id),
        false,
      ),
    );

    let outputText = buildOutputText(translations, window);
    const repairedOutput = await repairTranslationOutputLines({
      sourceUnits,
      translations,
      outputText,
      window,
      mismatchBehavior: "strict",
      logger: this.logger,
      processorName: this.processorName,
    });
    translations = repairedOutput.translations;
    outputText = repairedOutput.outputText;

    return {
      outputText,
      translations,
      glossaryUpdates: [],
      responseText,
      responseSchema: prompt.responseSchema,
      promptName: prompt.name,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      window,
    };
  }

  private resolveClient(): ChatClient {
    if ("singleTurnRequest" in this.clientResolver) {
      return this.clientResolver;
    }

    return this.clientResolver.provider.getChatClient(this.clientResolver.modelName);
  }

  private buildRequestMeta(
    request: ProofreadProcessorRequest,
    relatedReferenceCount: number,
    randomReferenceCount: number,
  ): LlmRequestMetadata {
    const context: JsonObject = {
      sourceTextLength: request.sourceText.length,
      sourceUnitCount: splitTextIntoUnits(request.sourceText).length,
      relatedReferenceCount,
      randomReferenceCount,
    };
    if (this.processorName) {
      context.processorName = this.processorName;
    }
    if (request.workItemRef) {
      context.chapterId = request.workItemRef.chapterId;
      context.fragmentIndex = request.workItemRef.fragmentIndex;
      if (request.workItemRef.stepId) {
        context.stepId = request.workItemRef.stepId;
      }
    }

    return {
      label: "校对-一致性检查",
      feature: "校对",
      operation: "一致性检查",
      component: "ConsistencyCheckProofreadProcessor",
      workflow: "proofread-consistency-check",
      stage: "consistency",
      context,
    };
  }

  private async collectConsistencyReferencePairs(request: ProofreadProcessorRequest): Promise<{
    relatedReferencePairs: Array<{ sourceText: string; translatedText: string }>;
    randomReferencePairs: Array<{ sourceText: string; translatedText: string }>;
  }> {
    const documentManager = request.documentManager;
    const workItemRefs =
      request.workItemRefs && request.workItemRefs.length > 0
        ? dedupeProofreadFragmentRefs(request.workItemRefs)
        : request.workItemRef
          ? [request.workItemRef]
          : undefined;
    const orderedFragments = request.orderedFragments;
    if (!documentManager || !workItemRefs || !orderedFragments) {
      throw new Error("一致性检查校对需要文档管理器、工作项位置和有序分片列表");
    }

    const network = await documentManager.loadContextNetwork();
    if (!network) {
      throw new Error("一致性检查校对需要先构建上下文网络");
    }
    if (network.manifest.blockSize !== 1) {
      throw new Error(`上下文网络 blockSize=${network.manifest.blockSize} 不兼容；一致性检查仅支持 blockSize=1`);
    }
    if (network.manifest.fragmentCount !== orderedFragments.length) {
      throw new Error(
        `上下文网络 fragmentCount 不匹配: network=${network.manifest.fragmentCount}, current=${orderedFragments.length}`,
      );
    }
    if (
      request.dependencyTrackingSourceRevision !== undefined &&
      network.manifest.sourceRevision !== request.dependencyTrackingSourceRevision
    ) {
      throw new Error(
        `上下文网络已过期: network.sourceRevision=${network.manifest.sourceRevision}, current.sourceRevision=${request.dependencyTrackingSourceRevision}`,
      );
    }

    const currentGlobalIndices = workItemRefs
      .map((workItemRef) =>
        orderedFragments.findIndex(
          (fragment) =>
            fragment.chapterId === workItemRef.chapterId &&
            fragment.fragmentIndex === workItemRef.fragmentIndex,
        ),
      )
      .filter((index) => index >= 0);
    if (currentGlobalIndices.length !== workItemRefs.length) {
      throw new Error("一致性检查校对未找到当前片段在上下文网络中的位置");
    }

    const currentWorkItemKeySet = new Set(
      workItemRefs.map((ref) => `${ref.chapterId}:${ref.fragmentIndex}`),
    );
    const predecessorRefs = dedupeProofreadFragmentRefs(
      workItemRefs.flatMap((workItemRef, index) => {
        const currentGlobalIndex = currentGlobalIndices[index]!;
        const predecessorChapterIds = new Set(
          getPredecessorChapterIds(
            workItemRef.chapterId,
            request.storyTopology,
            orderedFragments,
          ),
        );
        return orderedFragments.slice(0, currentGlobalIndex).filter((ref) => {
          if (currentWorkItemKeySet.has(`${ref.chapterId}:${ref.fragmentIndex}`)) {
            return false;
          }
          return isAllowedConsistencyPredecessorRef(ref, workItemRef, predecessorChapterIds);
        });
      }),
    );
    const predecessorKeySet = new Set(
      predecessorRefs.map((ref) => `${ref.chapterId}:${ref.fragmentIndex}`),
    );

    const relatedRefs = dedupeProofreadFragmentRefs(
      currentGlobalIndices.flatMap((currentGlobalIndex) => {
        const startOffset = network.offsets[currentGlobalIndex] ?? 0;
        const endOffset = network.offsets[currentGlobalIndex + 1] ?? startOffset;
        return Array.from({ length: endOffset - startOffset }, (_, index) => {
          const candidateGlobalIndex = network.targets[startOffset + index];
          if (candidateGlobalIndex === undefined || candidateGlobalIndex < 0) {
            return undefined;
          }
          return orderedFragments[candidateGlobalIndex];
        }).filter((ref): ref is { chapterId: number; fragmentIndex: number } => {
          if (!ref) {
            return false;
          }
          const key = `${ref.chapterId}:${ref.fragmentIndex}`;
          return predecessorKeySet.has(key) && !currentWorkItemKeySet.has(key);
        });
      }),
    )
      .sort((left, right) => compareProofreadFragmentRefs(left, right, orderedFragments))
      .slice(0, this.maxAdditionalRelatedContexts);

    const relatedKeySet = new Set(relatedRefs.map((ref) => `${ref.chapterId}:${ref.fragmentIndex}`));
    const randomCandidates = predecessorRefs.filter(
      (ref) => !relatedKeySet.has(`${ref.chapterId}:${ref.fragmentIndex}`),
    );
    const randomRefs = selectDeterministicRandomRefs(
      randomCandidates,
      this.randomContextCount,
      workItemRefs.map((ref) => `${ref.chapterId}:${ref.fragmentIndex}`).join("|"),
    );

    return {
      relatedReferencePairs: buildReferencePairs(relatedRefs, documentManager),
      randomReferencePairs: buildReferencePairs(randomRefs, documentManager),
    };
  }
}

function getProofreadOperationLabel(step: ProofreadStepName): string {
  switch (step) {
    case "editor":
      return "编辑修订";
    case "proofreader":
      return "校对修订";
  }
}

function buildSingleStepRequestMeta(
  step: ProofreadStepName,
  request: ProofreadProcessorRequest,
  processorName: string | undefined,
): LlmRequestMetadata {
  const context: JsonObject = {
    sourceTextLength: request.sourceText.length,
    sourceUnitCount: splitTextIntoUnits(request.sourceText).length,
  };
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

  return {
    label: `校对-${getProofreadOperationLabel(step)}`,
    feature: "校对",
    operation: getProofreadOperationLabel(step),
    component: "SingleStepProofreadProcessor",
    workflow: step === "editor" ? "proofread-editor-only" : "proofread-proofreader-only",
    stage: step,
    context,
  };
}

function buildTranslationResponseSchema(
  sourceUnits: ReadonlyArray<PromptTranslationUnit>,
): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      translations: {
        type: "array",
        minItems: sourceUnits.length,
        maxItems: sourceUnits.length,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
            },
            translation: {
              type: "string",
              minLength: 1,
            },
          },
          required: ["id", "translation"],
        },
      },
    },
    required: ["translations"],
  };
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

function splitTextIntoUnits(sourceText: string): PromptTranslationUnit[] {
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

function parseProofreadModificationResponse(
  responseText: string,
  expectedIds: ReadonlyArray<string>,
  requireReason = true,
): ProofreadModification[] {
  let parsed: unknown;
  try {
    parsed = parseJsonResponseText(responseText);
  } catch (error) {
    throw new Error(
      `校对结果不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("校对结果必须是 JSON 对象");
  }

  const modificationValues = parsed.modifications;
  if (!Array.isArray(modificationValues)) {
    throw new Error("校对结果缺少 modifications 数组");
  }

  const expectedIdSet = new Set(expectedIds);
  const seenIds = new Set<string>();

  return modificationValues.map<ProofreadModification>((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`modifications[${index}] 必须是对象`);
    }

    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    const translation =
      typeof entry.translation === "string"
        ? normalizeInlineLineBreaks(entry.translation.trim())
        : "";

    if (!id || !expectedIdSet.has(id)) {
      throw new Error(`modifications[${index}].id 无效或未请求: ${id}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`modifications[${index}].id 重复: ${id}`);
    }
    if (!reason && requireReason) {
      throw new Error(`modifications[${index}].reason 不能为空`);
    }
    if (!translation) {
      throw new Error(`modifications[${index}].translation 不能为空`);
    }

    seenIds.add(id);
    return { id, reason, translation };
  });
}

function applyProofreadModifications(
  translations: ReadonlyArray<TranslationProcessorTranslation>,
  modifications: ReadonlyArray<ProofreadModification>,
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

function buildOutputText(
  translations: ReadonlyArray<TranslationProcessorTranslation>,
  window: SlidingWindowFragment | undefined,
): string {
  if (!window) {
    return translations.map((translation) => translation.translation).join("\n");
  }

  return translations
    .slice(window.focusLineStart, window.focusLineEnd)
    .map((translation) => translation.translation)
    .join("\n");
}

function resolveSlidingWindow(
  request: ProofreadProcessorRequest,
  defaultSlidingWindow: SlidingWindowOptions | undefined,
): SlidingWindowFragment | undefined {
  if (request.disableSlidingWindow || !request.documentManager || !request.workItemRef) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildReferencePairs(
  refs: ReadonlyArray<{ chapterId: number; fragmentIndex: number }>,
  documentManager: TranslationDocumentManager,
): Array<{ sourceText: string; translatedText: string }> {
  return refs
    .map((ref) => ({
      sourceText: documentManager.getSourceText(ref.chapterId, ref.fragmentIndex),
      translatedText: documentManager.getTranslatedText(ref.chapterId, ref.fragmentIndex),
    }))
    .filter((pair) => pair.sourceText.trim().length > 0 && pair.translatedText.trim().length > 0);
}

function getPredecessorChapterIds(
  chapterId: number,
  storyTopology: StoryTopology | undefined,
  orderedFragments: ReadonlyArray<{ chapterId: number; fragmentIndex: number }>,
): number[] {
  if (storyTopology) {
    return storyTopology.getPredecessorChapterIds(chapterId);
  }

  const chapterIds: number[] = [];
  const seen = new Set<number>();
  for (const ref of orderedFragments) {
    if (ref.chapterId === chapterId) {
      break;
    }
    if (!seen.has(ref.chapterId)) {
      seen.add(ref.chapterId);
      chapterIds.push(ref.chapterId);
    }
  }
  return chapterIds;
}

function isAllowedConsistencyPredecessorRef(
  ref: { chapterId: number; fragmentIndex: number },
  current: { chapterId: number; fragmentIndex: number },
  predecessorChapterIds: ReadonlySet<number>,
): boolean {
  if (ref.chapterId === current.chapterId) {
    return ref.fragmentIndex < current.fragmentIndex;
  }
  return predecessorChapterIds.has(ref.chapterId);
}

function dedupeProofreadFragmentRefs(
  refs: ReadonlyArray<{ chapterId: number; fragmentIndex: number }>,
): Array<{ chapterId: number; fragmentIndex: number }> {
  const seen = new Set<string>();
  const result: Array<{ chapterId: number; fragmentIndex: number }> = [];
  for (const ref of refs) {
    const key = `${ref.chapterId}:${ref.fragmentIndex}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function compareProofreadFragmentRefs(
  left: { chapterId: number; fragmentIndex: number },
  right: { chapterId: number; fragmentIndex: number },
  orderedFragments: ReadonlyArray<{ chapterId: number; fragmentIndex: number }>,
): number {
  return getProofreadFragmentGlobalIndex(left, orderedFragments) - getProofreadFragmentGlobalIndex(right, orderedFragments);
}

function getProofreadFragmentGlobalIndex(
  ref: { chapterId: number; fragmentIndex: number },
  orderedFragments: ReadonlyArray<{ chapterId: number; fragmentIndex: number }>,
): number {
  return orderedFragments.findIndex(
    (fragment) => fragment.chapterId === ref.chapterId && fragment.fragmentIndex === ref.fragmentIndex,
  );
}

function selectDeterministicRandomRefs(
  refs: ReadonlyArray<{ chapterId: number; fragmentIndex: number }>,
  count: number,
  seed: string,
): Array<{ chapterId: number; fragmentIndex: number }> {
  if (count <= 0 || refs.length === 0) {
    return [];
  }

  return [...refs]
    .sort((left, right) => {
      const leftScore = stableHash(`${seed}:${left.chapterId}:${left.fragmentIndex}`);
      const rightScore = stableHash(`${seed}:${right.chapterId}:${right.fragmentIndex}`);
      if (leftScore === rightScore) {
        return 0;
      }
      return leftScore - rightScore;
    })
    .slice(0, count);
}

function stableHash(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}