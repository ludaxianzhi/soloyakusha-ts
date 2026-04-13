import { ChatClient } from "../llm/base.ts";
import {
  buildJsonSchemaChatRequestOptions,
  mergeChatRequestOptions,
  withOutputValidator,
  withRequestMeta,
} from "../llm/chat-request.ts";
import type {
  ChatRequestOptions,
  JsonObject,
  LlmRequestMetadata,
} from "../llm/types.ts";
import type { Logger } from "../project/logger.ts";
import type {
  RepetitionPatternAnalysis,
  RepetitionPatternAnalysisResult,
  RepetitionPatternLocation,
} from "../project/repetition-pattern-analysis.ts";
import type { PromptManager as SharedPromptManager } from "../prompts/index.ts";
import { getConsistencyPromptManager } from "./prompt-manager.ts";

const REPETITION_UNIFY_PROMPT_ID = "consistency.repetition.unify";
const REPETITION_UNIFY_PROMPT_NAME = "consistency_repetition_unify";

export type RepetitionPatternFixTask = {
  id: string;
  patternText: string;
  patternLength: number;
  occurrenceCount: number;
  standardLocation: RepetitionPatternTaskLocation;
  targetLocations: RepetitionPatternTaskLocation[];
};

export type RepetitionPatternTaskLocation = {
  id: string;
  label: string;
  location: RepetitionPatternLocation;
  sourceSentence: string;
  translatedSentence: string;
};

export type RepetitionPatternFixUpdate = {
  id: string;
  translation: string;
};

export type RepetitionPatternFixResult = {
  task: RepetitionPatternFixTask;
  updates: Array<{
    location: RepetitionPatternLocation;
    translation: string;
  }>;
  responseText: string;
  systemPrompt: string;
  userPrompt: string;
};

export class RepetitionPatternFixer {
  private readonly promptManagerPromise: Promise<SharedPromptManager>;
  private readonly logger?: Logger;
  private readonly requestOptions?: ChatRequestOptions;

  constructor(
    private readonly chatClient: ChatClient,
    options: {
      promptManager?: SharedPromptManager | Promise<SharedPromptManager>;
      logger?: Logger;
      requestOptions?: ChatRequestOptions;
    } = {},
  ) {
    this.promptManagerPromise = Promise.resolve(
      options.promptManager ?? getConsistencyPromptManager(),
    );
    this.logger = options.logger;
    this.requestOptions = options.requestOptions;
  }

  async executeTask(task: RepetitionPatternFixTask): Promise<RepetitionPatternFixResult> {
    if (task.targetLocations.length === 0) {
      return {
        task,
        updates: [],
        responseText: JSON.stringify({ updates: [] }),
        systemPrompt: "",
        userPrompt: "",
      };
    }

    const promptManager = await this.promptManagerPromise;
    const responseSchema = buildRepetitionPatternFixResponseSchema(task.targetLocations);
    const renderedPrompt = promptManager.renderPrompt(REPETITION_UNIFY_PROMPT_ID, {
      patternText: task.patternText,
      patternLength: task.patternLength,
      occurrenceCount: task.occurrenceCount,
      standardLocation: {
        id: task.standardLocation.id,
        label: task.standardLocation.label,
        sourceSentence: task.standardLocation.sourceSentence,
        translatedSentence: task.standardLocation.translatedSentence,
      },
      targetLocations: task.targetLocations.map((location) => ({
        id: location.id,
        label: location.label,
        sourceSentence: location.sourceSentence,
        translatedSentence: location.translatedSentence,
      })),
      responseSchemaJson: JSON.stringify(responseSchema, null, 2),
    });

    this.logger?.info?.(
      `开始一致性修订 Pattern "${task.patternText}"（${task.targetLocations.length} 条目标例句）`,
    );

    const responseText = await this.chatClient.singleTurnRequest(
      renderedPrompt.userPrompt,
      withRequestMeta(
        withOutputValidator(
          buildJsonSchemaChatRequestOptions(
            mergeChatRequestOptions(this.requestOptions, undefined),
            {
              name: REPETITION_UNIFY_PROMPT_NAME,
              systemPrompt: renderedPrompt.systemPrompt,
              responseSchema,
            },
            this.chatClient.supportsStructuredOutput,
          ),
          (candidateResponseText) => {
            parseRepetitionPatternFixResponse(candidateResponseText, task.targetLocations);
          },
        ),
        buildTaskRequestMeta(task),
      ),
    );

    const parsed = parseRepetitionPatternFixResponse(responseText, task.targetLocations);
    const targetLocationMap = new Map(
      task.targetLocations.map((location) => [location.id, location.location] as const),
    );
    const updates = parsed.map((update) => ({
      location: targetLocationMap.get(update.id)!,
      translation: update.translation,
    }));

    this.logger?.info?.(`一致性修订 Pattern "${task.patternText}" 完成`);

    return {
      task,
      updates,
      responseText,
      systemPrompt: renderedPrompt.systemPrompt,
      userPrompt: renderedPrompt.userPrompt,
    };
  }
}

