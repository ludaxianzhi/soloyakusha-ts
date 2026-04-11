import { describe, expect, test } from "bun:test";
import {
  getConsistencyPromptFilePath,
  getConsistencyPromptManager,
} from "./prompt-manager.ts";

describe("consistency prompt manager", () => {
  test("loads repetition consistency prompts from dedicated yaml resource", async () => {
    const manager = await getConsistencyPromptManager();

    expect(getConsistencyPromptFilePath()).toEndWith("consistency-prompts.yaml");

    const rendered = manager.renderPrompt("consistency.repetition.unify", {
      patternText: "学院门口",
      patternLength: 4,
      occurrenceCount: 2,
      standardLocation: {
        id: "1-0-0",
        label: "章节 1 / 句 1",
        sourceSentence: "学院门口正在排队",
        translatedSentence: "学院门口正在排队",
      },
      targetLocations: [
        {
          id: "1-1-0",
          label: "章节 1 / 句 2",
          sourceSentence: "学院门口已经关闭",
          translatedSentence: "校门已经关了",
        },
      ],
      responseSchemaJson: '{"type":"object"}',
    });

    expect(rendered.systemPrompt).toContain("首条例句译文");
    expect(rendered.systemPrompt).toContain("JSON Schema");
    expect(rendered.userPrompt).toContain("学院门口");
    expect(rendered.userPrompt).toContain("章节 1 / 句 2");
  });
});
