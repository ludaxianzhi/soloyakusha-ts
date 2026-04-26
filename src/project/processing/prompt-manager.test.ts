import { describe, expect, test } from "bun:test";
import { PromptManager as SharedPromptManager } from "../../prompts/index.ts";
import { PromptManager } from "./prompt-manager.ts";

describe("project PromptManager", () => {
  test("defaults to ja-zhCN scoped translation prompt ids", async () => {
    const shared = SharedPromptManager.fromYamlText(`
version: 1
prompts:
  project.translationPipeline.ja-zhCN:
    system:
      type: static
      template: scoped-system
    user:
      type: liquid
      template: |
        scoped-user
        {% for unit in sourceUnits %}
        - {{ unit.text }}
        {% endfor %}
`);

    const manager = new PromptManager({
      promptManager: shared,
    });

    const rendered = await manager.renderTranslationStepPrompt({
      sourceUnits: [{ id: "1", text: "こんにちは" }],
      dependencyTranslations: [],
      plotSummaries: [],
      translatedGlossaryTerms: [],
      requirements: [],
    });

    expect(rendered.systemPrompt).toBe("scoped-system");
    expect(rendered.userPrompt).toContain("scoped-user");
    expect(rendered.userPrompt).toContain("こんにちは");
  });

  test("throws when the configured prompt set does not exist", async () => {
    const shared = SharedPromptManager.fromYamlText(`
version: 1
prompts:
  project.translationPipeline.ja-zhCN:
    system:
      type: static
      template: scoped-system
    user:
      type: static
      template: scoped-user
`);

    const manager = new PromptManager({
      promptManager: shared,
      translationPromptSet: "en-zhCN",
    });

    await expect(
      manager.renderTranslationStepPrompt({
        sourceUnits: [{ id: "1", text: "hello" }],
        dependencyTranslations: [],
        plotSummaries: [],
        translatedGlossaryTerms: [],
        requirements: [],
      }),
    ).rejects.toThrow("project.translationPipeline.en-zhCN");
  });

  test("renders translation step prompts without schema id enums", async () => {
    const manager = new PromptManager();

    const rendered = await manager.renderTranslationStepPrompt({
      sourceUnits: [
        { id: "1", text: "第一行" },
        { id: "2", text: "第二行" },
      ],
      dependencyTranslations: [],
      plotSummaries: [],
      translatedGlossaryTerms: [],
      requirements: [],
    });

    expect(rendered.responseSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        translations: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: {
                type: "string",
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
    });
    expect(JSON.stringify(rendered.responseSchema)).not.toContain('"enum"');
  });

  test("renders proofread proofreader prompts without analysis context", async () => {
    const shared = SharedPromptManager.fromYamlText(`
version: 1
prompts:
  project.proofread.proofreader.ja-zhCN:
    system:
      type: static
      template: proofread-system
    user:
      type: liquid
      template: |
        proofread-user
        {% for unit in sourceUnits %}
        - {{ unit.text }}
        {% endfor %}
        {% for unit in currentTranslations %}
        - {{ unit.text }}
        {% endfor %}
`);

    const manager = new PromptManager({
      promptManager: shared,
    });

    const rendered = await manager.renderProofreadProofreaderPrompt({
      sourceUnits: [{ id: "1", text: "原文" }],
      currentTranslations: [{ id: "1", text: "译文" }],
      referenceSourceTexts: [],
      plotSummaries: [],
      translatedGlossaryTerms: [],
      requirements: [],
    });

    expect(rendered.systemPrompt).toBe("proofread-system");
    expect(rendered.userPrompt).toContain("proofread-user");
    expect(rendered.userPrompt).toContain("原文");
    expect(rendered.userPrompt).toContain("译文");
  });
});
