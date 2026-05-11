/**
 * 实现 Anthropic Claude 聊天客户端，负责消息构造、流式解析与错误处理。
 *
 * 本模块实现 {@link ChatClient} 的 Anthropic Claude 版本，支持：
 * - Claude 系列模型的 Messages API
 * - 流式响应处理
 * - 自动重试与速率限制
 *
 * 核心特性：
 * - Claude 特有的消息格式（system 参数与 messages 数组分离）
 * - content_block_delta 事件解析
 * - usage 统计聚合（input_tokens + output_tokens）
 *
 * @module llm/anthropic-chat-client
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
import { resolveRequestConfig, ThinkingLoopError } from "./types.ts";
import { ThinkingLoopDetector } from "./thinking-loop-detector.ts";
import {
  ApiConnectionError,
  ApiHttpError,
  collectJsonSse,
  createHttpError,
  fetchWithTimeout,
  getDurationSeconds,
  isRecord,
  joinUrl,
  retryAsync,
} from "./utils.ts";

const REQUEST_TIMEOUT_MS = 300_000;

class AnthropicEmptyResponseError extends Error {
  constructor() {
    super("Anthropic 返回了空响应");
    this.name = "AnthropicEmptyResponseError";
  }
}

/**
 * Anthropic 聊天客户端实现，负责消息协议适配、流式事件解析与错误处理。
 *
 * 请求流程：
 * 1. 获取速率限制令牌
 * 2. 构造请求体（system 与 messages 分离）
 * 3. 发送 POST 请求到 /messages 端点
 * 4. 流式读取 SSE 响应，解析 content_block_delta 事件
 * 5. 失败时按策略重试
 *
 * 与 OpenAI 的主要差异：
 * - system prompt 作为独立参数而非 messages 中的首条
 * - 响应事件类型为 content_block_delta / message_delta / message_start
 */
export class AnthropicChatClient extends ChatClient {
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
    const { requestId, startedAt } = this.startRequest("anthropic");

