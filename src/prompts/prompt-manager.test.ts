import { describe, expect, test } from "bun:test";
import {
  PromptManager,
  getDefaultPromptFilePath,
  getDefaultPromptManager,
} from "./index.ts";

describe("PromptManager", () => {
  test("loads default prompt catalog from yaml resource", async () => {
    const manager = await getDefaultPromptManager();

    expect(getDefaultPromptFilePath()).toEndWith("default-prompts.yaml");
    expect(manager.getPromptIds()).toContain("glossary.fullTextScan");
    expect(manager.getPromptIds()).toContain("utils.alignmentRepair");
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

    expect(rendered.systemPrompt).toBe("固定系统提示\n");
    expect(rendered.userPrompt).toBe("你好，测试用户，编号 7\n");
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
  });
});