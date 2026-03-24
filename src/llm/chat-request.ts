import {
  resolveRequestConfig,
  type ChatRequestOptions,
  type JsonObject,
} from "./types.ts";

export type JsonSchemaChatPrompt = {
  name: string;
  systemPrompt: string;
  responseSchema: JsonObject;
};

export function buildJsonSchemaChatRequestOptions(
  requestOptions: ChatRequestOptions | undefined,
  prompt: JsonSchemaChatPrompt,
): ChatRequestOptions {
  const requestConfig = requestOptions?.requestConfig;
  const extraSystemPrompt = requestConfig?.systemPrompt?.trim();

  return {
    ...requestOptions,
    requestConfig: {
      ...requestConfig,
      systemPrompt: extraSystemPrompt
        ? `${prompt.systemPrompt}\n${extraSystemPrompt}`
        : prompt.systemPrompt,
      extraBody: {
        ...(requestConfig?.extraBody ?? {}),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: prompt.name,
            strict: true,
            schema: prompt.responseSchema,
          },
        },
      },
    },
  };
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
    requestConfig:
      defaultRequestConfig || overrideRequestConfig
        ? resolveRequestConfig(overrideRequestConfig, defaultRequestConfig)
        : undefined,
  };
}
