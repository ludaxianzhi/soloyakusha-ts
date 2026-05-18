import type { Glossary, ResolvedGlossaryTerm } from "../../glossary/glossary.ts";
import type { TranslationContextView } from "../context/context-view.ts";
import { PromptManager, type PromptTranslationUnit, type RenderedPrompt } from "./prompt-manager.ts";
import { TextPreProcessorRegistry } from "../../utils/text-pre-processor.ts";

export type TranslationPromptContextInput = {
  sourceText: string;
  contextView?: TranslationContextView;
  glossary?: Glossary;
  requirements?: ReadonlyArray<string>;
};

export type RenderSimpleTranslationPromptOptions = TranslationPromptContextInput & {
  promptManager?: PromptManager;
  sourceUnits?: ReadonlyArray<PromptTranslationUnit>;
};

export function splitSourceTextIntoUnits(sourceText: string): PromptTranslationUnit[] {
  return sourceText.split("\n").map((text, index) => ({
    id: (index + 1).toString(),
    text,
  }));
}

export function buildSourceUnitsFromLines(lines: ReadonlyArray<string>): PromptTranslationUnit[] {
  return lines.map((text, index) => ({
    id: (index + 1).toString(),
    text,
  }));
}

export function resolveTranslatedGlossaryTerms(
  input: TranslationPromptContextInput,
): ResolvedGlossaryTerm[] {
  if (input.contextView) {
    return input.contextView.getTranslatedGlossaryTerms();
  }

  return input.glossary?.getTranslatedTermsForText(input.sourceText) ?? [];
}

export function resolveUntranslatedGlossaryTerms(
  input: TranslationPromptContextInput,
): ResolvedGlossaryTerm[] {
  if (input.contextView) {
    return input.contextView.getUntranslatedGlossaryTerms();
  }

  return input.glossary?.getUntranslatedTermsForText(input.sourceText) ?? [];
}

export async function renderSimpleTranslationPrompt(
  options: RenderSimpleTranslationPromptOptions,
): Promise<RenderedPrompt> {
  const promptManager = options.promptManager ?? new PromptManager();
  const sourceUnits = [...(options.sourceUnits ?? splitSourceTextIntoUnits(options.sourceText))];

  return promptManager.renderTranslationStepPrompt({
    sourceUnits,
    dependencyTranslations: options.contextView?.getDependencyTranslatedTexts() ?? [],
    plotSummaries: options.contextView?.getPlotSummaryTexts() ?? [],
    translatedGlossaryTerms: resolveTranslatedGlossaryTerms(options),
    requirements: [...(options.requirements ?? [])],
  });
}

/**
 * 对滑动窗口中的原文行执行预处理。
 *
 * 将所有行用换行符连接后整体执行预处理管线，再按换行拆分回行数组，
 * 保证与 buildWorkItem 中对 request.sourceText 的预处理行为一致。
 */
export function applyPreProcessingToLines(
  lines: ReadonlyArray<string>,
  preProcessors?: ReadonlyArray<{ id: string; params?: Record<string, unknown> }>,
): string[] {
  if (!preProcessors || preProcessors.length === 0) {
    return [...lines];
  }
  const pipeline = TextPreProcessorRegistry.createPipeline([...preProcessors]);
  const joined = lines.join("\n");
  const processed = pipeline.process(joined);
  return processed.split("\n");
}
