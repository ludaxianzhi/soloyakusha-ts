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
};

type TranslationProcessorBuilder = (
  options: Omit<TranslationProcessorFactoryCreateOptions, "workflow">,
) => TranslationProcessor;

export class TranslationProcessorFactory {
  private static readonly builders = new Map<string, TranslationProcessorBuilder>([
    [
      "default",
      (options) =>
        new DefaultTranslationProcessor(options.clientResolver, {
          promptManager: options.promptManager,
          defaultRequestOptions: options.defaultRequestOptions,
          defaultSlidingWindow: options.defaultSlidingWindow,
          logger: options.logger,
          processorName: options.processorName,
          glossaryUpdater: options.glossaryUpdater,
        }),
    ],
    [
      "multi-stage",
      (options) => {
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
          reviewIterations,
        });
      },
    ],
  ]);

  static createProcessor(
    options: TranslationProcessorFactoryCreateOptions,
  ): TranslationProcessor {
    const workflow = options.workflow ?? "default";
    const builder = this.builders.get(workflow);
    if (!builder) {
      const supported = Array.from(this.builders.keys()).join(", ");
      throw new Error(`不支持的翻译流程: ${workflow}。支持的流程: ${supported}`);
    }

    return builder(options);
  }

  static registerWorkflow(
    workflow: string,
    builder: TranslationProcessorBuilder,
  ): void {
    this.builders.set(workflow, builder);
  }
}
