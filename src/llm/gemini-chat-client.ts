/**
 * 实现 Google Gemini 聊天客户端，负责消息协议适配、流式响应解析与错误处理。
 *
 * 本模块实现 {@link ChatClient} 的 Gemini 版本，支持：
 * - Google Gemini API 的 streamGenerateContent 端点
 * - 流式响应处理
 * - Function Calling（工具调用）
 * - 自动重试与速率限制
 *
 * 核心特性：
 * - Gemini 特有的消息格式（contents 数组与 systemInstruction 分离）
 * - SSE 事件流解析（candidates[].content.parts[]）
 * - usageMetadata 统计聚合
 *
 * @module llm/gemini-chat-client
 */

import { ChatClient } from "./base.ts";
import {
  isRetryableOutputValidationError,
  parseToolCallArguments,
  resolveEffectiveToolOptions,
  runOutputValidator,
  toChatResponse,
} from "./chat-request.ts";
import { RateLimiter } from "./rate-limiter.ts";
import type {
  ChatResponse,
  ChatRequestOptions,
  ClientHooks,
  CompletionResponseStatistics,
  LlmClientConfig,
  LlmConversationMessage,
  LlmToolCall,
  LlmToolChoice,
  LlmToolDefinition,
} from "./types.ts";
import { resolveRequestConfig } from "./types.ts";
import {
  ApiConnectionError,
  ApiHttpError,
  collectJsonSse,
  createHttpError,
  fetchWithTimeout,
  getDurationSeconds,
  isRecord,
  retryAsync,
} from "./utils.ts";

const REQUEST_TIMEOUT_MS = 300_000;

class GeminiEmptyResponseError extends Error {
  constructor() {
    super("Gemini 返回了空响应");
    this.name = "GeminiEmptyResponseError";
  }
}

/**
 * Gemini 聊天客户端实现，负责消息协议适配、流式响应解析与错误处理。
 *
 * 请求流程：
 * 1. 获取速率限制令牌
 * 2. 构造请求体（systemInstruction 与 contents 分离）
 * 3. 发送 POST 请求到 /v1beta/models/{model}:streamGenerateContent 端点
 * 4. 流式读取 SSE 响应，解析 candidates[].content.parts[] 事件
 * 5. 失败时按策略重试
 *
 * 与 OpenAI 的主要差异：
 * - API Key 通过 x-goog-api-key 请求头传递
 * - 模型名包含在 URL 路径中而非请求体
 * - System prompt 作为独立 systemInstruction 参数
 * - 消息角色为 "user" 和 "model"（而非 "assistant"）
 * - 工具调用参数为解析后的 JSON 对象而非增量字符串
 */
export class GeminiChatClient extends ChatClient {
  private readonly rateLimiter: RateLimiter;

  constructor(config: LlmClientConfig, hooks?: ClientHooks) {
    super(config, hooks);
    this.rateLimiter = new RateLimiter({
      qps: config.qps,
      maxParallel: config.maxParallelRequests,
    });
  }

  override async singleTurnRequest(
    prompt: string,
    options: ChatRequestOptions = {},
  ): Promise<string> {
    const response = await this.singleTurnResponse(prompt, options);
    return response.content;
  }

  override async singleTurnResponse(
    prompt: string,
    options: ChatRequestOptions = {},
  ): Promise<ChatResponse> {
    return this.conversationResponse([{ role: "user", content: prompt }], options);
  }

