/**
 * 提供翻译流程处理器工厂，便于注册和切换不同工作流实现。
 *
 * @module project/translation-processor-factory
 */

import type { GlossaryUpdater } from "../../glossary/updater.ts";
import type { ChatRequestOptions } from "../../llm/types.ts";
import type { Logger } from "../logger.ts";
import type { PromptManager } from "./prompt-manager.ts";
import { DefaultTranslationProcessor } from "./default-translation-processor.ts";
import {
  StyleTransferTranslationProcessor,
  STYLE_TRANSFER_STEP_NAMES,
  STYLE_TRANSFER_AUX_DATA_CONTRACT,
  type StyleTransferStepName,
} from "./style-transfer-translation-processor.ts";
import {
  MultiStageTranslationProcessor,
  MULTI_STAGE_STEP_NAMES,
  type MultiStageStepName,
} from "./multi-stage-translation-processor.ts";
import type {
  TranslationProcessor,
  TranslationProcessorClientResolver,
} from "./translation-processor.ts";
import type { TranslationOutputRepairer } from "./translation-output-repair.ts";
import type { SlidingWindowOptions } from "../types.ts";

export type TranslationProcessorFactoryCreateOptions = {
  workflow?: string;
  clientResolver: TranslationProcessorClientResolver;
  /**
   * 各步骤的 LLM 解析器覆盖，供多步骤工作流（如 multi-stage）使用。
   * key 为步骤标识（如 "analyzer"、"translator" 等），value 为对应的 client resolver。
   */
  additionalClientResolvers?: Record<string, TranslationProcessorClientResolver>;
  /**
   * 多步骤工作流各步骤的请求选项覆盖。
   */
  stepRequestOptions?: Partial<Record<StyleTransferStepName, ChatRequestOptions>>;
  /**
   * 工作流专用选项，供特定工作流读取（如 multi-stage 的 reviewIterations）。
   */
  workflowOptions?: Record<string, unknown>;
  promptManager?: PromptManager;
  defaultRequestOptions?: ChatRequestOptions;
  defaultSlidingWindow?: SlidingWindowOptions;
  logger?: Logger;
  processorName?: string;
  glossaryUpdater?: GlossaryUpdater;
  outputRepairer?: TranslationOutputRepairer;
};

export type TranslationProcessorWorkflowFieldInput =
  | "llm-profile"
  | "number"
  | "text"
  | "textarea"
  | "yaml";

export type TranslationProcessorWorkflowFieldMetadata = {
  key: string;
  label: string;
  description?: string;
  input: TranslationProcessorWorkflowFieldInput;
  yamlShape?: "object" | "string-map";
  required?: boolean;
  min?: number;
  placeholder?: string;
  section?: "basic" | "advanced";
};

export type TranslationProcessorWorkflowMetadata = {
  workflow: string;
  title: string;
  description?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  promptSet?: string;
  translatorFields: TranslationProcessorWorkflowFieldMetadata[];
  workspaceFields?: TranslationProcessorWorkflowFieldMetadata[];
  /** @deprecated 兼容旧前端；等迁移完成后可移除。 */
  fields?: TranslationProcessorWorkflowFieldMetadata[];
  /** 该工作流对文本块辅助数据的提供/消费契约声明。 */
  fragmentAuxDataContract?: import("../types.ts").FragmentAuxDataContract;
};

type TranslationProcessorBuilder = (
  options: Omit<TranslationProcessorFactoryCreateOptions, "workflow">,
) => TranslationProcessor;

type TranslationProcessorWorkflowDefinition = {
  builder: TranslationProcessorBuilder;
  metadata: TranslationProcessorWorkflowMetadata;
  listed?: boolean;
};

