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
import type {
  TranslationProcessorClientResolver,
  TranslationProcessorResult,
  TranslationProcessorTranslation,
} from "./translation-processor.ts";
import type { ChatClient } from "../../llm/base.ts";
import type { SlidingWindowFragment, SlidingWindowOptions, FragmentAuxData, FragmentAuxDataContract } from "../types.ts";

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
  workItemRef?: {
    chapterId: number;
    fragmentIndex: number;
    stepId?: string;
  };
  /** 该文本块当前已持久化的辅助数据，供消费方按需读取。 */
  fragmentAuxData?: FragmentAuxData;
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
  }

  async process(request: ProofreadProcessorRequest): Promise<TranslationProcessorResult> {
    const window = resolveSlidingWindow(request, this.defaultSlidingWindow);
    const sourceUnits = window
      ? buildSourceUnitsFromLines(window.source.lines)
      : splitTextIntoUnits(request.sourceText);
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
    const referenceContext =
      request.contextView?.getDependencyPromptContext() ?? {
        referencePairs: [],
        referenceSourceTexts: [],
        referenceTranslations: [],
        plotSummaries: [],
      };
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
      const editorPrompt = await this.promptManager.renderMultiStageEditorPrompt({
        currentTranslations: toPromptUnits(latestTranslations),
        referenceTranslations: referenceContext.referenceTranslations,
        translatedGlossaryTerms,
        requirements,
        editorRequirementsText: request.editorRequirementsText,
      });

      this.logger.info?.("编辑修订阶段", {
        processorName: this.processorName,
        round: round + 1,
        reviewIterations: this.reviewIterations,
      });

      const editorClient = this.resolveClient("editor");
      const editorResponseText = await editorClient.singleTurnRequest(
        editorPrompt.userPrompt,
        withRequestMeta(
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
              );
            },
          ),
          this.buildStepRequestMeta("editor", request, round),
        ),
      );
      latestTranslations = applyProofreadModifications(
        latestTranslations,
        parseProofreadModificationResponse(
          editorResponseText,
          sourceUnits.map((unit) => unit.id),
        ),
      );

      const proofreaderPrompt = await this.promptManager.renderProofreadProofreaderPrompt({
        sourceUnits,
        currentTranslations: toPromptUnits(latestTranslations),
        referencePairs: toPromptReferenceUnits(referenceContext.referencePairs),
        plotSummaries: referenceContext.plotSummaries,
        translatedGlossaryTerms,
        requirements,
        analysisText: request.fragmentAuxData?.["styleTransfer.analysis.v1"] as string | undefined,
      });

      this.logger.info?.("校对修订阶段", {
        processorName: this.processorName,
        round: round + 1,
        reviewIterations: this.reviewIterations,
      });

      const proofreaderClient = this.resolveClient("proofreader");
      const proofreaderResponseText = await proofreaderClient.singleTurnRequest(
        proofreaderPrompt.userPrompt,
        withRequestMeta(
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
              );
            },
          ),
          this.buildStepRequestMeta("proofreader", request, round),
        ),
      );
      latestTranslations = applyProofreadModifications(
        latestTranslations,
        parseProofreadModificationResponse(
          proofreaderResponseText,
          sourceUnits.map((unit) => unit.id),
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
      outputRepairer: this.outputRepairer,
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

function getProofreadOperationLabel(step: ProofreadStepName): string {
  switch (step) {
    case "editor":
      return "编辑修订";
    case "proofreader":
      return "校对修订";
  }
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
    const translation = typeof entry.translation === "string" ? entry.translation.trim() : "";

    if (!id || !expectedIdSet.has(id)) {
      throw new Error(`modifications[${index}].id 无效或未请求: ${id}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`modifications[${index}].id 重复: ${id}`);
    }
    if (!reason) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}