  override async conversationResponse(
    messages: ReadonlyArray<LlmConversationMessage>,
    options: ChatRequestOptions = {},
  ): Promise<ChatResponse> {
    const requestConfig = resolveRequestConfig(
      options.requestConfig,
      this.config.defaultRequestConfig,
    );
    const { requestId, startedAt } = this.startRequest("gemini");

    try {
      const result = await retryAsync(
        async () => {
          return this.rateLimiter.run(async () => {
            const effectiveToolOptions = resolveEffectiveToolOptions(this.config, options);
            const conversation = toGeminiContents(messages);
            const generationConfig: Record<string, unknown> = {};
            if (requestConfig.temperature !== undefined) {
              generationConfig.temperature = requestConfig.temperature;
            }
            if (requestConfig.maxTokens !== undefined) {
              generationConfig.maxOutputTokens = requestConfig.maxTokens;
            }
            if (requestConfig.topP !== undefined) {
              generationConfig.topP = requestConfig.topP;
            }

            const requestBody: Record<string, unknown> = {
              contents: conversation.contents,
              generationConfig,
              ...(requestConfig.extraBody ?? {}),
            };

            if (conversation.systemPrompt) {
              requestBody.systemInstruction = {
                role: "user",
                parts: [{ text: conversation.systemPrompt }],
              };
            }

            if (effectiveToolOptions.tools.length > 0) {
              requestBody.tools = toGeminiTools(effectiveToolOptions.tools);
              requestBody.tool_config =
                toGeminiToolConfig(effectiveToolOptions.toolChoice);
            }

            const modelUrl = `${this.config.endpoint}/v1beta/models/${this.config.modelName}:streamGenerateContent`;

            let response: Response;
            try {
              response = await fetchWithTimeout(
                modelUrl,
                {
                  method: "POST",
                  headers: {
                    "x-goog-api-key": this.config.apiKey,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify(requestBody),
                },
                REQUEST_TIMEOUT_MS,
                options.signal,
              );
            } catch (error) {
              throw new ApiConnectionError(
                `Gemini API 连接失败: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
              );
            }

            if (!response.ok) {
              throw await createHttpError(response, "Gemini API 请求失败");
            }

            let content = "";
            let usageInfo: Record<string, unknown> = {};
            const toolCallChunks = new Map<number, MutableGeminiToolCall>();
            let toolCallPartIndex = 0;

            await collectJsonSse<Record<string, unknown>>(
              response,
              async (data) => {
                const candidates = Array.isArray(data.candidates)
                  ? data.candidates
                  : [];

                for (const candidate of candidates) {
                  if (!isRecord(candidate)) {
                    continue;
                  }

                  const candidateContent = isRecord(candidate.content)
                    ? candidate.content
                    : undefined;
                  if (!candidateContent) {
                    continue;
                  }

                  const parts = Array.isArray(candidateContent.parts)
                    ? candidateContent.parts
                    : [];

                  for (const part of parts) {
                    if (!isRecord(part)) {
                      continue;
                    }

                    if (typeof part.text === "string") {
                      content += part.text;
                      this.requestObserver?.onRequestProgress?.({
                        requestId,
                        completionTextDelta: part.text,
                      });
                      continue;
                    }

                    if (
                      !part.text &&
                      isRecord(part.functionCall)
                    ) {
                      const functionCall = part.functionCall;
                      const toolName =
                        typeof functionCall.name === "string"
                          ? functionCall.name
                          : undefined;
                      if (!toolName) {
                        continue;
                      }

                      const partIndex = toolCallPartIndex;
                      toolCallPartIndex += 1;
                      const argsText = isRecord(functionCall.args)
                        ? JSON.stringify(functionCall.args)
                        : "{}";

                      toolCallChunks.set(partIndex, {
                        id: undefined,
                        name: toolName,
                        argumentsText: argsText,
                      });
                    }
                  }
                }

                if (isRecord(data.usageMetadata)) {
                  usageInfo = data.usageMetadata;
                }
              },
              {
                idleTimeoutMs: REQUEST_TIMEOUT_MS,
                signal: options.signal,
              },
            );

            if (!content.trim()) {
              const finalizedToolCalls = finalizeGeminiToolCalls(toolCallChunks);
              if (finalizedToolCalls.length === 0) {
                throw new GeminiEmptyResponseError();
              }

              return {
                response: toChatResponse(content, finalizedToolCalls),
                statistics: collectGeminiUsage(usageInfo),
              };
            }

            await runOutputValidator(content, options);

            const finalizedToolCalls = finalizeGeminiToolCalls(toolCallChunks);

            const statistics: CompletionResponseStatistics =
              collectGeminiUsage(usageInfo);

            return {
              response: toChatResponse(content, finalizedToolCalls),
              statistics,
            };
          });
        },
        {
          retries: this.config.retries,
          minDelayMs: 2_000,
          maxDelayMs: 10_000,
          multiplier: 2,
          shouldRetry: isRetryableGeminiError,
          signal: options.signal,
        },
      );

      const durationSeconds = getDurationSeconds(startedAt);
      await this.historyLogger?.logCompletion({
        prompt: summarizeConversationPrompt(messages),
        response: result.response.content,
        requestId,
        requestConfig,
        meta: options.meta,
        statistics: result.statistics,
        modelName: this.config.modelName,
        durationSeconds,
      });
      this.requestObserver?.onRequestFinish?.({ requestId });

      return result.response;
    } catch (error) {
      const responseBody = error instanceof ApiHttpError ? error.responseText : undefined;
      await this.logFailure(
        summarizeConversationPrompt(messages),
        requestId,
        startedAt,
        error,
        { ...options, requestConfig },
        responseBody,
      );
      throw normalizeGeminiError(error);
    }
  }
}

type MutableGeminiToolCall = {
  id?: string;
  name: string;
  argumentsText: string;
};

function finalizeGeminiToolCalls(
  toolCallChunks: Map<number, MutableGeminiToolCall>,
): LlmToolCall[] {
  return Array.from(toolCallChunks.entries())
    .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
    .flatMap(([, chunk]) => {
      if (!chunk.name) {
        return [];
      }

      return [
        {
          id: chunk.id,
          name: chunk.name,
          argumentsText: chunk.argumentsText || undefined,
          arguments: parseToolCallArguments(chunk.argumentsText),
        },
      ];
    });
}

function toGeminiTools(tools: LlmToolDefinition[]): unknown[] {
  if (tools.length === 0) {
    return [];
  }

  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema ?? {
          type: "object",
          additionalProperties: false,
        },
      })),
    },
  ];
}

function toGeminiToolConfig(toolChoice: LlmToolChoice | undefined): unknown {
  if (toolChoice === undefined || toolChoice === "auto") {
    return {
      function_calling_config: {
        mode: "AUTO",
      },
    };
  }

  if (toolChoice === "none") {
    return {
      function_calling_config: {
        mode: "NONE",
      },
    };
  }

  if (toolChoice === "required") {
    return {
      function_calling_config: {
        mode: "ANY",
      },
    };
  }

  return {
    function_calling_config: {
      mode: "ANY",
      allowed_function_names: [toolChoice.name],
    },
  };
}

function toGeminiContents(
  messages: ReadonlyArray<LlmConversationMessage>,
): {
  systemPrompt?: string;
  contents: unknown[];
} {
  const systemMessages: string[] = [];
  const contents: unknown[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemMessages.push(message.content);
      continue;
    }

    if (message.role === "tool") {
      const functionName =
        message.toolName ?? message.toolCallId;
      let responseContent: unknown;
      try {
        responseContent = JSON.parse(message.content);
      } catch {
        responseContent = message.content;
      }

      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: functionName,
              response: responseContent,
            },
          },
        ],
      });
      continue;
    }

    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      const parts: unknown[] = [];

      if (message.content) {
        parts.push({ text: message.content });
      }

      for (const toolCall of message.toolCalls) {
        parts.push({
          functionCall: {
            name: toolCall.name,
            args: toolCall.arguments ?? {},
          },
        });
      }

      contents.push({
        role: "model",
        parts,
      });
      continue;
    }

    const geminiRole = message.role === "assistant" ? "model" : message.role;
    contents.push({
      role: geminiRole,
      parts: [{ text: message.content }],
    });
  }

  const systemPrompt =
    systemMessages.length > 0 ? systemMessages.join("\n\n") : undefined;

  return {
    systemPrompt,
    contents,
  };
}

function summarizeConversationPrompt(
  messages: ReadonlyArray<LlmConversationMessage>,
): string {
  return messages
    .map((message) => {
      if (message.role === "tool") {
        return `[tool:${message.toolName ?? message.toolCallId}] ${message.content}`;
      }

      if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
        return `[assistant tool_calls=${message.toolCalls.map((toolCall) => toolCall.name).join(",")}] ${message.content}`;
      }

      return `[${message.role}] ${message.content}`;
    })
    .join("\n");
}

function collectGeminiUsage(
  usageInfo: Record<string, unknown>,
): CompletionResponseStatistics {
  return {
    promptTokens: getInteger(usageInfo.promptTokenCount),
    completionTokens: getInteger(usageInfo.candidatesTokenCount),
    totalTokens: getInteger(usageInfo.totalTokenCount),
  };
}

function getInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRetryableGeminiError(error: unknown): boolean {
  if (isRetryableOutputValidationError(error)) {
    return true;
  }

  if (error instanceof ApiHttpError) {
    return error.status === 429 || error.status >= 500;
  }

  return (
    error instanceof ApiConnectionError ||
    error instanceof GeminiEmptyResponseError
  );
}

function normalizeGeminiError(error: unknown): Error {
  if (error instanceof ApiHttpError) {
    return new Error(
      `Gemini API 请求最终失败: ${error.status} - ${error.responseText}`,
      { cause: error },
    );
  }

  if (error instanceof ApiConnectionError) {
    return new Error(error.message, { cause: error });
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error(`Gemini 请求异常: ${String(error)}`);
}
