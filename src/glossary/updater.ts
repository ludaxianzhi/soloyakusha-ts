/**
 * 提供术语表译文更新接口、默认 LLM 实现与工厂。
 *
 * @module glossary/updater
 */

import { Liquid } from "liquidjs";
import type { ChatClient } from "../llm/base.ts";
import { buildJsonSchemaChatRequestOptions, mergeChatRequestOptions } from "../llm/chat-request.ts";
import { LlmClientProvider } from "../llm/provider.ts";
import type { ChatRequestOptions, JsonObject } from "../llm/types.ts";
import type {
  GlossaryTranslationUpdate,
  ResolvedGlossaryTerm,
} from "./glossary.ts";
import { Glossary } from "./glossary.ts";

export type GlossaryUpdaterClientResolver =
  | ChatClient
  | {
      provider: LlmClientProvider;
      modelName: string;
    };

export type GlossaryUpdateTranslationUnit = {
  id: string;
  sourceText: string;
  translatedText: string;
};

export type GlossaryUpdateRequest = {
  glossary: Glossary;
  untranslatedTerms: ReadonlyArray<ResolvedGlossaryTerm>;
  translationUnits: ReadonlyArray<GlossaryUpdateTranslationUnit>;
  requirements?: ReadonlyArray<string>;
  requestOptions?: ChatRequestOptions;
};

export type GlossaryUpdateExecutionResult = {
  updates: GlossaryTranslationUpdate[];
  appliedTerms: ResolvedGlossaryTerm[];
  responseText: string;
  responseSchema: JsonObject;
  promptName: string;
  systemPrompt: string;
  userPrompt: string;
};

export interface GlossaryUpdater {
  updateGlossary(request: GlossaryUpdateRequest): Promise<GlossaryUpdateExecutionResult>;
}

export type GlossaryUpdaterLogger = {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
};

const NOOP_GLOSSARY_UPDATER_LOGGER: GlossaryUpdaterLogger = {};

type RenderedGlossaryUpdatePrompt = {
  name: string;
  systemPrompt: string;
  userPrompt: string;
  responseSchema: JsonObject;
};

type GlossaryUpdaterFactoryCreateOptions = {
  workflow?: string;
  clientResolver: GlossaryUpdaterClientResolver;
  defaultRequestOptions?: ChatRequestOptions;
  logger?: GlossaryUpdaterLogger;
  updaterName?: string;
};

type GlossaryUpdaterBuilder = (
  options: Omit<GlossaryUpdaterFactoryCreateOptions, "workflow">,
) => GlossaryUpdater;

const GLOSSARY_UPDATE_PROMPT_NAME = "glossary_update_result";

const GLOSSARY_UPDATE_USER_TEMPLATE = `
你将根据已生成的译文，为术语表补全能够明确识别的缺失译文。

{% if requirements.size > 0 %}
额外要求：
{% for requirement in requirements %}
- {{ requirement }}
{% endfor %}

{% endif %}
原文与译文对照：
{% for unit in translationUnits %}
- id: {{ unit.id }}
  sourceText: {{ unit.sourceText }}
  translatedText: {{ unit.translatedText }}
{% endfor %}

待更新术语：
{% for term in untranslatedTerms %}
- term: {{ term.term }}
  {% if term.description %}description: {{ term.description }}{% endif %}
{% endfor %}
`;

export class DefaultGlossaryUpdater implements GlossaryUpdater {
  private readonly liquid = new Liquid();
  private readonly logger: GlossaryUpdaterLogger;
  private readonly defaultRequestOptions?: ChatRequestOptions;
  private readonly updaterName?: string;

  constructor(
    private readonly clientResolver: GlossaryUpdaterClientResolver,
    options: {
      defaultRequestOptions?: ChatRequestOptions;
      logger?: GlossaryUpdaterLogger;
      updaterName?: string;
    } = {},
  ) {
    this.defaultRequestOptions = options.defaultRequestOptions;
    this.logger = options.logger ?? NOOP_GLOSSARY_UPDATER_LOGGER;
    this.updaterName = options.updaterName;
  }

  async updateGlossary(
    request: GlossaryUpdateRequest,
  ): Promise<GlossaryUpdateExecutionResult> {
    if (request.untranslatedTerms.length === 0 || request.translationUnits.length === 0) {
      return {
        updates: [],
        appliedTerms: [],
        responseText: JSON.stringify({ glossaryUpdates: [] }),
        responseSchema: buildEmptyGlossaryUpdateResponseSchema(),
        promptName: GLOSSARY_UPDATE_PROMPT_NAME,
        systemPrompt: "",
        userPrompt: "",
      };
    }

    this.logger.info?.("开始执行术语表更新", {
      updaterName: this.updaterName,
      modelName: getResolvedModelName(this.clientResolver),
      translationUnitCount: request.translationUnits.length,
      glossaryTermCount: request.untranslatedTerms.length,
    });

    const renderedPrompt = await this.renderPrompt(request);
    const responseText = await this.resolveChatClient().singleTurnRequest(
      renderedPrompt.userPrompt,
      buildJsonSchemaChatRequestOptions(
        mergeChatRequestOptions(this.defaultRequestOptions, request.requestOptions),
        renderedPrompt,
      ),
    );
    const updates = parseGlossaryUpdateResponse(
      responseText,
      request.untranslatedTerms.map((term) => term.term),
    );
    const appliedTerms = request.glossary.applyTranslations(updates);

    this.logger.info?.("术语表更新完成", {
      updaterName: this.updaterName,
      modelName: getResolvedModelName(this.clientResolver),
      glossaryUpdateCount: updates.length,
    });

    return {
      updates,
      appliedTerms,
      responseText,
      responseSchema: renderedPrompt.responseSchema,
      promptName: renderedPrompt.name,
      systemPrompt: renderedPrompt.systemPrompt,
      userPrompt: renderedPrompt.userPrompt,
    };
  }

