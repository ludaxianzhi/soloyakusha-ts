import {
  type ChatResponse,
  LlmOutputValidationError,
  mergeLlmRequestMetadata,
  resolveRequestConfig,
  type ChatRequestOptions,
  type JsonObject,
  type JsonValue,
  type LlmClientConfig,
  type LlmOutputValidationContext,
  type LlmOutputValidator,
  type LlmToolCall,
  type LlmToolChoice,
  type LlmToolDefinition,
} from "./types.ts";

export type JsonSchemaChatPrompt = {
  name: string;
  systemPrompt: string;
  responseSchema: JsonObject;
};

export function buildJsonSchemaChatRequestOptions(
  requestOptions: ChatRequestOptions | undefined,
  prompt: JsonSchemaChatPrompt,
  supportsStructuredOutput = true,
): ChatRequestOptions {
  const requestConfig = requestOptions?.requestConfig;
  const extraSystemPrompt = requestConfig?.systemPrompt?.trim();
  const systemPrompt = extraSystemPrompt
    ? `${prompt.systemPrompt}\n${extraSystemPrompt}`
    : prompt.systemPrompt;
  const extraBody = supportsStructuredOutput
    ? {
        ...(requestConfig?.extraBody ?? {}),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: prompt.name,
            strict: true,
            schema: prompt.responseSchema,
          },
        },
      }
    : stripResponseFormat(requestConfig?.extraBody);

  return {
    ...requestOptions,
    requestConfig: {
      ...requestConfig,
      systemPrompt: supportsStructuredOutput
        ? systemPrompt
        : `${systemPrompt}\n\n请只输出 JSON 对象，不要输出 Markdown、解释或代码块。`,
      extraBody: Object.keys(extraBody).length > 0 ? extraBody : undefined,
    },
  };
}

export function withOutputValidator(
  requestOptions: ChatRequestOptions | undefined,
  outputValidator: LlmOutputValidator,
): ChatRequestOptions {
  const existingOutputValidator = requestOptions?.outputValidator;

  return {
    ...(requestOptions ?? {}),
    outputValidator: async (responseText, context) => {
      await existingOutputValidator?.(responseText, context);
      await outputValidator(responseText, context);
    },
  };
}

export async function runOutputValidator(
  responseText: string,
  options: Pick<ChatRequestOptions, "outputValidator" | "outputValidationContext">,
): Promise<void> {
  if (!options.outputValidator) {
    return;
  }

  try {
    await options.outputValidator(responseText, options.outputValidationContext);
  } catch (error) {
    throw normalizeOutputValidationError(error, options.outputValidationContext);
  }
}

export function isRetryableOutputValidationError(error: unknown): boolean {
  return error instanceof LlmOutputValidationError;
}

export function mergeChatRequestOptions(
  defaultOptions: ChatRequestOptions | undefined,
  overrideOptions: ChatRequestOptions | undefined,
): ChatRequestOptions | undefined {
  if (!defaultOptions && !overrideOptions) {
    return undefined;
  }

  const defaultRequestConfig = defaultOptions?.requestConfig;
  const overrideRequestConfig = overrideOptions?.requestConfig;

  return {
    outputValidator: overrideOptions?.outputValidator ?? defaultOptions?.outputValidator,
    outputValidationContext:
      overrideOptions?.outputValidationContext ??
      defaultOptions?.outputValidationContext,
    meta: mergeLlmRequestMetadata(defaultOptions?.meta, overrideOptions?.meta),
    requestConfig:
      defaultRequestConfig || overrideRequestConfig
        ? resolveRequestConfig(overrideRequestConfig, defaultRequestConfig)
        : undefined,
  };
}

export function withRequestMeta(
  requestOptions: ChatRequestOptions | undefined,
  meta: NonNullable<ChatRequestOptions["meta"]>,
): ChatRequestOptions {
  return {
    ...(requestOptions ?? {}),
    meta: mergeLlmRequestMetadata(requestOptions?.meta, meta),
  };
}

const VIRTUAL_TOOL_NAME = "agent_environment_probe";

export function resolveEffectiveToolOptions(
  config: Pick<LlmClientConfig, "injectVirtualTool">,
  options: Pick<ChatRequestOptions, "tools" | "toolChoice">,
): {
  tools: LlmToolDefinition[];
  toolChoice?: LlmToolChoice;
} {
  const tools = dedupeToolsByName([
    ...(options.tools ?? []),
    ...(config.injectVirtualTool ? [createVirtualToolDefinition()] : []),
  ]);

  return {
    tools,
    toolChoice: tools.length > 0 ? options.toolChoice : undefined,
  };
}

export function createVirtualToolDefinition(): LlmToolDefinition {
  return {
    name: VIRTUAL_TOOL_NAME,
    description:
      "Example tool for agent-environment priming. Never Use. This tool exists only to signal a tool-capable runtime and must never be called during normal completion.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Unused placeholder field. Never send it.",
        },
      },
      additionalProperties: false,
    },
  };
}

export function parseToolCallArguments(argumentsText: string | undefined): JsonValue | undefined {
  const normalized = argumentsText?.trim();
  if (!normalized) {
    return undefined;
  }

  try {
    return JSON.parse(normalized) as JsonValue;
  } catch {
    return undefined;
  }
}

export function toChatResponse(
  content: string,
  toolCalls: LlmToolCall[] = [],
): ChatResponse {
  return {
    content,
    toolCalls,
  };
}

function stripResponseFormat(extraBody: JsonObject | undefined): JsonObject {
  if (!extraBody) {
    return {};
  }

  const cleaned: JsonObject = { ...extraBody };
  delete (cleaned as Record<string, unknown>).response_format;
  return cleaned;
}

function normalizeOutputValidationError(
  error: unknown,
  context: LlmOutputValidationContext | undefined,
): LlmOutputValidationError {
  if (error instanceof LlmOutputValidationError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new LlmOutputValidationError(message, {
    stageLabel: context?.stageLabel,
    sourceLineCount: context?.sourceLineCount,
    minLineRatio: context?.minLineRatio,
    modelName: context?.modelName,
  });
}

function dedupeToolsByName(tools: LlmToolDefinition[]): LlmToolDefinition[] {
  const seen = new Set<string>();
  const deduped: LlmToolDefinition[] = [];

  for (const tool of tools) {
    if (seen.has(tool.name)) {
      continue;
    }
    seen.add(tool.name);
    deduped.push(tool);
  }

  return deduped;
}
