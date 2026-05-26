import type { ChatRequestOptions } from "../../llm/types.ts";
import type { GlossaryUpdater } from "../../glossary/updater.ts";
import type { Logger } from "../logger.ts";
import type { SlidingWindowOptions } from "../types.ts";
import {
  ConsistencyCheckProofreadProcessor,
  MultiStageProofreadProcessor,
  PROOFREAD_STEP_NAMES,
  PROOFREAD_AUX_DATA_CONTRACT,
  ReviewProofreadProcessor,
  type ProofreadProcessor,
  type ProofreadStepName,
  SingleStepProofreadProcessor,
} from "./proofread-processor.ts";
import type { PromptManager } from "./prompt-manager.ts";
import type { TranslationProcessorClientResolver } from "./translation-processor.ts";
import type { TranslationOutputRepairer } from "./translation-output-repair.ts";
import type {
  TranslationProcessorWorkflowFieldMetadata,
  TranslationProcessorWorkflowMetadata,
} from "./translation-processor-factory.ts";

export type ProofreadProcessorFactoryCreateOptions = {
  workflow?: string;
  clientResolver: TranslationProcessorClientResolver;
  additionalClientResolvers?: Record<string, TranslationProcessorClientResolver>;
  stepRequestOptions?: Partial<Record<ProofreadStepName, ChatRequestOptions>>;
  workflowOptions?: Record<string, unknown>;
  promptManager?: PromptManager;
  defaultRequestOptions?: ChatRequestOptions;
  defaultSlidingWindow?: SlidingWindowOptions;
  logger?: Logger;
  processorName?: string;
  glossaryUpdater?: GlossaryUpdater;
  outputRepairer?: TranslationOutputRepairer;
};

type ProofreadProcessorBuilder = (
  options: Omit<ProofreadProcessorFactoryCreateOptions, "workflow">,
) => ProofreadProcessor;

type ProofreadProcessorWorkflowDefinition = {
  builder: ProofreadProcessorBuilder;
  metadata: TranslationProcessorWorkflowMetadata;
};

