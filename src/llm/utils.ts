/**
 * 提供 LLM 网络访问相关的通用错误类型、重试、SSE 解析和辅助工具函数。
 */

import type { JsonObject, JsonValue } from "./types.ts";

/**
 * HTTP 请求错误，包含状态码与响应体，便于上层判断是否需要重试。
 */
export class ApiHttpError extends Error {
  readonly status: number;
  readonly responseText: string;

  constructor(message: string, status: number, responseText: string) {
    super(message);
    this.name = "ApiHttpError";
    this.status = status;
    this.responseText = responseText;
  }
}

/**
 * 网络连接错误，表示请求尚未获得有效的 HTTP 响应。
 */
export class ApiConnectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ApiConnectionError";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  return new URL(normalizedPath, normalizedBase).toString();
}

export async function createHttpError(
  response: Response,
  prefix: string,
): Promise<ApiHttpError> {
  const responseText = await response.text();
  return new ApiHttpError(
    `${prefix}: ${response.status} - ${responseText}`,
    response.status,
    responseText,
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }

  if (!isRecord(value)) {
    return String(value);
  }

  const sortedEntries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const result: JsonObject = {};
  for (const [key, nestedValue] of sortedEntries) {
    result[key] = sortJsonValue(nestedValue);
  }
  return result;
}

export type RetryContext = {
  attempt: number;
  maxAttempts: number;
  nextDelayMs: number;
  error: unknown;
};

export async function retryAsync<T>(
  run: (attempt: number) => Promise<T>,
  options: {
    retries: number;
    minDelayMs: number;
    maxDelayMs: number;
    multiplier: number;
    shouldRetry: (error: unknown) => boolean;
    onRetry?: (context: RetryContext) => void | Promise<void>;
  },
): Promise<T> {
  let attempt = 1;

  while (true) {
    try {
      return await run(attempt);
    } catch (error) {
      const maxAttempts = Math.max(1, options.retries);
      if (attempt >= maxAttempts || !options.shouldRetry(error)) {
        throw error;
      }

      const nextDelayMs = Math.min(
        options.maxDelayMs,
        options.minDelayMs * options.multiplier ** (attempt - 1),
      );

      if (options.onRetry) {
        await options.onRetry({
          attempt,
          maxAttempts,
          nextDelayMs,
          error,
        });
      }

      await sleep(nextDelayMs);
      attempt += 1;
    }
  }
}

export type SseReadResult<T> = {
  rawLines: string[];
  parseErrors: string[];
  events: T[];
};

export async function collectJsonSse<T>(
  response: Response,
  onEvent: (event: T) => void | Promise<void>,
): Promise<SseReadResult<T>> {
  if (!response.body) {
    throw new Error("响应体为空，无法读取流式结果");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const rawLines: string[] = [];
  const parseErrors: string[] = [];
  const events: T[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = consumeLines();
    for (const line of lines) {
      rawLines.push(line);
      const trimmedLine = line.trim();
      if (!trimmedLine || !trimmedLine.startsWith("data: ")) {
        continue;
      }

      const payload = trimmedLine.slice(6);
      if (payload === "[DONE]") {
        continue;
      }

      try {
        const parsed = JSON.parse(payload) as T;
        events.push(parsed);
        await onEvent(parsed);
      } catch {
        parseErrors.push(line);
      }
    }
  }

  const trailingLine = buffer.replace(/\r$/, "");
  if (trailingLine.length > 0) {
    rawLines.push(trailingLine);
    const trimmedLine = trailingLine.trim();
    if (trimmedLine.startsWith("data: ")) {
      const payload = trimmedLine.slice(6);
      if (payload !== "[DONE]") {
        try {
          const parsed = JSON.parse(payload) as T;
          events.push(parsed);
          await onEvent(parsed);
        } catch {
          parseErrors.push(trailingLine);
        }
      }
    }
  }

  return {
    rawLines,
    parseErrors,
    events,
  };

  function consumeLines(): string[] {
    const lines: string[] = [];
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      lines.push(line);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
    return lines;
  }
}

export function estimateTokensFromText(text: string): number {
  if (!text) {
    return 0;
  }

  return Math.max(1, Math.ceil(new TextEncoder().encode(text).length / 3));
}

export function createRequestId(): string {
  return crypto.randomUUID();
}

export function getDurationSeconds(startAt: number): number {
  return (performance.now() - startAt) / 1000;
}
