/**
 * 提供翻译流程处理器工厂，便于注册和切换不同工作流实现。
 *
 * @module project/translation-processor-factory
 */

import type { GlossaryUpdater } from "../glossary/updater.ts";
import type { ChatRequestOptions } from "../llm/types.ts";
import type { Logger } from "./logger.ts";
import type { PromptManager } from "./prompt-manager.ts";
import { DefaultTranslationProcessor } from "./default-translation-processor.ts";
import {
  MultiStageTranslationProcessor,
  type MultiStageStepName,
} from "./multi-stage-translation-processor.ts";
import type {
  TranslationProcessor,
  TranslationProcessorClientResolver,
} from "./translation-processor.ts";
import type { TranslationOutputRepairer } from "./translation-output-repair.ts";
import type { SlidingWindowOptions } from "./types.ts";

export type TranslationProcessorFactoryCreateOptions = {
  workflow?: string;
  clientResolver: TranslationProcessorClientResolver;
  /**
   * 各步骤的 LLM 解析器覆盖，供多步骤工作流（如 multi-stage）使用。
   * key 为步骤标识（如 "analyzer"、"translator" 等），value 为对应的 client resolver。
   */
  additionalClientResolvers?: Record<string, TranslationProcessorClientResolver>;
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
  fields: TranslationProcessorWorkflowFieldMetadata[];
};

type TranslationProcessorBuilder = (
  options: Omit<TranslationProcessorFactoryCreateOptions, "workflow">,
) => TranslationProcessor;

type TranslationProcessorWorkflowDefinition = {
  builder: TranslationProcessorBuilder;
  metadata: TranslationProcessorWorkflowMetadata;
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
          title: "默认单阶段",
          description: "使用单个模型完成译前上下文分析与翻译，配置最少，适合作为通用默认方案。",
          fields: [
            {
              key: "modelName",
              label: "默认模型",
              description: "选择执行整个翻译流程的 LLM Profile。",
              input: "llm-profile",
              required: true,
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
        },
      },
    ],
    [
      "multi-stage",
      {
        builder: (options) => {
          const stepResolvers: Partial<Record<MultiStageStepName, TranslationProcessorClientResolver>> =
            {};
          const additionalResolvers = options.additionalClientResolvers ?? {};
          for (const step of [
            "analyzer",
            "translator",
            "polisher",
            "editor",
            "proofreader",
            "reviser",
          ] as MultiStageStepName[]) {
            if (additionalResolvers[step]) {
              stepResolvers[step] = additionalResolvers[step];
            }
          }

          const reviewIterations =
            typeof options.workflowOptions?.reviewIterations === "number"
              ? options.workflowOptions.reviewIterations
              : undefined;

          return new MultiStageTranslationProcessor(options.clientResolver, stepResolvers, {
            promptManager: options.promptManager,
            defaultRequestOptions: options.defaultRequestOptions,
            defaultSlidingWindow: options.defaultSlidingWindow,
            logger: options.logger,
            processorName: options.processorName,
            glossaryUpdater: options.glossaryUpdater,
            outputRepairer: options.outputRepairer,
            reviewIterations,
          });
        },
        metadata: {
          workflow: "multi-stage",
          title: "多阶段评审",
          description:
            "先分析再翻译，并在润色、校对与修订阶段循环评审。适合追求质量和一致性的长篇项目。",
          fields: [
            {
              key: "modelName",
              label: "默认模型",
              description: "未单独覆盖步骤时，所有阶段都会使用这个 LLM Profile。",
              input: "llm-profile",
              required: true,
              section: "basic",
            },
            {
              key: "reviewIterations",
              label: "评审轮数",
              description: "多阶段工作流的回合数；未填写时使用工作流默认值。",
              input: "number",
              min: 0,
              section: "basic",
            },
            {
              key: "models",
              label: "步骤模型覆盖",
              description:
                "使用 YAML 为 analyzer / translator / polisher / editor / proofreader / reviser 指定不同的 LLM Profile。",
              input: "yaml",
              yamlShape: "string-map",
              placeholder:
                "analyzer: reasoning-model\ntranslator: default-chat\nproofreader: qa-model",
              section: "advanced",
            },
            {
              key: "slidingWindow.overlapChars",
              label: "滑窗重叠字符数",
              description: "长文本分段时保留的重叠上下文字符数。",
              input: "number",
              min: 0,
              section: "advanced",
            },
            {
              key: "requestOptions",
              label: "请求选项",
              description: "以 YAML 提供全流程共享的附加 LLM 请求参数。",
              input: "yaml",
              yamlShape: "object",
              placeholder: "temperature: 0.2\nmaxTokens: 4096",
              section: "advanced",
            },
          ],
        },
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
    return Array.from(this.workflows.values()).map((definition) =>
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
        fields: metadata.fields.map((field) => ({ ...field })),
      },
    });
  }
}

function cloneWorkflowMetadata(
  metadata: TranslationProcessorWorkflowMetadata,
): TranslationProcessorWorkflowMetadata {
  return {
    workflow: metadata.workflow,
    title: metadata.title,
    description: metadata.description,
    fields: metadata.fields.map((field) => ({ ...field })),
  };
}
