/**
 * 提供术语表译文更新接口、默认 LLM 实现与工厂。
 *
 * @module glossary/updater
 */

import type { ChatClient } from "../llm/base.ts";
import {
  buildJsonSchemaChatRequestOptions,
  mergeChatRequestOptions,
  withRequestMeta,
  withOutputValidator,
} from "../llm/chat-request.ts";
import { LlmClientProvider } from "../llm/provider.ts";
import type {
  ChatRequestOptions,
  JsonObject,
  LlmRequestMetadata,
} from "../llm/types.ts";
import {
  getDefaultPromptManager,
  type PromptManager as SharedPromptManager,
} from "../prompts/index.ts";
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
const GLOSSARY_UPDATE_PROMPT_ID = "glossary.translationUpdate";

export class DefaultGlossaryUpdater implements GlossaryUpdater {
  private readonly logger: GlossaryUpdaterLogger;
  private readonly defaultRequestOptions?: ChatRequestOptions;
  private readonly promptManagerPromise: Promise<SharedPromptManager>;
  private readonly updaterName?: string;

  constructor(
    private readonly clientResolver: GlossaryUpdaterClientResolver,
    options: {
      defaultRequestOptions?: ChatRequestOptions;
      logger?: GlossaryUpdaterLogger;
      promptManager?: SharedPromptManager | Promise<SharedPromptManager>;
      updaterName?: string;
    } = {},
  ) {
    this.defaultRequestOptions = options.defaultRequestOptions;
    this.logger = options.logger ?? NOOP_GLOSSARY_UPDATER_LOGGER;
    this.promptManagerPromise = Promise.resolve(
      options.promptManager ?? getDefaultPromptManager(),
    );
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
      withRequestMeta(
        withOutputValidator(
          buildJsonSchemaChatRequestOptions(
            mergeChatRequestOptions(this.defaultRequestOptions, request.requestOptions),
            renderedPrompt,
          ),
          (candidateResponseText) => {
            parseGlossaryUpdateResponse(
              candidateResponseText,
              request.untranslatedTerms.map((term) => term.term),
              request.translationUnits.map((unit) => unit.translatedText),
            );
          },
        ),
        this.buildRequestMeta(request),
      ),
    );
    const updates = parseGlossaryUpdateResponse(
      responseText,
      request.untranslatedTerms.map((term) => term.term),
      request.translationUnits.map((unit) => unit.translatedText),
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
    const promptManager = await this.promptManagerPromise;
    const renderedPrompt = promptManager.renderPrompt(GLOSSARY_UPDATE_PROMPT_ID, {
      translationUnits: input.translationUnits,
      untranslatedTerms: input.untranslatedTerms,
      requirements: [...(input.requirements ?? [])],
      responseSchemaJson: JSON.stringify(responseSchema, null, 2),
    });

    return {
      name: GLOSSARY_UPDATE_PROMPT_NAME,
      systemPrompt: renderedPrompt.systemPrompt,
      userPrompt: renderedPrompt.userPrompt,
      responseSchema,
    };
  }

  private resolveChatClient(): ChatClient {
    if ("singleTurnRequest" in this.clientResolver) {
      return this.clientResolver;
    }

    return this.clientResolver.provider.getChatClient(this.clientResolver.modelName);
  }

  private buildRequestMeta(request: GlossaryUpdateRequest): LlmRequestMetadata {
    const context: JsonObject = {
      glossaryTermCount: request.untranslatedTerms.length,
      translationUnitCount: request.translationUnits.length,
    };
    if (this.updaterName) {
      context.updaterName = this.updaterName;
    }

    return {
      label: "术语更新",
      feature: "术语",
      operation: "术语更新",
      component: "DefaultGlossaryUpdater",
      workflow: "default",
      context,
    };
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
  translatedTexts: ReadonlyArray<string>,
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
  const results: GlossaryTranslationUpdate[] = [];

  for (const [index, entry] of glossaryValues.entries()) {
    if (!isRecord(entry)) {
      throw new Error(`glossaryUpdates[${index}] 必须是对象`);
    }

    const term = typeof entry.term === "string" ? entry.term.trim() : "";
    const translation =
      typeof entry.translation === "string" ? entry.translation.trim() : "";
    if (!term) {
      throw new Error(`glossaryUpdates[${index}].term 必须是非空字符串`);
    }
    // 过滤：术语不在术语表中
    if (!allowedGlossaryTermSet.has(term)) {
      continue;
    }
    if (seenGlossaryTerms.has(term)) {
      throw new Error(`glossaryUpdates 返回了重复术语: ${term}`);
    }
    if (!translation) {
      throw new Error(`glossaryUpdates[${index}].translation 必须是非空字符串`);
    }
    // 过滤：术语译文在译文中不存在
    if (!translatedTexts.some((text) => text.includes(translation))) {
      continue;
    }

    seenGlossaryTerms.add(term);
    results.push({ term, translation });
  }

  return results;
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