export function buildRepetitionPatternFixTasks(
  analysis: RepetitionPatternAnalysisResult,
): RepetitionPatternFixTask[] {
  const minimalPatterns = selectMinimalRepetitionPatterns(analysis.patterns);
  return minimalPatterns
    .filter((pattern) => !pattern.isTranslationConsistent)
    .map((pattern) => {
      const dedupedLocations = dedupeLocationsByLine(pattern.locations);
      const [standardLocation, ...targetLocations] = dedupedLocations.map((location) =>
        toTaskLocation(location),
      );
      if (!standardLocation || targetLocations.length === 0) {
        return null;
      }

      return {
        id: pattern.text,
        patternText: pattern.text,
        patternLength: pattern.length,
        occurrenceCount: pattern.occurrenceCount,
        standardLocation,
        targetLocations,
      };
    })
    .filter((task): task is RepetitionPatternFixTask => task !== null);
}

export function selectMinimalRepetitionPatterns(
  patterns: ReadonlyArray<RepetitionPatternAnalysis>,
): RepetitionPatternAnalysis[] {
  return [...patterns]
    .filter(
      (pattern) =>
        !patterns.some(
          (candidate) =>
            candidate.text !== pattern.text &&
            pattern.text.includes(candidate.text),
        ),
    )
    .sort(
      (left, right) =>
        left.length - right.length ||
        left.text.localeCompare(right.text) ||
        left.locations[0]!.globalStartIndex - right.locations[0]!.globalStartIndex,
    );
}

export function parseRepetitionPatternFixResponse(
  responseText: string,
  targetLocations: ReadonlyArray<RepetitionPatternTaskLocation>,
): RepetitionPatternFixUpdate[] {
  const parsed = JSON.parse(responseText) as { updates?: unknown };
  if (!parsed || !Array.isArray(parsed.updates)) {
    throw new Error("一致性修订响应必须包含 updates 数组");
  }

  const allowedIds = new Set(targetLocations.map((location) => location.id));
  const updates = parsed.updates.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`一致性修订 updates[${index}] 必须是对象`);
    }
    if (typeof item.id !== "string" || !allowedIds.has(item.id)) {
      throw new Error(`一致性修订 updates[${index}] 的 id 无效`);
    }
    if (typeof item.translation !== "string") {
      throw new Error(`一致性修订 updates[${index}] 的 translation 必须是字符串`);
    }
    return {
      id: item.id,
      translation: item.translation,
    };
  });

  if (updates.length !== targetLocations.length) {
    throw new Error(
      `一致性修订 updates 数量不匹配：期望 ${targetLocations.length}，实际 ${updates.length}`,
    );
  }

  const seenIds = new Set<string>();
  for (const update of updates) {
    if (seenIds.has(update.id)) {
      throw new Error(`一致性修订响应中存在重复 id: ${update.id}`);
    }
    seenIds.add(update.id);
  }

  for (const location of targetLocations) {
    if (!seenIds.has(location.id)) {
      throw new Error(`一致性修订响应缺少目标 id: ${location.id}`);
    }
  }

  return updates;
}

function buildRepetitionPatternFixResponseSchema(
  targetLocations: ReadonlyArray<RepetitionPatternTaskLocation>,
): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    required: ["updates"],
    properties: {
      updates: {
        type: "array",
        minItems: targetLocations.length,
        maxItems: targetLocations.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "translation"],
          properties: {
            id: {
              type: "string",
              enum: targetLocations.map((location) => location.id),
            },
            translation: {
              type: "string",
            },
          },
        },
      },
    },
  };
}

function buildTaskRequestMeta(task: RepetitionPatternFixTask): LlmRequestMetadata {
  return {
    label: "表达统一修订",
    feature: "一致性",
    operation: "重复 Pattern 表达统一",
    component: "RepetitionPatternFixer",
    workflow: "repetition-consistency",
    context: {
      patternText: task.patternText,
      targetLocationCount: task.targetLocations.length,
    },
  };
}

function dedupeLocationsByLine(
  locations: ReadonlyArray<RepetitionPatternLocation>,
): RepetitionPatternLocation[] {
  const sortedLocations = sortLocationsByOccurrenceOrder(locations);
  const unique = new Map<string, RepetitionPatternLocation>();
  for (const location of sortedLocations) {
    const key = buildEditableLineKey(location);
    if (!unique.has(key)) {
      unique.set(key, location);
    }
  }
  return [...unique.values()];
}

function toTaskLocation(location: RepetitionPatternLocation): RepetitionPatternTaskLocation {
  return {
    id: buildEditableLineKey(location),
    label: `章节 ${location.chapterId} / 句 ${location.unitIndex + 1}`,
    location,
    sourceSentence: location.sourceSentence,
    translatedSentence: location.translatedSentence,
  };
}

function buildEditableLineKey(location: RepetitionPatternLocation): string {
  return `${location.chapterId}-${location.fragmentIndex}-${location.lineIndex}`;
}

function sortLocationsByOccurrenceOrder(
  locations: ReadonlyArray<RepetitionPatternLocation>,
): RepetitionPatternLocation[] {
  return [...locations].sort(
    (left, right) =>
      left.globalStartIndex - right.globalStartIndex ||
      left.chapterId - right.chapterId ||
      left.fragmentIndex - right.fragmentIndex ||
      left.lineIndex - right.lineIndex,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
