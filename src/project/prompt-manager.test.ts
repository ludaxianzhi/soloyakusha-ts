import { describe, expect, test } from "bun:test";
import { PromptManager as SharedPromptManager } from "../prompts/index.ts";
import { PromptManager } from "./prompt-manager.ts";

describe("project PromptManager", () => {
  test("prefers scoped translation prompt ids when translationPromptSet is provided", async () => {
    const shared = SharedPromptManager.fromYamlText(`
version: 1
prompts:
  project.translationPipeline:
    system:
      type: static
      template: generic-system
    user:
      type: static
      template: generic-user
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
      translationPromptSet: "ja-zhCN",
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
});
