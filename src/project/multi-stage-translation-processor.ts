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

import type { ResolvedGlossaryTerm } from "../glossary/glossary.ts";
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
import type { SlidingWindowOptions, SlidingWindowFragment } from "./types.ts";

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
  /** 评审迭代次数（大步骤二的重复次数）。默认值为 2。 */
  reviewIterations?: number;
};

export class MultiStageTranslationProcessor implements TranslationProcessor {
  private readonly logger: Logger;
  private readonly defaultRequestOptions?: ChatRequestOptions;
  private readonly defaultSlidingWindow?: SlidingWindowOptions;
  private readonly processorName?: string;
  private readonly glossaryUpdater: GlossaryUpdater;
  private readonly reviewIterations: number;

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
    this.defaultRequestOptions = options.defaultRequestOptions;
    this.defaultSlidingWindow = options.defaultSlidingWindow;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.processorName = options.processorName;
    this.reviewIterations = options.reviewIterations ?? 2;
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

    const referencePairs = request.contextView?.getDependencyPairs() ?? [];
    const referenceSourceTexts = referencePairs.map((p) => p.sourceText.trim()).filter(Boolean);
    const referenceTranslations = referencePairs.map((p) => p.translatedText.trim()).filter(Boolean);
    const translatedGlossaryTerms = resolveTranslatedGlossaryTerms(request);
    const untranslatedGlossaryTerms = resolveUntranslatedGlossaryTerms(request);
    const mergedOptions = mergeChatRequestOptions(
      this.defaultRequestOptions,
      request.requestOptions,
    );

    // ── 大步骤一 ──────────────────────────────────────────────────────────

    // Step 1: LLM1 分析
    const { systemPrompt: analyzerSystem, userPrompt: analyzerUser } = buildAnalyzerPrompt({
      sourceUnits,
      referenceSourceTexts,
      referenceTranslations,
      glossaryTerms: translatedGlossaryTerms,
      requirements: request.requirements ?? [],
    });
    this.logger.info?.("LLM1 分析阶段", { processorName: this.processorName });
    const analysisText = await this.resolveClient("analyzer").singleTurnRequest(
      analyzerUser,
      withSystemPrompt(mergedOptions, analyzerSystem),
    );

    // Step 2: LLM2 初步翻译
    const translationSchema = buildTranslationSchema(sourceUnits);
    const { systemPrompt: translatorSystem, userPrompt: translatorUser } = buildTranslatorPrompt({
      sourceUnits,
      referenceTranslations,
      glossaryTerms: translatedGlossaryTerms,
      analysisText,
      requirements: request.requirements ?? [],
      responseSchema: translationSchema,
    });
    this.logger.info?.("LLM2 翻译阶段", { processorName: this.processorName });
    const initialResponseText = await this.resolveClient("translator").singleTurnRequest(
      translatorUser,
      buildJsonSchemaChatRequestOptions(mergedOptions, {
        name: "multi_stage_translation",
        systemPrompt: translatorSystem,
        responseSchema: translationSchema,
      }),
    );
    let currentTranslations = parseTranslationResponse(
      initialResponseText,
      sourceUnits.map((u) => u.id),
    );

