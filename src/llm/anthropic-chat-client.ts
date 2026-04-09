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
  runOutputValidator,
} from "./chat-request.ts";
import { RateLimiter } from "./rate-limiter.ts";
import type {
  ChatRequestOptions,
  ClientHooks,
  CompletionResponseStatistics,
  LlmClientConfig,
} from "./types.ts";
import { resolveRequestConfig, ThinkingLoopError } from "./types.ts";
import { ThinkingLoopDetector } from "./thinking-loop-detector.ts";
import {
  ApiConnectionError,
  ApiHttpError,
  collectJsonSse,
  createHttpError,
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
    const requestConfig = resolveRequestConfig(
      options.requestConfig,
      this.config.defaultRequestConfig,
    );
    const { requestId, startedAt } = this.startRequest("anthropic");

    try {
      const result = await retryAsync(
        async () => {
          const release = await this.rateLimiter.acquire();
          const thinkingLoopDetector = new ThinkingLoopDetector();
          try {
            const requestBody: Record<string, unknown> = {
              model: this.config.modelName,
              messages: [{ role: "user", content: prompt }],
              temperature: requestConfig.temperature,
              max_tokens: requestConfig.maxTokens,
              top_p: requestConfig.topP,
              stream: true,
              ...(requestConfig.extraBody ?? {}),
            };

            if (requestConfig.systemPrompt) {
              requestBody.system = requestConfig.systemPrompt;
            }

            let response: Response;
            try {
              response = await fetch(joinUrl(this.config.endpoint, "/messages"), {
                method: "POST",
                headers: {
                  "x-api-key": this.config.apiKey,
                  "Content-Type": "application/json",
                  "anthropic-version": "2023-06-01",
                },
                body: JSON.stringify(requestBody),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
              });
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

            await collectJsonSse<Record<string, unknown>>(response, async (data) => {
              if (data.type === "content_block_delta") {
                const delta = isRecord(data.delta) ? data.delta : undefined;
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
                return;
              }

              if (data.type === "content_block_start") {
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
            });

            if (!content.trim()) {
              throw new AnthropicEmptyResponseError();
            }

            await runOutputValidator(content, options);

            const statistics: CompletionResponseStatistics = {
              promptTokens: getInteger(usageInfo.input_tokens),
              completionTokens: getInteger(usageInfo.output_tokens),
              totalTokens:
                getInteger(usageInfo.input_tokens) + getInteger(usageInfo.output_tokens),
            };

            return {
              content,
              statistics,
              reasoning,
            };
          } finally {
            release();
          }
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
        prompt,
        response: result.content,
        requestId,
        requestConfig,
        meta: options.meta,
        statistics: result.statistics,
        modelName: this.config.modelName,
        durationSeconds,
        reasoning: result.reasoning || undefined,
      });
      this.requestObserver?.onRequestFinish?.({ requestId });

      return result.content;
    } catch (error) {
      const responseBody = error instanceof ApiHttpError ? error.responseText : undefined;
      await this.logFailure(prompt, requestId, startedAt, error, { ...options, requestConfig }, responseBody);
      throw normalizeAnthropicError(error);
    }
  }
}

function getInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