export class ProofreadProcessorFactory {
  private static readonly workflows = new Map<string, ProofreadProcessorWorkflowDefinition>([
    [
      "proofread-multi-stage",
      {
        builder: (options) => {
          const minCommentLevel =
            typeof options.workflowOptions?.minCommentLevel === "number"
              ? options.workflowOptions.minCommentLevel
              : undefined;

          return new ReviewProofreadProcessor(options.clientResolver, {
            promptManager: options.promptManager,
            defaultRequestOptions: options.defaultRequestOptions,
            defaultSlidingWindow: options.defaultSlidingWindow,
            logger: options.logger,
            processorName: options.processorName,
            minCommentLevel,
          });
        },
        metadata: {
          workflow: "proofread-multi-stage",
          title: "日译简中校对评审",
          description: "对已有译文逐句按 10 级标准评审，输出质量问题评级和修改建议。",
          sourceLanguage: "ja",
          targetLanguage: "zh-CN",
          promptSet: "ja-zhCN",
          fragmentAuxDataContract: PROOFREAD_AUX_DATA_CONTRACT,
          translatorFields: [
            {
              key: "minCommentLevel",
              label: "最低问题等级",
              description: "仅输出大于等于该等级的评论到 comment 字段；1 级表示所有非 0 级问题都输出（默认），4 级表示只输出较严重的问题。",
              input: "select",
              options: [
                { label: "1 级（全部）", value: "1" },
                { label: "2 级", value: "2" },
                { label: "3 级", value: "3" },
                { label: "4 级（仅较严重）", value: "4" },
              ],
              section: "basic",
            },
            {
              key: "slidingWindow.overlapChars",
              label: "滑窗重叠字符数",
              description: "长文本分段评审时保留的重叠上下文字符数。",
              input: "number",
              min: 0,
              section: "advanced",
            },
          ],
          workspaceFields: [],
        },
      },
    ],
    [
      "proofread-consistency-check",
      {
        builder: (options) => {
          const includeReason =
            typeof options.workflowOptions?.includeReason === "boolean"
              ? options.workflowOptions.includeReason
              : undefined;

          return new ConsistencyCheckProofreadProcessor(options.clientResolver, {
            promptManager: options.promptManager,
            defaultRequestOptions: options.defaultRequestOptions,
            defaultSlidingWindow: options.defaultSlidingWindow,
            logger: options.logger,
            processorName: options.processorName,
            outputRepairer: options.outputRepairer,
            maxSourceChars:
              typeof options.workflowOptions?.maxSourceChars === "number"
                ? options.workflowOptions.maxSourceChars
                : undefined,
            maxAdditionalRelatedContexts:
              typeof options.workflowOptions?.maxAdditionalRelatedContexts === "number"
                ? options.workflowOptions.maxAdditionalRelatedContexts
                : undefined,
            randomContextCount:
              typeof options.workflowOptions?.randomContextCount === "number"
                ? options.workflowOptions.randomContextCount
                : undefined,
            includeReason,
          });
        },
        metadata: {
          workflow: "proofread-consistency-check",
          title: "一致性检查校对",
          description: "基于章节拓扑前序分片和上下文网络，检查称谓、术语、口吻与事实一致性。",
          sourceLanguage: "ja",
          targetLanguage: "zh-CN",
          promptSet: "ja-zhCN",
          fragmentAuxDataContract: PROOFREAD_AUX_DATA_CONTRACT,
          translatorFields: [
            {
              key: "modelNames",
              label: "模型链",
              description: "一致性检查阶段按顺序选择的 LLM Profile，后面的模型会作为前面的回退。",
              input: "llm-profile",
              required: true,
              section: "basic",
            },
            {
              key: "maxSourceChars",
              label: "单次最大原文字符数",
              description: "超过该值时会拆分为更小批次；最小值为 4096。",
              input: "number",
              min: 4096,
              section: "basic",
            },
            {
              key: "maxAdditionalRelatedContexts",
              label: "相关上下文数量",
              description: "从上下文网络中额外注入的前序高相关分片数量。",
              input: "number",
              min: 0,
              section: "basic",
            },
            {
              key: "randomContextCount",
              label: "随机上下文数量",
              description: "从章节拓扑前序分片中随机补充的上下文数量。",
              input: "number",
              min: 0,
              section: "basic",
            },
            {
              key: "includeReason",
              label: "输出修改理由（reason）",
              description: "是否在 LLM 响应中包含 reason 字段；关闭后可节省 Token。",
              input: "switch",
              section: "advanced",
            },
            {
              key: "requestOptions",
              label: "请求选项",
              description: "附加请求参数，例如 temperature、topP 等。",
              input: "yaml",
              yamlShape: "object",
              placeholder: "temperature: 0.1\nmaxTokens: 4096",
              section: "advanced",
            },
          ],
          workspaceFields: [],
        },
      },
    ],
    [
      "proofread-editor-only",
      {
        builder: (options) => {
          const includeReason =
            typeof options.workflowOptions?.includeReason === "boolean"
              ? options.workflowOptions.includeReason
              : undefined;
          const includeSourceText =
            typeof options.workflowOptions?.includeSourceText === "boolean"
              ? options.workflowOptions.includeSourceText
              : undefined;

          return new SingleStepProofreadProcessor(options.clientResolver, {
            promptManager: options.promptManager,
            defaultRequestOptions: options.defaultRequestOptions,
            defaultSlidingWindow: options.defaultSlidingWindow,
            logger: options.logger,
            processorName: options.processorName,
            outputRepairer: options.outputRepairer,
            step: "editor",
            includeReason,
            includeSourceText,
          });
        },
        metadata: {
          workflow: "proofread-editor-only",
          title: "单步编辑校对",
          description: "只运行原校对评审流程中的“编辑”步骤，适合做润色和译风修订。",
          sourceLanguage: "ja",
          targetLanguage: "zh-CN",
          promptSet: "ja-zhCN",
          fragmentAuxDataContract: PROOFREAD_AUX_DATA_CONTRACT,
          translatorFields: [
            ...buildSingleStepProofreadFields(),
            {
              key: "includeSourceText",
              label: "注入原文",
              description: "关闭后只注入待校对译文，不显示日文原文。",
              input: "switch",
              section: "advanced",
            },
          ],
          workspaceFields: [],
        },
      },
    ],
    [
      "proofread-proofreader-only",
      {
        builder: (options) => {
          const includeReason =
            typeof options.workflowOptions?.includeReason === "boolean"
              ? options.workflowOptions.includeReason
              : undefined;

          return new SingleStepProofreadProcessor(options.clientResolver, {
            promptManager: options.promptManager,
            defaultRequestOptions: options.defaultRequestOptions,
            defaultSlidingWindow: options.defaultSlidingWindow,
            logger: options.logger,
            processorName: options.processorName,
            outputRepairer: options.outputRepairer,
            step: "proofreader",
            includeReason,
          });
        },
        metadata: {
          workflow: "proofread-proofreader-only",
          title: "单步校对校验",
          description: "只运行原校对评审流程中的“校对”步骤，适合做事实性和细节纠错。",
          sourceLanguage: "ja",
          targetLanguage: "zh-CN",
          promptSet: "ja-zhCN",
          fragmentAuxDataContract: PROOFREAD_AUX_DATA_CONTRACT,
          translatorFields: buildSingleStepProofreadFields(),
          workspaceFields: [],
        },
      },
    ],
  ]);