    try {
      const result = await retryAsync(
        async () => {
          return this.rateLimiter.run(async () => {
            const thinkingLoopDetector = new ThinkingLoopDetector();
            const effectiveToolOptions = resolveEffectiveToolOptions(this.config, options);
            const conversation = toAnthropicMessages(messages);
            const requestBody: Record<string, unknown> = {
              model: this.config.modelName,
              messages: conversation.messages,
              temperature: requestConfig.temperature,
              max_tokens: requestConfig.maxTokens,
              top_p: requestConfig.topP,
              stream: true,
              ...(requestConfig.extraBody ?? {}),
            };

            const systemPrompt = [requestConfig.systemPrompt, conversation.systemPrompt]
              .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
              .join("\n\n");
            if (systemPrompt) {
              requestBody.system = systemPrompt;
            }

            if (effectiveToolOptions.tools.length > 0) {
              requestBody.tools = toAnthropicTools(effectiveToolOptions.tools);
              const toolChoice = toAnthropicToolChoice(effectiveToolOptions.toolChoice);
              if (toolChoice !== undefined) {
                requestBody.tool_choice = toolChoice;
              }
            }

            let response: Response;
            try {
              response = await fetchWithTimeout(
                joinUrl(this.config.endpoint, "/messages"),
                {
                method: "POST",
                headers: {
                  "x-api-key": this.config.apiKey,
                  "Content-Type": "application/json",
                  "anthropic-version": "2023-06-01",
                },
                body: JSON.stringify(requestBody),
                },
                REQUEST_TIMEOUT_MS,
              );
            } catch (error) {
              throw new ApiConnectionError(
                `Anthropic API 连接失败: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
              );
            }

            if (!response.ok) {
              throw await createHttpError(response, "Anthropic API 请求失败");
            }

            let content = "";
            let usageInfo: Record<string, unknown> = {};
            let reasoning = "";
            const toolCallChunks = new Map<number, MutableAnthropicToolCall>();

            await collectJsonSse<Record<string, unknown>>(
              response,
              async (data) => {
                if (data.type === "content_block_delta") {
                  const delta = isRecord(data.delta) ? data.delta : undefined;
                  const contentBlockIndex = getIntegerOrUndefined(data.index);
                  if (delta?.type === "text_delta" && typeof delta.text === "string") {
                    content += delta.text;
                    this.requestObserver?.onRequestProgress?.({
                      requestId,
                      completionTextDelta: delta.text,
                    });
                  }
                  if (delta?.type === "thinking_delta") {
                    const thinkingText = extractAnthropicReasoningDelta(delta);
                    if (thinkingText) {
                      thinkingLoopDetector.addThinkingText(thinkingText);
                      reasoning += thinkingText;
                    }
                  }
                  if (
                    delta?.type === "input_json_delta" &&
                    typeof delta.partial_json === "string" &&
                    contentBlockIndex !== undefined
                  ) {
                    const chunk = toolCallChunks.get(contentBlockIndex) ?? {
                      argumentsText: "",
                    };
                    chunk.argumentsText += delta.partial_json;
                    toolCallChunks.set(contentBlockIndex, chunk);
                  }
                  return;
                }

                if (data.type === "content_block_start") {
                  const contentBlockIndex = getIntegerOrUndefined(data.index);
                  const contentBlock = isRecord(data.content_block)
                    ? data.content_block
                    : undefined;
                  if (contentBlock?.type === "thinking") {
                    const thinkingText = extractAnthropicReasoningDelta(contentBlock);
                    if (thinkingText) {
                      thinkingLoopDetector.addThinkingText(thinkingText);
                      reasoning += thinkingText;
                    }
                  }
                  if (contentBlock?.type === "tool_use" && contentBlockIndex !== undefined) {
                    toolCallChunks.set(contentBlockIndex, {
                      id: typeof contentBlock.id === "string" ? contentBlock.id : undefined,
                      name: typeof contentBlock.name === "string" ? contentBlock.name : undefined,
                      argumentsText: isRecord(contentBlock.input)
                        ? JSON.stringify(contentBlock.input)
                        : "",
                    });
                  }
                  return;
                }

                if (data.type === "message_delta" && isRecord(data.usage)) {
                  usageInfo = {
                    ...usageInfo,
                    ...data.usage,
                  };
                  return;
                }

                if (data.type === "message_start" && isRecord(data.message)) {
                  const usage = isRecord(data.message.usage) ? data.message.usage : undefined;
                  if (usage) {
                    usageInfo = {
                      ...usageInfo,
                      ...usage,
                    };
                  }
                }
              },
              {
                idleTimeoutMs: REQUEST_TIMEOUT_MS,
              },
            );

            if (!content.trim()) {
              const toolCalls = finalizeAnthropicToolCalls(toolCallChunks);
              if (toolCalls.length === 0) {
                throw new AnthropicEmptyResponseError();
              }

              return {
                response: toChatResponse(content, toolCalls),
                statistics: {
                  promptTokens: getInteger(usageInfo.input_tokens),
                  completionTokens: getInteger(usageInfo.output_tokens),
                  totalTokens:
                    getInteger(usageInfo.input_tokens) + getInteger(usageInfo.output_tokens),
                },
                reasoning,
              };
            }

            await runOutputValidator(content, options);

            const toolCalls = finalizeAnthropicToolCalls(toolCallChunks);

            const statistics: CompletionResponseStatistics = {
              promptTokens: getInteger(usageInfo.input_tokens),
              completionTokens: getInteger(usageInfo.output_tokens),
              totalTokens:
                getInteger(usageInfo.input_tokens) + getInteger(usageInfo.output_tokens),
            };

            return {
              response: toChatResponse(content, toolCalls),
              statistics,
              reasoning,
            };
          });
        },
        {
          retries: this.config.retries,
          minDelayMs: 2_000,
          maxDelayMs: 10_000,
          multiplier: 2,
          shouldRetry: isRetryableAnthropicError,
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
        reasoning: result.reasoning || undefined,
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
      throw normalizeAnthropicError(error);
    }
  }
}

function getInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

type MutableAnthropicToolCall = {
  id?: string;
  name?: string;
  argumentsText: string;
};

function getIntegerOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finalizeAnthropicToolCalls(
  toolCallChunks: Map<number, MutableAnthropicToolCall>,
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

function toAnthropicTools(tools: LlmToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema ?? {
      type: "object",
      additionalProperties: false,
    },
  }));
}

function toAnthropicToolChoice(toolChoice: LlmToolChoice | undefined): unknown {
  if (toolChoice === undefined || toolChoice === "none") {
    return undefined;
  }

  if (toolChoice === "auto") {
    return { type: "auto" };
  }

  if (toolChoice === "required") {
    return { type: "any" };
  }

  return {
    type: "tool",
    name: toolChoice.name,
  };
}

function toAnthropicMessages(
  messages: ReadonlyArray<LlmConversationMessage>,
): {
  systemPrompt?: string;
  messages: unknown[];
} {
  const systemMessages: string[] = [];
  const providerMessages: unknown[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemMessages.push(message.content);
      continue;
    }

    if (message.role === "tool") {
      providerMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: message.content,
            ...(message.isError ? { is_error: true } : {}),
          },
        ],
      });
      continue;
    }

    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      providerMessages.push({
        role: "assistant",
        content: [
          ...(message.content
            ? [
                {
                  type: "text",
                  text: message.content,
                },
              ]
            : []),
          ...message.toolCalls.map((toolCall) => ({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.name,
            input: normalizeAnthropicToolInput(toolCall),
          })),
        ],
      });
      continue;
    }

    providerMessages.push({
      role: message.role,
      content: message.content,
    });
  }

  const systemPrompt = systemMessages.length > 0 ? systemMessages.join("\n\n") : undefined;
  return {
    systemPrompt,
    messages: providerMessages,
  };
}

function normalizeAnthropicToolInput(toolCall: LlmToolCall): Record<string, unknown> {
  const value = toolCall.arguments;
  if (isRecord(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return {
      value,
    };
  }

  if (value !== undefined) {
    return {
      value,
    };
  }

  if (toolCall.argumentsText?.trim()) {
    return {
      rawArgumentsText: toolCall.argumentsText,
    };
  }

  return {};
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

function extractAnthropicReasoningDelta(value: Record<string, unknown>): string {
  for (const key of ["thinking", "text", "content"]) {
    const candidate = value[key];
    if (typeof candidate === "string") {
      return candidate;
    }
  }

  return "";
}

function isRetryableAnthropicError(error: unknown): boolean {
  if (isRetryableOutputValidationError(error)) {
    return true;
  }

  if (error instanceof ApiHttpError) {
    return error.status === 429 || error.status >= 500;
  }

  return (
    error instanceof ApiConnectionError ||
    error instanceof AnthropicEmptyResponseError ||
    error instanceof ThinkingLoopError
  );
}

function normalizeAnthropicError(error: unknown): Error {
  if (error instanceof ApiHttpError) {
    return new Error(
      `Anthropic API 请求最终失败: ${error.status} - ${error.responseText}`,
      { cause: error },
    );
  }

  if (error instanceof ApiConnectionError) {
    return new Error(error.message, { cause: error });
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error(`Anthropic 请求异常: ${String(error)}`);
}
