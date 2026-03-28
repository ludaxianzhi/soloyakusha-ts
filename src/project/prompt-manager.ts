/**
 * 提供翻译 Pipeline 提示词的领域适配层，底层复用共享 YAML 提示词目录。
 *
 * @module project/prompt-manager
 */

import type { ResolvedGlossaryTerm } from "../glossary/glossary.ts";
import type { JsonObject } from "../llm/types.ts";
import {
  getDefaultPromptManager,
  type PromptManager as SharedPromptManager,
} from "../prompts/index.ts";

export type PromptTranslationUnit = {
  id: string;
  text: string;
};

export type TranslationStepPromptInput = {
  sourceUnits: PromptTranslationUnit[];
  dependencyTranslations: string[];
  plotSummaries: string[];
  translatedGlossaryTerms: ResolvedGlossaryTerm[];
  requirements: string[];
};

export type RenderedPrompt = {
  name: string;
  systemPrompt: string;
  userPrompt: string;
  responseSchema: JsonObject;
};

const TRANSLATION_PIPELINE_PROMPT_NAME = "translation_pipeline_result";
const TRANSLATION_PIPELINE_PROMPT_ID = "project.translationPipeline";

export class PromptManager {
  private readonly promptManagerPromise: Promise<SharedPromptManager>;

  constructor(options: { promptManager?: SharedPromptManager | Promise<SharedPromptManager> } = {}) {
    this.promptManagerPromise = Promise.resolve(
      options.promptManager ?? getDefaultPromptManager(),
    );
  }

  async renderTranslationStepPrompt(
    input: TranslationStepPromptInput,
  ): Promise<RenderedPrompt> {
    const responseSchema = buildTranslationStepResponseSchema(input);
    const promptManager = await this.promptManagerPromise;
    const renderedPrompt = promptManager.renderPrompt(TRANSLATION_PIPELINE_PROMPT_ID, {
      sourceUnits: input.sourceUnits,
      dependencyTranslations: input.dependencyTranslations,
      plotSummaries: input.plotSummaries,
      translatedGlossaryTerms: input.translatedGlossaryTerms,
      requirements: input.requirements,
      responseSchemaJson: JSON.stringify(responseSchema, null, 2),
    });

    return {
      name: TRANSLATION_PIPELINE_PROMPT_NAME,
      systemPrompt: renderedPrompt.systemPrompt,
      userPrompt: renderedPrompt.userPrompt,
      responseSchema,
    };
  }
}

function buildTranslationStepResponseSchema(
  input: TranslationStepPromptInput,
): JsonObject {
  const translationIds = input.sourceUnits.map((unit) => unit.id);

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      translations: {
        type: "array",
        minItems: translationIds.length,
        maxItems: translationIds.length,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              enum: translationIds,
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