  private async renderPrompt(
    input: GlossaryUpdateRequest,
  ): Promise<RenderedGlossaryUpdatePrompt> {
    const responseSchema = buildGlossaryUpdateResponseSchema(input.untranslatedTerms);
    return {
      name: GLOSSARY_UPDATE_PROMPT_NAME,
      systemPrompt: buildGlossaryUpdateSystemPrompt(responseSchema),
      userPrompt: await this.liquid.parseAndRender(GLOSSARY_UPDATE_USER_TEMPLATE, {
        translationUnits: input.translationUnits,
        untranslatedTerms: input.untranslatedTerms,
        requirements: [...(input.requirements ?? [])],
      }),
      responseSchema,
    };
  }

  private resolveChatClient(): ChatClient {
    if ("singleTurnRequest" in this.clientResolver) {
      return this.clientResolver;
    }

    return this.clientResolver.provider.getChatClient(this.clientResolver.modelName);
  }
}

export class GlossaryUpdaterFactory {
  private static readonly builders = new Map<string, GlossaryUpdaterBuilder>([
    [
      "default",
      (options) =>
        new DefaultGlossaryUpdater(options.clientResolver, {
          defaultRequestOptions: options.defaultRequestOptions,
          logger: options.logger,
          updaterName: options.updaterName,
        }),
    ],
  ]);

  static createUpdater(options: GlossaryUpdaterFactoryCreateOptions): GlossaryUpdater {
    const workflow = options.workflow ?? "default";
    const builder = this.builders.get(workflow);
    if (!builder) {
      const supported = Array.from(this.builders.keys()).join(", ");
      throw new Error(`不支持的术语更新流程: ${workflow}。支持的流程: ${supported}`);
    }

    return builder(options);
  }

  static registerWorkflow(workflow: string, builder: GlossaryUpdaterBuilder): void {
    this.builders.set(workflow, builder);
  }
}

function buildGlossaryUpdateSystemPrompt(responseSchema: JsonObject): string {
  return [
    "你是术语表译文更新器。",
    "请仅根据提供的原文与译文对照，提取待更新术语中能够被明确确认的译文。",
    "如果某个术语无法从给定译文中明确判断，就不要返回它。",
    "glossaryUpdates 中只能返回给定未翻译术语列表中的 term，不能新增其他术语。",
    "只返回 JSON，不要输出 Markdown、解释或代码块。",
    "输出必须严格满足以下 JSON Schema：",
    JSON.stringify(responseSchema, null, 2),
  ].join("\n");
}

function buildGlossaryUpdateResponseSchema(
  untranslatedTerms: ReadonlyArray<ResolvedGlossaryTerm>,
): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      glossaryUpdates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            term: {
              type: "string",
              enum: untranslatedTerms.map((term) => term.term),
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
    required: ["glossaryUpdates"],
  };
}

function buildEmptyGlossaryUpdateResponseSchema(): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      glossaryUpdates: {
        type: "array",
        maxItems: 0,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
    },
    required: ["glossaryUpdates"],
  };
}

function parseGlossaryUpdateResponse(
  responseText: string,
  allowedGlossaryTerms: ReadonlyArray<string>,
): GlossaryTranslationUpdate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch (error) {
    throw new Error(
      `术语表更新结果不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("术语表更新结果必须是 JSON 对象");
  }

  const glossaryValues = parsed.glossaryUpdates;
  if (!Array.isArray(glossaryValues)) {
    throw new Error("术语表更新结果缺少 glossaryUpdates 数组");
  }

  const allowedGlossaryTermSet = new Set(allowedGlossaryTerms);
  const seenGlossaryTerms = new Set<string>();
  return glossaryValues.map<GlossaryTranslationUpdate>((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`glossaryUpdates[${index}] 必须是对象`);
    }

    const term = typeof entry.term === "string" ? entry.term.trim() : "";
    const translation =
      typeof entry.translation === "string" ? entry.translation.trim() : "";
    if (!term) {
      throw new Error(`glossaryUpdates[${index}].term 必须是非空字符串`);
    }
    if (!allowedGlossaryTermSet.has(term)) {
      throw new Error(`glossaryUpdates 返回了未请求的术语: ${term}`);
    }
    if (seenGlossaryTerms.has(term)) {
      throw new Error(`glossaryUpdates 返回了重复术语: ${term}`);
    }
    if (!translation) {
      throw new Error(`glossaryUpdates[${index}].translation 必须是非空字符串`);
    }

    seenGlossaryTerms.add(term);
    return { term, translation };
  });
}

function getResolvedModelName(
  clientResolver: GlossaryUpdaterClientResolver,
): string | undefined {
  if ("singleTurnRequest" in clientResolver) {
    return clientResolver.modelName;
  }

  return clientResolver.modelName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
