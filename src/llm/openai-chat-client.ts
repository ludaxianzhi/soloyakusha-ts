/**
 * 实现基于 OpenAI 兼容接口的聊天补全客户端，负责流式响应解析与重试控制。
 *
 * 本模块实现 {@link ChatClient} 的 OpenAI 兼容版本，支持：
 * - OpenAI 官方 API
 * - 兼容 OpenAI 协议的第三方服务（如 DeepSeek、Moonshot 等）
 *
 * 核心特性：
 * - 流式响应处理：实时解析 SSE 事件，支持进度回调
 * - 智能重试：对 429 限流和 5xx 错误自动退避重试
 * - 速率限制：支持 QPS 和并发双重限制
 * - 推理内容提取：支持解析 reasoning_content 等推理过程字段
 *
 * @module llm/openai-chat-client
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
  estimateTokensFromText,
  getDurationSeconds,
  isRecord,
  joinUrl,
  retryAsync,
} from "./utils.ts";

const REQUEST_TIMEOUT_MS = 300_000;

class OpenAIEmptyResponseError extends Error {
  constructor() {
    super("OpenAI 返回了空响应");
    this.name = "OpenAIEmptyResponseError";
  }
}

/**
 * OpenAI 聊天客户端实现，负责请求构造、流式响应解析、重试与速率控制。
 *
 * 请求流程：
 * 1. 获取速率限制令牌
 * 2. 构造请求体（包含 messages、temperature 等参数）
 * 3. 发送 POST 请求到 /chat/completions 端点
 * 4. 流式读取 SSE 响应，解析补全内容与 usage 信息
 * 5. 失败时按策略重试
 *
 * 支持的响应字段：
 * - delta.content: 标准补全内容
 * - delta.reasoning_content / reasoning_text: 推理过程（用于 o1 类模型）
 */
export class OpenAIChatClient extends ChatClient {
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
    const { requestId, startedAt } = this.startRequest("openai");
    let diagnostics = "";