export class TranslationProcessorFactory {
  private static readonly workflows = new Map<string, TranslationProcessorWorkflowDefinition>([
    [
      "default",
      {
        builder: (options) =>
          new DefaultTranslationProcessor(options.clientResolver, {
            promptManager: options.promptManager,
            defaultRequestOptions: options.defaultRequestOptions,
            defaultSlidingWindow: options.defaultSlidingWindow,
            logger: options.logger,
            processorName: options.processorName,
            glossaryUpdater: options.glossaryUpdater,
            outputRepairer: options.outputRepairer,
          }),
        metadata: {
          workflow: "default",
          title: "日译简中单阶段",
          description: "使用 ja -> zh-CN 专用提示词完成单阶段翻译，配置最少，适合作为基础方案。",
          sourceLanguage: "ja",
          targetLanguage: "zh-CN",
          promptSet: "ja-zhCN",
          translatorFields: [
            {
              key: "modelNames",
              label: "默认模型链",
              description: "按顺序选择执行整个翻译流程的 LLM Profile，后面的模型会作为前面的回退。",
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
              key: "slidingWindow.overlapChars",
              label: "滑窗重叠字符数",
              description: "为长文本启用上下文滑窗时，控制相邻窗口重叠的字符数。",
              input: "number",
              min: 0,
              section: "advanced",
            },
            {
              key: "requestOptions",
              label: "请求选项",
              description: "以 YAML 提供发送给 LLM 的附加请求参数，例如温度、top_p 等。",
              input: "yaml",
              yamlShape: "object",
              placeholder: "temperature: 0.2\ntop_p: 0.95",
              section: "advanced",
            },
          ],
          workspaceFields: [],
        },
      },
    ],
    [
      "style-transfer",
      {
        builder: (options) => {
          const stepResolvers: Partial<Record<StyleTransferStepName, TranslationProcessorClientResolver>> =
            {};
          const additionalResolvers = options.additionalClientResolvers ?? {};
          for (const step of STYLE_TRANSFER_STEP_NAMES) {
            if (additionalResolvers[step]) {
              stepResolvers[step] = additionalResolvers[step];
            }
          }

          return new StyleTransferTranslationProcessor(options.clientResolver, stepResolvers, {
            promptManager: options.promptManager,
            defaultRequestOptions: options.defaultRequestOptions,
            defaultSlidingWindow: options.defaultSlidingWindow,
            logger: options.logger,
            processorName: options.processorName,
            glossaryUpdater: options.glossaryUpdater,
            outputRepairer: options.outputRepairer,
            stepRequestOptions: options.stepRequestOptions,
          });
        },
        metadata: {
          workflow: "style-transfer",
          title: "风格迁移翻译器",
          description:
            "先分析再初译，最后执行风格迁移润色的三步式日译简中工作流。",
          sourceLanguage: "ja",
          targetLanguage: "zh-CN",
          promptSet: "ja-zhCN",
          fragmentAuxDataContract: STYLE_TRANSFER_AUX_DATA_CONTRACT,
          translatorFields: [
            {
              key: "maxConcurrentWorkItems",
              label: "文本块并发数",
              description: "同时处理多少个文本块；未填写时会根据相关 LLM Profile 的并发上限自动推断。",
              input: "number",
              min: 1,
              section: "basic",
            },
            ...buildStyleTransferStepFields(),
            {
              key: "slidingWindow.overlapChars",
              label: "滑窗重叠字符数",
              description: "长文本分段时保留的重叠上下文字符数。",
              input: "number",
              min: 0,
              section: "advanced",
            },
          ],
          workspaceFields: [
            {
              key: "styleRequirementsText",
              label: "风格要求",
              description: "仅对风格迁移阶段生效，会被注入系统提示词以约束最终译文风格。",
              input: "textarea",
              placeholder: "例如：整体口语化，避免半文言句式，角色对话保留轻小说感。",
              section: "basic",
            },
          ],
        },
      },
    ],
    [
      "multi-stage",
      {
        builder: (options) =>
          new MultiStageTranslationProcessor(options.clientResolver, {}, {
            promptManager: options.promptManager,
            defaultRequestOptions: options.defaultRequestOptions,
            defaultSlidingWindow: options.defaultSlidingWindow,
            logger: options.logger,
            processorName: options.processorName,
            glossaryUpdater: options.glossaryUpdater,
            outputRepairer: options.outputRepairer,
            stepRequestOptions: options.stepRequestOptions,
          }),
        metadata: {
          workflow: "multi-stage",
          title: "兼容旧多阶段翻译器",
          description: "仅用于兼容旧配置；新建翻译器请使用 style-transfer。",
          sourceLanguage: "ja",
          targetLanguage: "zh-CN",
          promptSet: "ja-zhCN",
          translatorFields: buildMultiStageLegacyFields(),
          workspaceFields: [],
        },
        listed: false,
      },
    ],
  ]);

  static createProcessor(
    options: TranslationProcessorFactoryCreateOptions,
  ): TranslationProcessor {
    const workflow = options.workflow ?? "default";
    const definition = this.workflows.get(workflow);
    if (!definition) {
      const supported = Array.from(this.workflows.keys()).join(", ");
      throw new Error(`不支持的翻译流程: ${workflow}。支持的流程: ${supported}`);
    }

    return definition.builder(options);
  }

