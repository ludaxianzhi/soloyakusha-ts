import {
  LlmOutputValidationError,
  mergeLlmRequestMetadata,
  resolveRequestConfig,
  type ChatRequestOptions,
  type JsonObject,
  type LlmOutputValidationContext,
  type LlmOutputValidator,
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
