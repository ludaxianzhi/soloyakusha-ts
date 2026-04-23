import { describe, expect, test } from "bun:test";
import { ChatClient } from "../llm/base.ts";
import type { ChatRequestOptions, LlmClientConfig } from "../llm/types.ts";
import type {
  RepetitionPatternAnalysis,
  RepetitionPatternLocation,
} from "../project/analysis/repetition-pattern-analysis.ts";
import {
  RepetitionPatternFixer,
  buildRepetitionPatternFixTasks,
  selectMinimalRepetitionPatterns,
} from "./repetition-pattern-fixer.ts";

describe("repetition pattern fixer", () => {
  test("selects minimal substring patterns before building fix tasks", () => {
    const patterns = [
      buildPattern("学院门口", 4, false, [asLocation(1, 0, 0), asLocation(1, 1, 0)]),
      buildPattern("学院门口正在", 6, false, [asLocation(1, 0, 0), asLocation(1, 2, 0)]),
      buildPattern("学院", 2, true, [asLocation(1, 0, 0), asLocation(1, 1, 0)]),
    ];

    const minimalPatterns = selectMinimalRepetitionPatterns(patterns);

    expect(minimalPatterns.map((pattern) => pattern.text)).toEqual(["学院"]);

    const tasks = buildRepetitionPatternFixTasks({
      fullTextLength: 0,
      totalSentenceCount: 3,
      patterns,
    });
    expect(tasks).toEqual([]);
  });

  test("builds tasks for inconsistent minimal patterns and deduplicates line targets", () => {
    const tasks = buildRepetitionPatternFixTasks({
      fullTextLength: 0,
      totalSentenceCount: 3,
      patterns: [
        buildPattern("学院门口", 4, false, [
          asLocation(1, 0, 0, "学院门口正在排队", "学院门口正在排队", 0, 4),
          asLocation(1, 1, 0, "学院门口已经关闭", "校门已经关了", 10, 14),
          asLocation(1, 1, 0, "学院门口已经关闭", "校门已经关了", 12, 16),
        ]),
      ],
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      patternText: "学院门口",
      targetLocations: [
        {
          id: "1-1-0",
          translatedSentence: "校门已经关了",
        },
      ],
    });
  });

  test("uses the earliest occurrence as the standard translation instead of lexical order", () => {
    const [task] = buildRepetitionPatternFixTasks({
      fullTextLength: 0,
      totalSentenceCount: 3,
      patterns: [
        buildPattern("学院门口", 4, false, [
          asLocation(2, 0, 0, "学院门口正在排队", "泽塔译法", 10, 14),
          asLocation(3, 0, 0, "学院门口已经关闭", "阿尔法译法", 20, 24),
          asLocation(1, 0, 0, "学院门口灯火通明", "标准译法", 0, 4),
        ]),
      ],
    });

    expect(task?.standardLocation.translatedSentence).toBe("标准译法");
    expect(task?.targetLocations.map((location) => location.translatedSentence)).toEqual([
      "泽塔译法",
      "阿尔法译法",
    ]);
  });

  test("executes consistency prompt with json-schema constrained output", async () => {
    const chatClient = new FakeChatClient(
      JSON.stringify({
        updates: [
          {
            id: "1-1-0",
            translation: "学院门口已经关闭",
          },
        ],
      }),
    );
    const fixer = new RepetitionPatternFixer(chatClient);

    const [task] = buildRepetitionPatternFixTasks({
      fullTextLength: 0,
      totalSentenceCount: 2,
      patterns: [
        buildPattern("学院门口", 4, false, [
          asLocation(1, 0, 0, "学院门口正在排队", "学院门口正在排队", 0, 4),
          asLocation(1, 1, 0, "学院门口已经关闭", "校门已经关了", 10, 14),
        ]),
      ],
    });

    const result = await fixer.executeTask(task!);

    expect(result.updates).toEqual([
      {
        location: task!.targetLocations[0]!.location,
        translation: "学院门口已经关闭",
      },
    ]);
    expect(chatClient.requests[0]?.options?.requestConfig?.systemPrompt).toContain(
      "小说译文一致性修订助手",
    );
    expect(chatClient.requests[0]?.options?.requestConfig?.extraBody).toMatchObject({
      response_format: {
        type: "json_schema",
      },
    });
    expect(chatClient.requests[0]?.prompt).toContain("统一标准");
  });
});

class FakeChatClient extends ChatClient {
  readonly requests: Array<{ prompt: string; options?: ChatRequestOptions }> = [];

  constructor(private readonly responseText: string) {
    super({
      provider: "openai",
      modelName: "test-model",
      apiKey: "test-key",
      endpoint: "https://example.invalid",
      modelType: "chat",
      retries: 0,
      supportsStructuredOutput: true,
    } satisfies LlmClientConfig);
  }

  override async singleTurnRequest(
    prompt: string,
    options?: ChatRequestOptions,
  ): Promise<string> {
    this.requests.push({ prompt, options });
    return this.responseText;
  }
}

function buildPattern(
  text: string,
  length: number,
  isTranslationConsistent: boolean,
  locations: RepetitionPatternLocation[],
): RepetitionPatternAnalysis {
  return {
    text,
    length,
    occurrenceCount: locations.length,
    locations,
    translations: [],
    isTranslationConsistent,
  };
}

function asLocation(
  chapterId: number,
  fragmentIndex: number,
  lineIndex: number,
  sourceSentence = "学院门口",
  translatedSentence = "学院门口",
  globalStartIndex = 0,
  globalEndIndex = 4,
): RepetitionPatternLocation {
  return {
    chapterId,
    chapterFilePath: "sources\\chapter-1.txt",
    unitIndex: fragmentIndex,
    fragmentIndex,
    lineIndex,
    sourceSentence,
    translatedSentence,
    globalStartIndex,
    globalEndIndex,
    sentenceStartIndex: globalStartIndex,
    sentenceEndIndex: globalEndIndex + 4,
    matchStartInSentence: 0,
    matchEndInSentence: globalEndIndex - globalStartIndex,
  };
}
