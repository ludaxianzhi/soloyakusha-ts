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
});