    // Step 3: LLM3 润色
    const { systemPrompt: polisherSystem, userPrompt: polisherUser } = buildPolisherPrompt({
      sourceUnits,
      currentTranslations,
      referenceTranslations,
      glossaryTerms: translatedGlossaryTerms,
      requirements: request.requirements ?? [],
      responseSchema: translationSchema,
    });
    this.logger.info?.("LLM3 润色阶段", { processorName: this.processorName });
    const polishedResponseText = await this.resolveClient("polisher").singleTurnRequest(
      polisherUser,
      buildJsonSchemaChatRequestOptions(mergedOptions, {
        name: "multi_stage_polish",
        systemPrompt: polisherSystem,
        responseSchema: translationSchema,
      }),
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
            requestOptions: request.requestOptions,
          })
        : Promise.resolve(undefined);

    // ── 大步骤二（重复 reviewIterations 次）────────────────────────────────

    let lastEditorFeedback = "";
    let lastProofreaderFeedback = "";
    let lastReviserSystemPrompt = "";
    let lastReviserUserPrompt = "";
    let lastReviserResponseText = "";

    for (let round = 0; round < this.reviewIterations; round++) {
      this.logger.info?.(`大步骤二 第 ${round + 1}/${this.reviewIterations} 轮`, {
        processorName: this.processorName,
      });

      const translationsAtRoundStart = currentTranslations;

      // LLM4 + LLM5 并行
      const { systemPrompt: editorSystem, userPrompt: editorUser } = buildEditorPrompt({
        currentTranslations,
        referenceTranslations,
        glossaryTerms: translatedGlossaryTerms,
        requirements: request.requirements ?? [],
      });

      const { systemPrompt: proofreaderSystem, userPrompt: proofreaderUser } =
        buildProofreaderPrompt({
          sourceUnits,
          currentTranslations,
          referenceSourceTexts,
          glossaryTerms: translatedGlossaryTerms,
          analysisText,
          requirements: request.requirements ?? [],
        });

      const [editorFeedback, proofreaderFeedback] = await Promise.all([
        this.resolveClient("editor").singleTurnRequest(
          editorUser,
          withSystemPrompt(mergedOptions, editorSystem),
        ),
        this.resolveClient("proofreader").singleTurnRequest(
          proofreaderUser,
          withSystemPrompt(mergedOptions, proofreaderSystem),
        ),
      ]);

      lastEditorFeedback = editorFeedback;
      lastProofreaderFeedback = proofreaderFeedback;

      // LLM6 修改
      const { systemPrompt: reviserSystem, userPrompt: reviserUser } = buildReviserPrompt({
        sourceUnits,
        currentTranslations: translationsAtRoundStart,
        referenceSourceTexts,
        referenceTranslations,
        glossaryTerms: translatedGlossaryTerms,
        editorFeedback,
        proofreaderFeedback,
        requirements: request.requirements ?? [],
        responseSchema: translationSchema,
      });

      lastReviserSystemPrompt = reviserSystem;
      lastReviserUserPrompt = reviserUser;

      const reviserResponseText = await this.resolveClient("reviser").singleTurnRequest(
        reviserUser,
        buildJsonSchemaChatRequestOptions(mergedOptions, {
          name: "multi_stage_revision",
          systemPrompt: reviserSystem,
          responseSchema: translationSchema,
        }),
      );

      lastReviserResponseText = reviserResponseText;
      currentTranslations = parseTranslationResponse(
        reviserResponseText,
        sourceUnits.map((u) => u.id),
      );
    }

    // 等待术语表更新完成
    const glossaryUpdateResult = await glossaryUpdatePromise;

    const outputText = buildOutputText(currentTranslations, window);

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
      responseSchema: translationSchema,
      promptName: "multi_stage_revision",
      systemPrompt: lastReviserSystemPrompt,
      userPrompt: lastReviserUserPrompt,
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
}

// ── Prompt 构建 ────────────────────────────────────────────────────────────────

type AnalyzerPromptInput = {
  sourceUnits: PromptTranslationUnit[];
  referenceSourceTexts: string[];
  referenceTranslations: string[];
  glossaryTerms: ResolvedGlossaryTerm[];
  requirements: ReadonlyArray<string>;
};

function buildAnalyzerPrompt(input: AnalyzerPromptInput): {
  systemPrompt: string;
  userPrompt: string;
} {
  const systemPrompt = `你是一位精通文学翻译的分析师，熟悉跨语言文学特征、叙事手法与文化差异。`;

  const lines: string[] = [];

  if (input.referenceSourceTexts.length > 0) {
    lines.push("## 参考原文（前序文段）");
    lines.push(input.referenceSourceTexts.join("\n\n"));
    lines.push("");
  }

  if (input.referenceTranslations.length > 0) {
    lines.push("## 参考译文（前序文段对应译文）");
    lines.push(input.referenceTranslations.join("\n\n"));
    lines.push("");
  }

  if (input.glossaryTerms.length > 0) {
    lines.push("## 术语表");
    lines.push(renderGlossaryFull(input.glossaryTerms));
    lines.push("");
  }

  if (input.requirements.length > 0) {
    lines.push("## 翻译要求");
    for (const req of input.requirements) {
      lines.push(`- ${req}`);
    }
    lines.push("");
  }

  lines.push("## 待分析原文");
  for (const unit of input.sourceUnits) {
    lines.push(`[${unit.id}] ${unit.text}`);
  }

  lines.push("");
  lines.push(
    "请分析以下内容，输出为结构清晰的纯文字报告（无需 JSON）：\n" +
      "1. **场景与氛围**：描述当前文段的场景、环境氛围。\n" +
      "2. **叙事视角**：第一人称、第三人称，有限或全知视角，叙述者的情感立场。\n" +
      "3. **文体风格与语气**：正式/非正式、诗意/直白、幽默/严肃等特征，以及典型句式和用词习惯。\n" +
      "4. **翻译难点**：文化特异性表达、语言游戏、双关、隐喻、人物语气特征，以及可能造成理解偏差的细节。",
  );

  return { systemPrompt, userPrompt: lines.join("\n") };
}

