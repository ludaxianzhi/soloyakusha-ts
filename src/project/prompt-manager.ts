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

export type MultiStageAnalyzerPromptInput = {
  sourceUnits: PromptTranslationUnit[];
  referenceSourceTexts: string[];
  referenceTranslations: string[];
  plotSummaries: string[];
  translatedGlossaryTerms: ResolvedGlossaryTerm[];
  requirements: string[];
};

export type MultiStageTranslatorPromptInput = {
  sourceUnits: PromptTranslationUnit[];
  referenceTranslations: string[];
  translatedGlossaryTerms: ResolvedGlossaryTerm[];
  analysisText: string;
  requirements: string[];
};

export type MultiStagePolisherPromptInput = {
  sourceUnits: PromptTranslationUnit[];
  currentTranslations: PromptTranslationUnit[];
  referenceTranslations: string[];
  translatedGlossaryTerms: ResolvedGlossaryTerm[];
  requirements: string[];
};

export type MultiStageEditorPromptInput = {
  currentTranslations: PromptTranslationUnit[];
  referenceTranslations: string[];
  translatedGlossaryTerms: ResolvedGlossaryTerm[];
  requirements: string[];
};

export type MultiStageProofreaderPromptInput = {
  sourceUnits: PromptTranslationUnit[];
  currentTranslations: PromptTranslationUnit[];
  referenceSourceTexts: string[];
  plotSummaries: string[];
  translatedGlossaryTerms: ResolvedGlossaryTerm[];
  analysisText: string;
  requirements: string[];
};

export type MultiStageReviserPromptInput = {
  sourceUnits: PromptTranslationUnit[];
  currentTranslations: PromptTranslationUnit[];
  referenceSourceTexts: string[];
  referenceTranslations: string[];
  plotSummaries: string[];
  translatedGlossaryTerms: ResolvedGlossaryTerm[];
  editorFeedback: string;
  proofreaderFeedback: string;
  requirements: string[];
};

export type RenderedTextPrompt = {
  name: string;
  systemPrompt: string;
  userPrompt: string;
};

export type RenderedPrompt = {
  name: string;
  systemPrompt: string;
  userPrompt: string;
  responseSchema: JsonObject;
};