  static listWorkflowMetadata(): TranslationProcessorWorkflowMetadata[] {
    return Array.from(this.workflows.values())
      .filter((definition) => definition.listed !== false)
      .map((definition) =>
      cloneWorkflowMetadata(definition.metadata),
    );
  }

  static getWorkflowMetadata(
    workflow: string,
  ): TranslationProcessorWorkflowMetadata | undefined {
    const definition = this.workflows.get(workflow);
    return definition ? cloneWorkflowMetadata(definition.metadata) : undefined;
  }

  static registerWorkflow(
    workflow: string,
    builder: TranslationProcessorBuilder,
    metadata: Omit<TranslationProcessorWorkflowMetadata, "workflow">,
  ): void {
    this.workflows.set(workflow, {
      builder,
      metadata: {
        workflow,
        title: metadata.title,
        description: metadata.description,
        sourceLanguage: metadata.sourceLanguage,
        targetLanguage: metadata.targetLanguage,
        promptSet: metadata.promptSet,
        translatorFields: metadata.translatorFields.map((field) => ({ ...field })),
        workspaceFields: metadata.workspaceFields?.map((field) => ({ ...field })) ?? [],
      },
      listed: true,
    });
  }
}

function cloneWorkflowMetadata(
  metadata: TranslationProcessorWorkflowMetadata,
): TranslationProcessorWorkflowMetadata {
  const translatorFields = metadata.translatorFields.map((field) => ({ ...field }));
  const workspaceFields = metadata.workspaceFields?.map((field) => ({ ...field })) ?? [];

  return {
    workflow: metadata.workflow,
    title: metadata.title,
    description: metadata.description,
    sourceLanguage: metadata.sourceLanguage,
    targetLanguage: metadata.targetLanguage,
    promptSet: metadata.promptSet,
    translatorFields,
    workspaceFields,
    fields: translatorFields.map((field) => ({ ...field })),
  };
}

function buildMultiStageStepFields(): TranslationProcessorWorkflowFieldMetadata[] {
  return MULTI_STAGE_STEP_NAMES.flatMap((step) => {
    const stepLabel = getMultiStageStepLabel(step);
    return [
      {
        key: `steps.${step}.modelNames`,
        label: `${stepLabel}模型链`,
        description: `${stepLabel}阶段按顺序选择的 LLM Profile，后面的模型会作为前面的回退。`,
        input: "llm-profile" as const,
        required: true,
        section: "basic" as const,
      },
      {
        key: `steps.${step}.requestOptions`,
        label: `${stepLabel}请求选项`,
        description: `${stepLabel}阶段专用的附加请求参数，例如 temperature、topP 等。`,
        input: "yaml" as const,
        yamlShape: "object" as const,
        placeholder: "temperature: 0.2\nmaxTokens: 4096",
        section: "advanced" as const,
      },
    ];
  });
}

function buildStyleTransferStepFields(): TranslationProcessorWorkflowFieldMetadata[] {
  return STYLE_TRANSFER_STEP_NAMES.flatMap((step) => {
    const stepLabel = getStyleTransferStepLabel(step);
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

function buildMultiStageLegacyFields(): TranslationProcessorWorkflowFieldMetadata[] {
  return [
    {
      key: "reviewIterations",
      label: "评审轮数",
      description: "旧多阶段工作流兼容字段。",
      input: "number",
      min: 0,
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
    ...buildMultiStageStepFields(),
    {
      key: "slidingWindow.overlapChars",
      label: "滑窗重叠字符数",
      description: "长文本分段时保留的重叠上下文字符数。",
      input: "number",
      min: 0,
      section: "advanced",
    },
  ];
}

function getStyleTransferStepLabel(step: StyleTransferStepName): string {
  switch (step) {
    case "analyzer":
      return "分析器";
    case "translator":
      return "翻译器";
    case "styleTransfer":
      return "风格迁移器";
  }
}

function getMultiStageStepLabel(step: MultiStageStepName): string {
  switch (step) {
    case "analyzer":
      return "分析器";
    case "translator":
      return "翻译器";
    case "editor":
      return "编辑器";
    case "proofreader":
      return "校对器";
    case "reviser":
      return "聚合器";
  }
}
