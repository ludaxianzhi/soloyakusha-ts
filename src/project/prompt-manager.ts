/**
 * 集中管理翻译 Pipeline 相关提示词，并使用 Liquid 模板渲染用户提示词。
 *
 * @module project/prompt-manager
 */

import { Liquid } from "liquidjs";
import type { ResolvedGlossaryTerm } from "../glossary/glossary.ts";
import type { JsonObject } from "../llm/types.ts";

export type PromptTranslationUnit = {
  id: string;
  text: string;
};

export type TranslationStepPromptInput = {
  sourceUnits: PromptTranslationUnit[];
  dependencyTranslations: string[];
  translatedGlossaryTerms: ResolvedGlossaryTerm[];
  untranslatedGlossaryTerms: ResolvedGlossaryTerm[];
  requirements: string[];
};

export type RenderedPrompt = {
  name: string;
  systemPrompt: string;
  userPrompt: string;
  responseSchema: JsonObject;
};

const TRANSLATION_PIPELINE_PROMPT_NAME = "translation_pipeline_result";

const TRANSLATION_PIPELINE_USER_TEMPLATE = `
你将处理一个翻译文本块，请严格按要求完成输出。

{% if requirements.size > 0 %}
额外要求：
{% for requirement in requirements %}
- {{ requirement }}
{% endfor %}

{% endif %}
原文单元：
{% for unit in sourceUnits %}
- id: {{ unit.id }}
  text: {{ unit.text }}
{% endfor %}

{% if dependencyTranslations.size > 0 %}
依赖文本块译文（仅供参考）：
{% for translation in dependencyTranslations %}
- {{ translation }}
{% endfor %}

{% endif %}
{% if translatedGlossaryTerms.size > 0 %}
可直接复用的术语表：
{% for term in translatedGlossaryTerms %}
- term: {{ term.term }}
  translation: {{ term.translation }}
  {% if term.description %}description: {{ term.description }}{% endif %}
{% endfor %}

{% endif %}
{% if untranslatedGlossaryTerms.size > 0 %}
待识别译文的未翻译术语：
{% for term in untranslatedGlossaryTerms %}
- term: {{ term.term }}
  {% if term.description %}description: {{ term.description }}{% endif %}
{% endfor %}

{% endif %}
请翻译全部原文单元，并在 glossaryUpdates 中仅填写你能从本次译文中明确识别出的未翻译术语译文。
`;

export class PromptManager {
  private readonly liquid = new Liquid();

  async renderTranslationStepPrompt(
    input: TranslationStepPromptInput,
  ): Promise<RenderedPrompt> {
    const responseSchema = buildTranslationStepResponseSchema(input);
    return {
      name: TRANSLATION_PIPELINE_PROMPT_NAME,
      systemPrompt: buildTranslationStepSystemPrompt(responseSchema),
      userPrompt: await this.liquid.parseAndRender(
        TRANSLATION_PIPELINE_USER_TEMPLATE,
        input,
      ),
      responseSchema,
    };
  }
}

function buildTranslationStepSystemPrompt(responseSchema: JsonObject): string {
  return [
    "你是翻译 Pipeline 的文本处理器。",
    "任务分为两部分，但必须在同一次输出中一起完成：",
    "1. 按原文单元逐条生成译文。",
    "2. 从本次译文中提取未翻译术语的对应译文，并写入 glossaryUpdates。",
    "如果某个未翻译术语无法从本次译文中明确识别，就不要输出它。",
    "translations 中必须与输入 id 一一对应，不能缺失、不能重复、不能新增未请求 id。",
    "glossaryUpdates 中只能返回给定未翻译术语列表中的 term，不能新增其他术语。",
    "只返回 JSON，不要输出 Markdown、解释或代码块。",
    "输出必须严格满足以下 JSON Schema：",
    JSON.stringify(responseSchema, null, 2),
  ].join("\n");
}

function buildTranslationStepResponseSchema(
  input: TranslationStepPromptInput,
): JsonObject {
  const translationIds = input.sourceUnits.map((unit) => unit.id);
  const untranslatedTerms = input.untranslatedGlossaryTerms.map((term) => term.term);

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
      glossaryUpdates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            term: {
              type: "string",
              enum: untranslatedTerms,
            },
            translation: {
              type: "string",
              minLength: 1,
            },
          },
          required: ["term", "translation"],
        },
      },
    },
    required: ["translations", "glossaryUpdates"],
  };
}