type TranslatorPromptInput = {
  sourceUnits: PromptTranslationUnit[];
  referenceTranslations: string[];
  glossaryTerms: ResolvedGlossaryTerm[];
  analysisText: string;
  requirements: ReadonlyArray<string>;
  responseSchema: JsonObject;
};

function buildTranslatorPrompt(input: TranslatorPromptInput): {
  systemPrompt: string;
  userPrompt: string;
} {
  const systemPrompt =
    "你是一位专业的文学翻译家，擅长将小说译成流畅自然的中文，注重保留原文的文学性与情感张力。";

  const lines: string[] = [];

  if (input.referenceTranslations.length > 0) {
    lines.push("## 参考译文（前序文段，用于保持风格一致性）");
    lines.push(input.referenceTranslations.join("\n\n"));
    lines.push("");
  }

  if (input.glossaryTerms.length > 0) {
    lines.push("## 术语表");
    lines.push(renderGlossaryFull(input.glossaryTerms));
    lines.push("");
  }

  if (input.requirements.length > 0) {
    lines.push("## 翻译要求");
    for (const req of input.requirements) {
      lines.push(`- ${req}`);
    }
    lines.push("");
  }

  lines.push("## 文本分析报告");
  lines.push(input.analysisText);
  lines.push("");

  lines.push("## 待翻译原文（按行编号）");
  for (const unit of input.sourceUnits) {
    lines.push(`[${unit.id}] ${unit.text}`);
  }

  lines.push("");
  lines.push(
    "请根据上方分析报告和参考资料，将每行原文精确译成中文。\n" +
      "- 严格遵循术语表中的译名。\n" +
      "- 保持与参考译文一致的文体风格。\n" +
      "- 输出格式为 JSON，结构遵循所提供的 schema，每个对象包含原行 id 与 translation。",
  );

  lines.push("");
  lines.push("JSON Schema:");
  lines.push(JSON.stringify(input.responseSchema, null, 2));

  return { systemPrompt, userPrompt: lines.join("\n") };
}

type PolisherPromptInput = {
  sourceUnits: PromptTranslationUnit[];
  currentTranslations: TranslationProcessorTranslation[];
  referenceTranslations: string[];
  glossaryTerms: ResolvedGlossaryTerm[];
  requirements: ReadonlyArray<string>;
  responseSchema: JsonObject;
};

function buildPolisherPrompt(input: PolisherPromptInput): {
  systemPrompt: string;
  userPrompt: string;
} {
  const systemPrompt =
    "你是一位资深中文文学编辑，擅长润色译文，使其在忠实原文的基础上更加符合中文表达习惯、读来流畅自然。";

  const lines: string[] = [];

  if (input.referenceTranslations.length > 0) {
    lines.push("## 参考译文（前序文段，用于保持风格一致性）");
    lines.push(input.referenceTranslations.join("\n\n"));
    lines.push("");
  }

  if (input.glossaryTerms.length > 0) {
    lines.push("## 术语表（仅译文）");
    lines.push(renderGlossaryTargetOnly(input.glossaryTerms));
    lines.push("");
  }

  if (input.requirements.length > 0) {
    lines.push("## 翻译要求");
    for (const req of input.requirements) {
      lines.push(`- ${req}`);
    }
    lines.push("");
  }

  lines.push("## 初步译文（按行编号）");
  for (const unit of input.currentTranslations) {
    lines.push(`[${unit.id}] ${unit.translation}`);
  }
  lines.push("");
  lines.push("## 对应原文（仅供参照原意，不得改变核心意思）");
  for (const unit of input.sourceUnits) {
    lines.push(`[${unit.id}] ${unit.text}`);
  }

  lines.push("");
  lines.push(
    "请对每行译文进行润色，要求：\n" +
      "- 修正不自然或生硬的中文表达，使其更符合目标读者的阅读习惯。\n" +
      "- 保持与参考译文一致的文体风格。\n" +
      "- 不得遗漏任何原文意思，不得增加原文没有的内容。\n" +
      "- 输出格式为 JSON，结构遵循所提供的 schema，每个对象包含原行 id 与润色后的 translation。",
  );

  lines.push("");
  lines.push("JSON Schema:");
  lines.push(JSON.stringify(input.responseSchema, null, 2));

  return { systemPrompt, userPrompt: lines.join("\n") };
}

