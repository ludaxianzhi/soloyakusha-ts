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
import type {
  TranslationProcessor,
  TranslationProcessorClientResolver,
} from "./translation-processor.ts";
import type { SlidingWindowOptions } from "./types.ts";

export type TranslationProcessorFactoryCreateOptions = {
  workflow?: string;
  clientResolver: TranslationProcessorClientResolver;
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