  static createProcessor(
    options: ProofreadProcessorFactoryCreateOptions,
  ): ProofreadProcessor {
    const workflow = options.workflow ?? "proofread-multi-stage";
    const definition = this.workflows.get(workflow);
    if (!definition) {
      const supported = Array.from(this.workflows.keys()).join(", ");
      throw new Error(`不支持的校对流程: ${workflow}。支持的流程: ${supported}`);
    }

    return definition.builder(options);
  }

  static listWorkflowMetadata(): TranslationProcessorWorkflowMetadata[] {
    return Array.from(this.workflows.values()).map((definition) => ({
      ...definition.metadata,
      translatorFields: definition.metadata.translatorFields.map((field) => ({ ...field })),
      workspaceFields: definition.metadata.workspaceFields?.map((field) => ({ ...field })) ?? [],
      fields: definition.metadata.translatorFields.map((field) => ({ ...field })),
    }));
  }
}

function buildProofreadStepFields(): TranslationProcessorWorkflowFieldMetadata[] {
  return PROOFREAD_STEP_NAMES.flatMap((step) => {
    const stepLabel = getProofreadStepLabel(step);
    return [
      {
        key: `steps.${step}.modelNames`,
        label: `${stepLabel}模型链`,
        description: `${stepLabel}阶段按顺序选择的 LLM Profile，后面的模型会作为前面的回退。`,
        input: "llm-profile",
        required: true,
        section: "basic",
      },
      {
        key: `steps.${step}.requestOptions`,
        label: `${stepLabel}请求选项`,
        description: `${stepLabel}阶段专用的附加请求参数，例如 temperature、topP 等。`,
        input: "yaml",
        yamlShape: "object",
        placeholder: "temperature: 0.2\nmaxTokens: 4096",
        section: "advanced",
      },
    ];
  });
}

function getProofreadStepLabel(step: ProofreadStepName): string {
  switch (step) {
    case "editor":
      return "编辑器";
    case "proofreader":
      return "校对器";
  }
}

function buildStepIncludeReasonFields(): TranslationProcessorWorkflowFieldMetadata[] {
  return PROOFREAD_STEP_NAMES.flatMap((step) => {
    const stepLabel = getProofreadStepLabel(step);
    return [
      {
        key: `steps.${step}.includeReason`,
        label: `${stepLabel}输出理由`,
        description: `${stepLabel}阶段单独控制是否输出 reason 字段；未设置时跟随全局开关。`,
        input: "switch",
        section: "advanced",
      },
    ];
  });
}

function buildSingleStepProofreadFields(): TranslationProcessorWorkflowFieldMetadata[] {
  return [
    {
      key: "modelNames",
      label: "模型链",
      description: "按顺序选择执行该单步校对流程的 LLM Profile，后面的模型会作为前面的回退。",
      input: "llm-profile",
      required: true,
      section: "basic",
    },
    {
      key: "maxConcurrentWorkItems",
      label: "文本块并发数",
      description: "同时处理多少个文本块；未填写时会根据相关 LLM Profile 的并发上限自动推断。",
      input: "number",
      min: 1,
      section: "basic",
    },
    {
      key: "includeReason",
      label: "输出修改理由（reason）",
      description: "是否在 LLM 响应中包含 reason 字段；关闭后可节省 Token。",
      input: "switch",
      section: "advanced",
    },
    {
      key: "slidingWindow.overlapChars",
      label: "滑窗重叠字符数",
      description: "长文本分段校对时保留的重叠上下文字符数。",
      input: "number",
      min: 0,
      section: "advanced",
    },
    {
      key: "requestOptions",
      label: "请求选项",
      description: "附加请求参数，例如 temperature、topP 等。",
      input: "yaml",
      yamlShape: "object",
      placeholder: "temperature: 0.2\nmaxTokens: 4096",
      section: "advanced",
    },
  ];
}