type EditorPromptInput = {
  currentTranslations: TranslationProcessorTranslation[];
  referenceTranslations: string[];
  glossaryTerms: ResolvedGlossaryTerm[];
  requirements: ReadonlyArray<string>;
};

function buildEditorPrompt(input: EditorPromptInput): {
  systemPrompt: string;
  userPrompt: string;
} {
  const systemPrompt =
    "你是一位资深中文文学编辑，以中文读者的视角审稿，擅长发现译文中的表达问题并提出改进建议。";

  const lines: string[] = [];

  if (input.referenceTranslations.length > 0) {
    lines.push("## 参考译文（前序文段，体现本书整体文风）");
    lines.push(input.referenceTranslations.join("\n\n"));
    lines.push("");
  }

  if (input.glossaryTerms.length > 0) {
    lines.push("## 术语表（仅译文，用于核查译名一致性）");
    lines.push(renderGlossaryTargetOnly(input.glossaryTerms));
    lines.push("");
  }

  if (input.requirements.length > 0) {
    lines.push("## 翻译要求");
    for (const req of input.requirements) {
      lines.push(`- ${req}`);
    }
    lines.push("");
  }

  lines.push("## 待审读译文（按行编号）");
  for (const unit of input.currentTranslations) {
    lines.push(`[${unit.id}] ${unit.translation}`);
  }

  lines.push("");
  lines.push(
    "作为中文编辑，请指出译文中存在的表达问题，并给出具体的改进建议。重点关注：\n" +
      "- 不符合中文语言习惯的生硬翻腔（翻译腔）\n" +
      "- 词语选用不当或语气与整体文风不符之处\n" +
      "- 句子节奏、段落衔接和语流问题\n" +
      "- 译名与术语表不一致之处\n" +
      "请以行号 [id] 为单位，逐条列出问题与改进建议。若某行无问题，可略去不提。\n" +
      "输出为纯文字（无需 JSON）。",
  );

  return { systemPrompt, userPrompt: lines.join("\n") };
}

type ProofreaderPromptInput = {
  sourceUnits: PromptTranslationUnit[];
  currentTranslations: TranslationProcessorTranslation[];
  referenceSourceTexts: string[];
  glossaryTerms: ResolvedGlossaryTerm[];
  analysisText: string;
  requirements: ReadonlyArray<string>;
};

function buildProofreaderPrompt(input: ProofreaderPromptInput): {
  systemPrompt: string;
  userPrompt: string;
} {
  const systemPrompt =
    "你是一位严谨的文学翻译校对专家，擅长对照原文发现误译和细节错误。\n" +
    "在指出错误时，你应当尊重译者为保持文学流畅性和本地化效果而进行的合理意译或改写；\n" +
    "只有在意思出现明显偏差或重要细节被遗漏时，才提出更正意见。";

  const lines: string[] = [];

  if (input.referenceSourceTexts.length > 0) {
    lines.push("## 参考原文（前序文段）");
    lines.push(input.referenceSourceTexts.join("\n\n"));
    lines.push("");
  }

  if (input.glossaryTerms.length > 0) {
    lines.push("## 术语表");
    lines.push(renderGlossaryFull(input.glossaryTerms));
    lines.push("");
  }

  if (input.requirements.length > 0) {
    lines.push("## 翻译要求");
    for (const req of input.requirements) {
      lines.push(`- ${req}`);
    }
    lines.push("");
  }

  lines.push("## 文本分析报告（供参考）");
  lines.push(input.analysisText);
  lines.push("");

  lines.push("## 原文（按行编号）");
  for (const unit of input.sourceUnits) {
    lines.push(`[${unit.id}] ${unit.text}`);
  }
  lines.push("");

  lines.push("## 待校对译文（按行编号）");
  for (const unit of input.currentTranslations) {
    lines.push(`[${unit.id}] ${unit.translation}`);
  }

  lines.push("");
  lines.push(
    "作为校对专家，请逐行核对原文与译文，指出以下类型的问题：\n" +
      "- 关键信息或细节的遗漏、增添或误解\n" +
      "- 人名、地名、专有名词与术语表不符\n" +
      "- 时态、语态、语气的明显错误\n" +
      "请以行号 [id] 为单位列出问题与修正建议。合理的意译和本地化改写不需指出。\n" +
      "若某行无问题，可略去不提。输出为纯文字（无需 JSON）。",
  );

  return { systemPrompt, userPrompt: lines.join("\n") };
}

