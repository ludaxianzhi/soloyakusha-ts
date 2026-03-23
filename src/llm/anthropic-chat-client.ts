/**
 * 实现 Anthropic Claude 聊天客户端，负责消息构造、流式解析与错误处理。
 */

import { ChatClient } from "./base.ts";
import { RateLimiter } from "./rate-limiter.ts";
import type {
  ChatRequestOptions,
  ClientHooks,
  CompletionResponseStatistics,
  LlmClientConfig,
} from "./types.ts";
import { resolveRequestConfig } from "./types.ts";
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

            await options.outputValidator?.(content, options.outputValidationContext);

            const statistics: CompletionResponseStatistics = {
              promptTokens: getInteger(usageInfo.input_tokens),
              completionTokens: getInteger(usageInfo.output_tokens),
              totalTokens:
                getInteger(usageInfo.input_tokens) + getInteger(usageInfo.output_tokens),
            };

            return {
              content,
              statistics,
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
        statistics: result.statistics,
        modelName: this.config.modelName,
        durationSeconds,
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

function isRetryableAnthropicError(error: unknown): boolean {
  if (error instanceof ApiHttpError) {
    return error.status === 429 || error.status >= 500;
  }

  return error instanceof ApiConnectionError || error instanceof AnthropicEmptyResponseError;
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