    try {
      const result = await retryAsync(
        async () => {
          const release = await this.rateLimiter.acquire();
          const thinkingLoopDetector = new ThinkingLoopDetector();

          try {
            const messages: Array<{ role: "system" | "user"; content: string }> = [
              { role: "user", content: prompt },
            ];
            if (requestConfig.systemPrompt) {
              messages.unshift({
                role: "system",
                content: requestConfig.systemPrompt,
              });
            }

            const requestBody: Record<string, unknown> = {
              model: this.config.modelName,
              messages,
              temperature: requestConfig.temperature,
              max_tokens: requestConfig.maxTokens,
              top_p: requestConfig.topP,
              stream: true,
              ...(requestConfig.extraBody ?? {}),
            };

            let response: Response;
            try {
              response = await fetch(joinUrl(this.config.endpoint, "/chat/completions"), {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${this.config.apiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(requestBody),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
              });
            } catch (error) {
              throw new ApiConnectionError(
                `OpenAI API 连接失败: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
              );
            }

            if (!response.ok) {
              throw await createHttpError(response, "OpenAI API 请求失败");
            }

            let content = "";
            let usageInfo: Record<string, unknown> = {};
            let thinkingTokensEstimate = 0;
            let reasoning = "";

            const streamResult = await collectJsonSse<Record<string, unknown>>(
              response,
              async (data) => {
                const choices = Array.isArray(data.choices) ? data.choices : [];

                for (const choice of choices) {
                  if (!isRecord(choice)) {
                    continue;
                  }

                  const delta = isRecord(choice.delta) ? choice.delta : {};
                  const { completionParts, reasoningParts } =
                    extractOpenAiDeltaTexts(delta);

                  for (const deltaText of completionParts) {
                    if (!deltaText) {
                      continue;
                    }

                    content += deltaText;
                    this.requestObserver?.onRequestProgress?.({
                      requestId,
                      completionTextDelta: deltaText,
                    });
                  }

                  for (const reasoningText of reasoningParts) {
                    if (!reasoningText) {
                      continue;
                    }

                    thinkingLoopDetector.addThinkingText(reasoningText);
                    reasoning += reasoningText;
                    thinkingTokensEstimate += estimateTokensFromText(reasoningText);
                    this.requestObserver?.onRequestProgress?.({
                      requestId,
                      thinkingTokens: thinkingTokensEstimate,
                    });
                  }
                }

                if (isRecord(data.usage)) {
                  usageInfo = data.usage;
                  const providerReasoningTokens = extractReasoningTokensFromUsage(
                    data.usage,
                  );
                  if (providerReasoningTokens !== undefined) {
                    thinkingTokensEstimate = providerReasoningTokens;
                    this.requestObserver?.onRequestProgress?.({
                      requestId,
                      thinkingTokens: thinkingTokensEstimate,
                    });
                  }
                }
              },
            );

            diagnostics =
              streamResult.parseErrors.length > 0 || streamResult.events.length > 0
                ? JSON.stringify(
                    {
                      streamParseErrors: streamResult.parseErrors,
                      streamRawLines:
                        streamResult.parseErrors.length > 0
                          ? streamResult.rawLines
                          : [],
                      streamJsonChunks: streamResult.events,
                    },
                    null,
                    2,
                  )
                : "";

            if (!content.trim()) {
              throw new OpenAIEmptyResponseError();
            }

            await runOutputValidator(content, options);

            const statistics: CompletionResponseStatistics = {
              promptTokens: getInteger(usageInfo.prompt_tokens),
              completionTokens: getInteger(usageInfo.completion_tokens),
              totalTokens: getInteger(usageInfo.total_tokens),
            };

            return {
              content,
              statistics,
              thinkingTokensEstimate,
              reasoning,
            };
          } finally {
            release();
          }
        },
        {
          retries: this.config.retries,
          minDelayMs: 8_000,
          maxDelayMs: 120_000,
          multiplier: 2,
          shouldRetry: isRetryableOpenAiError,
          onRetry: ({ attempt, maxAttempts, nextDelayMs, error }) => {
            if (error instanceof ThinkingLoopError) {
              console.warn(
                `OpenAI 检测到思考死循环，${(nextDelayMs / 1000).toFixed(1)} 秒后进行第 ${attempt + 1}/${maxAttempts} 次尝试`,
              );
              return;
            }

            if (error instanceof ApiHttpError && error.status === 429) {
              console.warn(
                `OpenAI 遇到 429 限流，${(nextDelayMs / 1000).toFixed(1)} 秒后进行第 ${attempt + 1}/${maxAttempts} 次尝试`,
              );
            }
          },
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
      this.requestObserver?.onRequestFinish?.({
        requestId,
        thinkingTokens:
          result.thinkingTokensEstimate > 0 ? result.thinkingTokensEstimate : undefined,
      });

      return result.content;
    } catch (error) {
      const responseBody =
        error instanceof ApiHttpError
          ? diagnostics || error.responseText
          : diagnostics || undefined;
      await this.logFailure(prompt, requestId, startedAt, error, { ...options, requestConfig }, responseBody);
      throw normalizeOpenAiError(error, responseBody);
    }
  }
}

function extractOpenAiDeltaTexts(delta: Record<string, unknown>): {
  completionParts: string[];
  reasoningParts: string[];
} {
  const completionParts: string[] = [];
  const reasoningParts: string[] = [];

  const content = delta.content;
  if (typeof content === "string") {
    completionParts.push(content);
  } else if (Array.isArray(content)) {
    const nestedParts = extractTextFromContentParts(content);
    completionParts.push(...nestedParts.completionParts);
    reasoningParts.push(...nestedParts.reasoningParts);
  }

  for (const key of [
    "reasoning",
    "reasoning_content",
    "reasoning_text",
    "thinking",
    "analysis",
  ]) {
    const value = delta[key];
    if (typeof value === "string") {
      reasoningParts.push(value);
      continue;
    }

    if (Array.isArray(value)) {
      const nestedParts = extractTextFromContentParts(value);
      reasoningParts.push(...nestedParts.reasoningParts);
      continue;
    }

    if (isRecord(value)) {
      const text = extractText(value);
      if (text) {
        reasoningParts.push(text);
      }
    }
  }

  return {
    completionParts,
    reasoningParts,
  };
}

function extractTextFromContentParts(parts: unknown[]): {
  completionParts: string[];
  reasoningParts: string[];
} {
  const completionParts: string[] = [];
  const reasoningParts: string[] = [];

  for (const part of parts) {
    if (typeof part === "string") {
      completionParts.push(part);
      continue;
    }

    if (!isRecord(part)) {
      continue;
    }

    const partType = String(part.type ?? "").toLowerCase();
    const text = extractText(part);
    if (!text) {
      continue;
    }

    if (
      [
        "reasoning",
        "reasoning_text",
        "reasoning_content",
        "thinking",
        "thinking_delta",
        "analysis",
      ].includes(partType)
    ) {
      reasoningParts.push(text);
    } else {
      completionParts.push(text);
    }
  }

  return {
    completionParts,
    reasoningParts,
  };
}

function extractText(value: Record<string, unknown>): string {
  for (const key of [
    "text",
    "content",
    "value",
    "thinking",
    "reasoning_content",
    "reasoning",
  ]) {
    const nestedValue = value[key];
    if (typeof nestedValue === "string") {
      return nestedValue;
    }
  }

  return "";
}

function extractReasoningTokensFromUsage(
  usageInfo: Record<string, unknown>,
): number | undefined {
  const completionDetails = usageInfo.completion_tokens_details;
  if (isRecord(completionDetails) && typeof completionDetails.reasoning_tokens === "number") {
    return completionDetails.reasoning_tokens;
  }

  const outputDetails = usageInfo.output_tokens_details;
  if (isRecord(outputDetails) && typeof outputDetails.reasoning_tokens === "number") {
    return outputDetails.reasoning_tokens;
  }

  return undefined;
}

function getInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRetryableOpenAiError(error: unknown): boolean {
  if (isRetryableOutputValidationError(error)) {
    return true;
  }

  if (error instanceof ApiHttpError) {
    return error.status === 429 || error.status >= 500;
  }

  return (
    error instanceof ApiConnectionError ||
    error instanceof OpenAIEmptyResponseError ||
    error instanceof ThinkingLoopError
  );
}

function normalizeOpenAiError(error: unknown, responseBody?: string): Error {
  if (error instanceof ApiHttpError) {
    return new Error(
      `OpenAI API 请求最终失败: ${error.status} - ${responseBody ?? error.responseText}`,
      { cause: error },
    );
  }

  if (error instanceof ApiConnectionError) {
    return new Error(error.message, { cause: error });
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error(`OpenAI 请求异常: ${String(error)}`);
}