type ReviserPromptInput = {
  sourceUnits: PromptTranslationUnit[];
  currentTranslations: TranslationProcessorTranslation[];
  referenceSourceTexts: string[];
  referenceTranslations: string[];
  glossaryTerms: ResolvedGlossaryTerm[];
  editorFeedback: string;
  proofreaderFeedback: string;
  requirements: ReadonlyArray<string>;
  responseSchema: JsonObject;
};

function buildReviserPrompt(input: ReviserPromptInput): {
  systemPrompt: string;
  userPrompt: string;
} {
  const systemPrompt =
    "你是一位综合能力极强的文学翻译修改师，能够平衡精准性与文学表现力，\n" +
    "根据编辑和校对的意见对译文进行有针对性的改进。\n" +
    "当编辑与校对意见相互矛盾时，优先保证原文意思的准确性，其次考虑中文表达的自然流畅。";

  const lines: string[] = [];

  if (input.referenceSourceTexts.length > 0) {
    lines.push("## 参考原文（前序文段）");
    lines.push(input.referenceSourceTexts.join("\n\n"));
    lines.push("");
  }

  if (input.referenceTranslations.length > 0) {
    lines.push("## 参考译文（前序文段）");
    lines.push(input.referenceTranslations.join("\n\n"));
    lines.push("");
  }

  if (input.glossaryTerms.length > 0) {
    lines.push("## 术语表");
    lines.push(renderGlossaryFull(input.glossaryTerms));
    lines.push("");
  }

  if (input.requirements.length > 0) {
    lines.push("## 翻译要求");
    for (const req of input.requirements) {
      lines.push(`- ${req}`);
    }
    lines.push("");
  }

  lines.push("## 原文（按行编号）");
  for (const unit of input.sourceUnits) {
    lines.push(`[${unit.id}] ${unit.text}`);
  }
  lines.push("");

  lines.push("## 当前译文（按行编号）");
  for (const unit of input.currentTranslations) {
    lines.push(`[${unit.id}] ${unit.translation}`);
  }
  lines.push("");

  lines.push("## 中文编辑反馈");
  lines.push(input.editorFeedback);
  lines.push("");

  lines.push("## 校对专家反馈");
  lines.push(input.proofreaderFeedback);

  lines.push("");
  lines.push(
    "请根据中文编辑和校对专家的意见，对每行译文进行修改。\n" +
      "- 对有问题的行进行针对性修改；无问题的行保持原样输出。\n" +
      "- 当两方意见冲突时，优先保证原文意思的准确传达，同时尽量兼顾中文表达的自然流畅。\n" +
      "- 输出格式为 JSON，结构遵循所提供的 schema，每个对象包含原行 id 与修改后的 translation。",
  );

  lines.push("");
  lines.push("JSON Schema:");
  lines.push(JSON.stringify(input.responseSchema, null, 2));

  return { systemPrompt, userPrompt: lines.join("\n") };
}

// ── 工具函数 ───────────────────────────────────────────────────────────────────

function renderGlossaryFull(terms: ResolvedGlossaryTerm[]): string {
  if (terms.length === 0) return "";
  const header = "原文,译文,描述";
  const rows = terms.map((t) => {
    const desc = t.description ?? "";
    return `${escapeCsv(t.term)},${escapeCsv(t.translation)},${escapeCsv(desc)}`;
  });
  return [header, ...rows].join("\n");
}

function renderGlossaryTargetOnly(terms: ResolvedGlossaryTerm[]): string {
  if (terms.length === 0) return "";
  return terms
    .map((t) => `- ${t.translation}${t.description ? `（${t.description}）` : ""}`)
    .join("\n");
}

function escapeCsv(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
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

function buildTranslationSchema(sourceUnits: PromptTranslationUnit[]): JsonObject {
  const ids = sourceUnits.map((u) => u.id);
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      translations: {
        type: "array",
        minItems: ids.length,
        maxItems: ids.length,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", enum: ids },
            translation: { type: "string", minLength: 1 },
          },
          required: ["id", "translation"],
        },
      },
    },
    required: ["translations"],
  };
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