const TRANSLATION_PIPELINE_PROMPT_NAME = "translation_pipeline_result";
const TRANSLATION_PIPELINE_PROMPT_ID = "project.translationPipeline";
const MULTI_STAGE_ANALYZER_PROMPT_NAME = "multi_stage_analyzer";
const MULTI_STAGE_ANALYZER_PROMPT_ID = "project.multiStage.analyzer";
const MULTI_STAGE_TRANSLATOR_PROMPT_NAME = "multi_stage_translation";
const MULTI_STAGE_TRANSLATOR_PROMPT_ID = "project.multiStage.translator";
const MULTI_STAGE_POLISHER_PROMPT_NAME = "multi_stage_polish";
const MULTI_STAGE_POLISHER_PROMPT_ID = "project.multiStage.polisher";
const MULTI_STAGE_EDITOR_PROMPT_NAME = "multi_stage_editor";
const MULTI_STAGE_EDITOR_PROMPT_ID = "project.multiStage.editor";
const MULTI_STAGE_PROOFREADER_PROMPT_NAME = "multi_stage_proofreader";
const MULTI_STAGE_PROOFREADER_PROMPT_ID = "project.multiStage.proofreader";
const MULTI_STAGE_REVISER_PROMPT_NAME = "multi_stage_revision";
const MULTI_STAGE_REVISER_PROMPT_ID = "project.multiStage.reviser";

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
    const responseSchema = buildTranslationStepResponseSchema(input.sourceUnits);
    const renderedPrompt = await this.renderPrompt(TRANSLATION_PIPELINE_PROMPT_ID, {
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

  async renderMultiStageAnalyzerPrompt(
    input: MultiStageAnalyzerPromptInput,
  ): Promise<RenderedTextPrompt> {
    const renderedPrompt = await this.renderPrompt(MULTI_STAGE_ANALYZER_PROMPT_ID, {
      sourceUnits: input.sourceUnits,
      referenceSourceTexts: input.referenceSourceTexts,
      referenceTranslations: input.referenceTranslations,
      plotSummaries: input.plotSummaries,
      translatedGlossaryTerms: input.translatedGlossaryTerms,
      requirements: input.requirements,
    });

    return {
      name: MULTI_STAGE_ANALYZER_PROMPT_NAME,
      systemPrompt: renderedPrompt.systemPrompt,
      userPrompt: renderedPrompt.userPrompt,
    };
  }

  async renderMultiStageTranslatorPrompt(
    input: MultiStageTranslatorPromptInput,
  ): Promise<RenderedPrompt> {
    const responseSchema = buildTranslationStepResponseSchema(input.sourceUnits);
    const renderedPrompt = await this.renderPrompt(MULTI_STAGE_TRANSLATOR_PROMPT_ID, {
      sourceUnits: input.sourceUnits,
      referenceTranslations: input.referenceTranslations,
      translatedGlossaryTerms: input.translatedGlossaryTerms,
      analysisText: input.analysisText,
      requirements: input.requirements,
      responseSchemaJson: JSON.stringify(responseSchema, null, 2),
    });

    return {
      name: MULTI_STAGE_TRANSLATOR_PROMPT_NAME,
      systemPrompt: renderedPrompt.systemPrompt,
      userPrompt: renderedPrompt.userPrompt,
      responseSchema,
    };
  }

  async renderMultiStagePolisherPrompt(
    input: MultiStagePolisherPromptInput,
  ): Promise<RenderedPrompt> {
    const responseSchema = buildTranslationStepResponseSchema(input.sourceUnits);
    const renderedPrompt = await this.renderPrompt(MULTI_STAGE_POLISHER_PROMPT_ID, {
      sourceUnits: input.sourceUnits,
      currentTranslations: input.currentTranslations,
      referenceTranslations: input.referenceTranslations,
      translatedGlossaryTerms: input.translatedGlossaryTerms,
      requirements: input.requirements,
      responseSchemaJson: JSON.stringify(responseSchema, null, 2),
    });

    return {
      name: MULTI_STAGE_POLISHER_PROMPT_NAME,
      systemPrompt: renderedPrompt.systemPrompt,
      userPrompt: renderedPrompt.userPrompt,
      responseSchema,
    };
  }

  async renderMultiStageEditorPrompt(
    input: MultiStageEditorPromptInput,
  ): Promise<RenderedTextPrompt> {
    const renderedPrompt = await this.renderPrompt(MULTI_STAGE_EDITOR_PROMPT_ID, {
      currentTranslations: input.currentTranslations,
      referenceTranslations: input.referenceTranslations,
      translatedGlossaryTerms: input.translatedGlossaryTerms,
      requirements: input.requirements,
    });

    return {
      name: MULTI_STAGE_EDITOR_PROMPT_NAME,
      systemPrompt: renderedPrompt.systemPrompt,
      userPrompt: renderedPrompt.userPrompt,
    };
  }

  async renderMultiStageProofreaderPrompt(
    input: MultiStageProofreaderPromptInput,
  ): Promise<RenderedTextPrompt> {
    const renderedPrompt = await this.renderPrompt(MULTI_STAGE_PROOFREADER_PROMPT_ID, {
      sourceUnits: input.sourceUnits,
      currentTranslations: input.currentTranslations,
      referenceSourceTexts: input.referenceSourceTexts,
      plotSummaries: input.plotSummaries,
      translatedGlossaryTerms: input.translatedGlossaryTerms,
      analysisText: input.analysisText,
      requirements: input.requirements,
    });

    return {
      name: MULTI_STAGE_PROOFREADER_PROMPT_NAME,
      systemPrompt: renderedPrompt.systemPrompt,
      userPrompt: renderedPrompt.userPrompt,
    };
  }

  async renderMultiStageReviserPrompt(
    input: MultiStageReviserPromptInput,
  ): Promise<RenderedPrompt> {
    const responseSchema = buildTranslationStepResponseSchema(input.sourceUnits);
    const renderedPrompt = await this.renderPrompt(MULTI_STAGE_REVISER_PROMPT_ID, {
      sourceUnits: input.sourceUnits,
      currentTranslations: input.currentTranslations,
      referenceSourceTexts: input.referenceSourceTexts,
      referenceTranslations: input.referenceTranslations,
      plotSummaries: input.plotSummaries,
      translatedGlossaryTerms: input.translatedGlossaryTerms,
      editorFeedback: input.editorFeedback,
      proofreaderFeedback: input.proofreaderFeedback,
      requirements: input.requirements,
      responseSchemaJson: JSON.stringify(responseSchema, null, 2),
    });

    return {
      name: MULTI_STAGE_REVISER_PROMPT_NAME,
      systemPrompt: renderedPrompt.systemPrompt,
      userPrompt: renderedPrompt.userPrompt,
      responseSchema,
    };
  }

  private async renderPrompt(
    promptId: string,
    variables: Record<string, unknown>,
  ): Promise<{ systemPrompt: string; userPrompt: string }> {
    const promptManager = await this.promptManagerPromise;
    return promptManager.renderPrompt(promptId, variables);
  }
}

function buildTranslationStepResponseSchema(
  sourceUnits: ReadonlyArray<PromptTranslationUnit>,
): JsonObject {
  const translationIds = sourceUnits.map((unit) => unit.id);

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
