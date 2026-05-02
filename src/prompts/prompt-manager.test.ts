import { describe, expect, test } from "bun:test";
import {
  PromptManager,
  getDefaultPromptFilePath,
  getDefaultPromptManager,
  registerEmbeddedPromptCatalog,
} from "./index.ts";

describe("PromptManager", () => {
  test("loads default prompt catalog from yaml resource", async () => {
    const manager = await getDefaultPromptManager();
    const promptIds = manager.getPromptIds();

    expect(getDefaultPromptFilePath()).toEndWith("default-prompts.yaml");
    expect(promptIds).toContain("glossary.fullTextScan");
    expect(promptIds).toContain("glossary.translationUpdate");
    expect(promptIds).toContain("project.translationPipeline.ja-zhCN");
    expect(promptIds).toContain("project.multiStage.analyzer.ja-zhCN");
    expect(promptIds).toContain("project.multiStage.translator.ja-zhCN");
    expect(promptIds).toContain("project.styleTransfer.transfer.ja-zhCN");
    expect(promptIds).toContain("project.proofread.editor.ja-zhCN");
    expect(promptIds).toContain("project.proofread.reviser.ja-zhCN");
    expect(promptIds).toContain("project.chapterEditorAssistant.ja-zhCN");
    expect(promptIds).toContain("project.plotSummary");
    expect(promptIds).toContain("utils.alignmentRepair");
    expect(promptIds).not.toContain("project.translationPipeline");
    expect(promptIds).not.toContain("project.multiStage.analyzer");
    expect(promptIds).not.toContain("project.proofread.reviser");
  });

  test("renders static and interpolated prompt sections separately", () => {
    const manager = PromptManager.fromYamlText(`
version: 1
prompts:
  demo.prompt:
    system:
      type: static
      template: 固定系统提示
    user:
      type: interpolate
      template: 你好，\${name}，编号 \${meta.id}
`);

    const rendered = manager.renderPrompt("demo.prompt", {
      name: "测试用户",
      meta: { id: 7 },
    });

    expect(rendered.systemPrompt).toBe("固定系统提示");
    expect(rendered.userPrompt).toBe("你好，测试用户，编号 7");
  });

  test("loads embedded yaml catalog when the filesystem resource is unavailable", async () => {
    const virtualPath = "X:\\virtual\\embedded-prompts.yaml";
    registerEmbeddedPromptCatalog(
      virtualPath,
      `
version: 1
prompts:
  demo.embedded:
    system:
      type: static
      template: embedded system
    user:
      type: interpolate
      template: embedded user \${name}
`,
    );

    const manager = await PromptManager.fromYamlFile(virtualPath);
    const rendered = manager.renderPrompt("demo.embedded", { name: "prompt" });

    expect(manager.getPromptIds()).toEqual(["demo.embedded"]);
    expect(rendered.systemPrompt).toBe("embedded system");
    expect(rendered.userPrompt).toBe("embedded user prompt");
  });

  test("renders liquid prompt with conditionals and loops", () => {
    const manager = PromptManager.fromYamlText(`
version: 1
prompts:
  demo.liquid:
    system:
      type: static
      template: system
    user:
      type: liquid
      template: |
        标题: {{ title }}
        {% if items %}
        条目:
        {% for item in items %}
        - {{ forloop.index1 }}. {{ item.name }}
        {% endfor %}
        {% else %}
        无条目
        {% endif %}
`);

    const rendered = manager.renderPrompt("demo.liquid", {
      title: "示例",
      items: [{ name: "甲" }, { name: "乙" }],
    });

    expect(rendered.userPrompt).toContain("标题: 示例");
    expect(rendered.userPrompt).toContain("- 1. 甲");
    expect(rendered.userPrompt).toContain("- 2. 乙");
  });

  test("renders liquid prompt with empty string conditions and object serialization", () => {
    const manager = PromptManager.fromYamlText(`
version: 1
prompts:
  demo.compat:
    system:
      type: static
      template: system
    user:
      type: liquid
      template: |
        {% if missingUnitIdsText %}
        待补翻 ID: {{ missingUnitIdsText }}
        {% else %}
        无待补翻 ID
        {% endif %}
        元数据: {{ meta }}
`);

    const rendered = manager.renderPrompt("demo.compat", {
      meta: { total: 2 },
      missingUnitIdsText: "",
    });

    expect(rendered.userPrompt).toContain("无待补翻 ID");
    expect(rendered.userPrompt).toContain('"total": 2');
  });

  test("renders default alignment repair prompt without missing ids section when empty", async () => {
    const manager = await getDefaultPromptManager();

    const rendered = manager.renderPrompt("utils.alignmentRepair", {
      analysis: {
        comparisonText: "1 | SOURCE | TARGET",
        missingUnitIds: [],
        sourceLineCount: 10,
        targetLineCount: 9,
      },
      missingUnitIdsText: "",
      responseSchemaJson: '{"type":"object"}',
    });

    expect(rendered.userPrompt).not.toContain("待补翻 ID:");
    expect(rendered.userPrompt).toContain("对照表：");
    expect(rendered.systemPrompt).toContain('"type":"object"');
  });

  test("renders translation pipeline and glossary update prompts from default yaml", async () => {
    const manager = await getDefaultPromptManager();

    const translationPrompt = manager.renderPrompt("project.translationPipeline.ja-zhCN", {
      sourceUnits: [{ id: "1", text: "勇者が来た。" }],
      dependencyTranslations: ["Previous translated line"],
      translatedGlossaryTerms: [{ term: "勇者", translation: "勇者", status: "translated" }],
      requirements: ["保持术语一致"],
      responseSchemaJson: '{"type":"object","properties":{"translations":{"type":"array"}}}',
    });
    const glossaryPrompt = manager.renderPrompt("glossary.translationUpdate", {
      translationUnits: [
        { id: "1", sourceText: "勇者来到王都", translatedText: "Hero arrived at the Royal Capital" },
      ],
      untranslatedTerms: [{ term: "王都", translation: "", status: "untranslated" }],
      requirements: ["保持术语一致"],
      responseSchemaJson: '{"type":"object","properties":{"glossaryUpdates":{"type":"array"}}}',
    });

    expect(translationPrompt.systemPrompt).toContain("任务：把用户消息中提供的全部日文原文单元准确翻译成自然、流畅");
    expect(translationPrompt.systemPrompt).toContain("JSON Schema");
    expect(translationPrompt.userPrompt).toContain("日文原文单元");
    expect(translationPrompt.userPrompt).toContain("Previous translated line");
    expect(translationPrompt.userPrompt).toContain("term: 勇者");
    expect(glossaryPrompt.systemPrompt).toContain("任务：根据用户消息中提供的原文/译文对照");
    expect(glossaryPrompt.systemPrompt).toContain("JSON Schema");
    expect(glossaryPrompt.userPrompt).toContain("translatedText: Hero arrived at the Royal Capital");
    expect(glossaryPrompt.userPrompt).toContain("term: 王都");
  });

  test("renders multi-stage prompts with conditional history summaries", async () => {
    const manager = await getDefaultPromptManager();

    const analyzerPrompt = manager.renderPrompt("project.multiStage.analyzer.ja-zhCN", {
      sourceUnits: [{ id: "1", text: "勇者が扉を開けた。" }],
      referencePairs: [
        {
          id: "1",
          sourceText: "扉の先には長い廊下があった。",
          translation: "门后是一条长廊。",
        },
      ],
      plotSummaries: ["上一段：勇者已经潜入城堡。"],
      translatedGlossaryTerms: [{ term: "勇者", translation: "勇者", status: "translated" }],
      requirements: ["保持文学语气"],
    });
    const reviserPrompt = manager.renderPrompt("project.proofread.reviser.ja-zhCN", {
      sourceUnits: [{ id: "1", text: "勇者が扉を開けた。" }],
      currentTranslations: [{ id: "1", text: "勇者推开了门。" }],
      referenceSourceTexts: ["扉の先には長い廊下があった。"],
      referenceTranslations: ["门后是一条长廊。"],
      plotSummaries: ["上一段：勇者已经潜入城堡。"],
      translatedGlossaryTerms: [{ term: "勇者", translation: "勇者", status: "translated" }],
      editorFeedback: "[1] 语气可更紧凑。",
      proofreaderFeedback: "[1] 无明显误译。",
      requirements: ["保持文学语气"],
      responseSchemaJson: '{"type":"object","properties":{"translations":{"type":"array"}}}',
    });

    expect(analyzerPrompt.userPrompt).toContain("全量参考（前序文段，原文与译文合并展示）");
    expect(analyzerPrompt.userPrompt).toContain("原文: 扉の先には長い廊下があった。");
    expect(analyzerPrompt.userPrompt).toContain("译文: 门后是一条长廊。");
    expect(analyzerPrompt.userPrompt).toContain("历史总结");
    expect(analyzerPrompt.userPrompt).toContain("上一段：勇者已经潜入城堡。");
    expect(reviserPrompt.userPrompt).toContain("中文编辑反馈");
    expect(reviserPrompt.userPrompt).toContain("校对专家反馈");
    expect(reviserPrompt.userPrompt).toContain("JSON Schema");
  });

  test("renders proofreader prompt with plot summaries instead of reference source texts", async () => {
    const manager = await getDefaultPromptManager();

    const prompt = manager.renderPrompt("project.proofread.proofreader.ja-zhCN", {
      sourceUnits: [{ id: "1", text: "勇者が扉を開けた。" }],
      currentTranslations: [{ id: "1", text: "勇者推开了门。" }],
      referencePairs: [
        {
          id: "1",
          sourceText: "扉の先には長い廊下があった。",
          translation: "门后是一条长廊。",
        },
      ],
      plotSummaries: ["上一段：勇者已经潜入城堡。"],
      translatedGlossaryTerms: [{ term: "勇者", translation: "勇者", status: "translated" }],
      analysisText: "分析摘要",
      requirements: ["保持文学语气"],
    });

    expect(prompt.userPrompt).toContain("全量参考（前序文段，原文与译文合并展示）");
    expect(prompt.userPrompt).toContain("原文: 扉の先には長い廊下があった。");
    expect(prompt.userPrompt).toContain("译文: 门后是一条长廊。");
    expect(prompt.userPrompt).toContain("历史总结（用于补充参考原文对应的大纲/前情）");
    expect(prompt.userPrompt).toContain("上一段：勇者已经潜入城堡。");
  });

  test("renders ja-zhCN specialized translation prompts from default yaml", async () => {
    const manager = await getDefaultPromptManager();

    const prompt = manager.renderPrompt("project.translationPipeline.ja-zhCN", {
      sourceUnits: [{ id: "1", text: "勇者が来た。" }],
      dependencyTranslations: [],
      plotSummaries: [],
      translatedGlossaryTerms: [],
      requirements: [],
      responseSchemaJson: '{"type":"object"}',
    });

    expect(prompt.systemPrompt).toContain("日译简中文学翻译");
    expect(prompt.userPrompt).toContain("日文原文单元");
    expect(prompt.userPrompt).toContain("勇者が来た。");
  });
});
