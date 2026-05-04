import type { ChatRequestOptions } from "../../llm/types.ts";
import type { GlossaryUpdater } from "../../glossary/updater.ts";
import type { Logger } from "../logger.ts";
import type { SlidingWindowOptions } from "../types.ts";
import {
  MultiStageProofreadProcessor,
  PROOFREAD_STEP_NAMES,
  PROOFREAD_AUX_DATA_CONTRACT,
  type ProofreadProcessor,
  type ProofreadStepName,
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
          const stepResolvers: Partial<Record<ProofreadStepName, TranslationProcessorClientResolver>> = {};
          const additionalResolvers = options.additionalClientResolvers ?? {};
          for (const step of PROOFREAD_STEP_NAMES) {
            if (additionalResolvers[step]) {
              stepResolvers[step] = additionalResolvers[step];
            }
          }

          const reviewIterations =
            typeof options.workflowOptions?.reviewIterations === "number"
              ? options.workflowOptions.reviewIterations
              : undefined;

          return new MultiStageProofreadProcessor(options.clientResolver, stepResolvers, {
            promptManager: options.promptManager,
            defaultRequestOptions: options.defaultRequestOptions,
            defaultSlidingWindow: options.defaultSlidingWindow,
            logger: options.logger,
            processorName: options.processorName,
            outputRepairer: options.outputRepairer,
            reviewIterations,
            stepRequestOptions: options.stepRequestOptions,
          });
        },
        metadata: {
          workflow: "proofread-multi-stage",
          title: "日译简中校对评审",
          description: "对已有译文执行编辑、校对和修订，直接输出覆盖后的终稿。",
          sourceLanguage: "ja",
          targetLanguage: "zh-CN",
          promptSet: "ja-zhCN",
          fragmentAuxDataContract: PROOFREAD_AUX_DATA_CONTRACT,
          translatorFields: [
            {
              key: "reviewIterations",
              label: "校对轮数",
              description: "编辑/校对/修订回合数；未填写时使用工作流默认值。",
              input: "number",
              min: 1,
              section: "basic",
            },
            ...buildProofreadStepFields(),
            {
              key: "slidingWindow.overlapChars",
              label: "滑窗重叠字符数",
              description: "长文本分段校对时保留的重叠上下文字符数。",
              input: "number",
              min: 0,
              section: "advanced",
            },
          ],
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