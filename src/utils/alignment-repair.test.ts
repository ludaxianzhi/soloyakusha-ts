import { describe, expect, test } from "bun:test";
import { ChatClient } from "../llm/base.ts";
import type { ChatRequestOptions, LlmClientConfig } from "../llm/types.ts";
import {
  ALIGNMENT_REPAIR_MISSING_MARKER,
  AlignmentRepairTool,
} from "./alignment-repair.ts";
import { TEXT_ALIGN_PLACEHOLDER, TextAligner } from "./text-align.ts";

class FakeChatClient extends ChatClient {
  readonly requests: Array<{ prompt: string; options?: ChatRequestOptions }> = [];

  constructor(
    private readonly responses: string[],
    supportsStructuredOutput = true,
  ) {
    super(createFakeChatConfig(supportsStructuredOutput));
  }

  override async singleTurnRequest(
    prompt: string,
    options?: ChatRequestOptions,
  ): Promise<string> {
    this.requests.push({ prompt, options });
    return this.responses.shift() ?? '{"repairs":[]}';
  }
}

class FakeTextAligner extends TextAligner {
  callCount = 0;

  constructor(private readonly alignedTexts: string[]) {
    // @ts-expect-error 测试桩不需要真实 embedding client
    super(undefined);
  }

  override async alignTexts(): Promise<string[]> {
    this.callCount += 1;
    return [...this.alignedTexts];
  }
}

describe("AlignmentRepairTool", () => {
  test("skips alignment when source and target line counts already match", async () => {
    const aligner = new FakeTextAligner([]);
    const chatClient = new FakeChatClient([]);
    const tool = new AlignmentRepairTool(aligner, chatClient);

    const analysis = await tool.analyze(["原文一", "原文二"], ["译文一", "译文二"]);

    expect(analysis.lineCountMatches).toBe(true);
    expect(analysis.missingUnitIds).toEqual([]);
    expect(analysis.units.map((unit) => unit.id)).toEqual(["u0001", "u0002"]);
    expect(aligner.callCount).toBe(0);
  });

  test("uses aligned placeholders to identify likely omitted lines", async () => {
    const aligner = new FakeTextAligner([
      "译文一",
      TEXT_ALIGN_PLACEHOLDER,
      "译文三",
    ]);
    const chatClient = new FakeChatClient([]);
    const tool = new AlignmentRepairTool(aligner, chatClient);

    const analysis = await tool.analyze(
      ["原文一", "原文二", "原文三"],
      ["译文一", "译文三"],
      { idPrefix: "line-" },
    );

    expect(analysis.lineCountMatches).toBe(false);
    expect(analysis.missingUnitIds).toEqual(["line-0002"]);
    expect(analysis.comparisonText).toContain(
      `line-0002 | TARGET | ${ALIGNMENT_REPAIR_MISSING_MARKER}`,
    );
    expect(aligner.callCount).toBe(1);
  });

  test("builds json-schema constrained repair requests and parses id-based repairs", async () => {
    const aligner = new FakeTextAligner([
      "译文一",
      TEXT_ALIGN_PLACEHOLDER,
      "译文三",
    ]);
    const chatClient = new FakeChatClient([
      '{"repairs":[{"id":"u0002","translation":"补翻第二句"}]}',
    ]);
    const tool = new AlignmentRepairTool(aligner, chatClient);

    const result = await tool.repairMissingTranslations(
      ["原文一", "原文二", "原文三"],
      ["译文一", "译文三"],
    );

    expect(result.repairs).toEqual([{ id: "u0002", translation: "补翻第二句" }]);
    expect(result.unresolvedIds).toEqual([]);
    expect(result.systemPrompt).toContain("翻译补漏助手");
    expect(result.systemPrompt).toContain("JSON Schema");
    expect(chatClient.requests).toHaveLength(1);
    expect(chatClient.requests[0]?.prompt).not.toContain("JSON Schema");
    expect(chatClient.requests[0]?.prompt).toContain("u0002");
    expect(chatClient.requests[0]?.options?.requestConfig?.systemPrompt).toContain("严格 JSON");
    expect(chatClient.requests[0]?.options?.requestConfig?.extraBody).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "alignment_repair_result",
          strict: true,
        },
      },
    });
    expect(chatClient.requests[0]?.options?.meta).toMatchObject({
      label: "翻译-对齐补翻",
      feature: "翻译",
      operation: "对齐补翻",
      component: "AlignmentRepairTool",
      context: {
        missingUnitCount: 1,
      },
    });
  });

  test("falls back to prompt-only JSON instructions when structured output is unsupported", async () => {
    const aligner = new FakeTextAligner([
      "译文一",
      TEXT_ALIGN_PLACEHOLDER,
    ]);
    const chatClient = new FakeChatClient(
      ['{"repairs":[{"id":"u0002","translation":"补翻第二句"}]}'],
      false,
    );
    const tool = new AlignmentRepairTool(aligner, chatClient);

    await tool.repairMissingTranslations(["原文一", "原文二"], ["译文一"]);

    expect(chatClient.requests[0]?.options?.requestConfig?.systemPrompt).toContain("JSON 对象");
    expect(chatClient.requests[0]?.options?.requestConfig?.extraBody).toBeUndefined();
  });
});

function createFakeChatConfig(supportsStructuredOutput: boolean): LlmClientConfig {
  return {
    provider: "openai",
    modelName: "fake-model",
    apiKey: "test-key",
    endpoint: "https://example.com",
    modelType: "chat",
    retries: 0,
    supportsStructuredOutput,
  };
}
