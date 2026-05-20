/**
 * 提供 LLM 网络访问相关的通用错误类型、重试、SSE 解析和辅助工具函数。
 *
 * 本模块提供 LLM 客户端共用的基础能力：
 * - 错误类型：ApiHttpError、ApiConnectionError
 * - 重试策略：retryAsync 函数，支持指数退避
 * - 流式解析：collectJsonSse 函数，解析 SSE JSON 事件流
 * - 辅助函数：URL拼接、JSON 序列化、Duration 计算
 *
 * @module llm/utils
 */

import type { JsonObject, JsonValue } from "./types.ts";

/**
 * HTTP 请求错误，包含状态码与响应体。
 *
 * 用于服务端返回非 2xx 响应时抛出，上层可据此判断是否重试。
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
 * 网络连接错误，表示请求未能获得有效的 HTTP 响应。
 *
 * 触发场景：DNS 解析失败、连接超时、网络中断等。
 */
export class ApiConnectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ApiConnectionError";
  }
}

/**
 * 请求被外部取消（AbortSignal）时抛出的错误。
 * 上层应据此区分「请求被打断」和「真正的错误」，避免误记失败日志。
 */
export class AbortError extends Error {
  constructor(message = "请求已被取消") {
    super(message);
    this.name = "AbortError";
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new AbortError());
  }

  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(resolve, ms);

    if (signal) {
      const onAbort = () => {
        clearTimeout(timeoutHandle);
        reject(new AbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
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
    signal?: AbortSignal;
  },
): Promise<T> {
  let attempt = 1;

  while (true) {
    try {
      return await run(attempt);
    } catch (error) {
      if (error instanceof AbortError || (options.signal?.aborted)) {
        throw new AbortError();
      }

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

      await sleep(nextDelayMs, options.signal);
      attempt += 1;
    }
  }
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const combinedSignal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;

  try {
    return await fetch(input, {
      ...init,
      signal: combinedSignal,
    });
  } finally {
    clearTimeout(timeoutHandle);
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
  options: {
    idleTimeoutMs?: number;
    signal?: AbortSignal;
  } = {},
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

  const signal = options.signal;

  while (true) {
    if (signal?.aborted) {
      await reader.cancel("aborted").catch(() => {});
      throw new AbortError();
    }

    const { done, value } = await readWithIdleTimeout(reader, options.idleTimeoutMs, signal);
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

      let parsed: T;
      try {
        parsed = JSON.parse(payload) as T;
      } catch {
        parseErrors.push(line);
        continue;
      }

      events.push(parsed);
      await onEvent(parsed);
    }
  }

  const trailingLine = buffer.replace(/\r$/, "");
  if (trailingLine.length > 0) {
    rawLines.push(trailingLine);
    const trimmedLine = trailingLine.trim();
    if (trimmedLine.startsWith("data: ")) {
      const payload = trimmedLine.slice(6);
      if (payload !== "[DONE]") {
        let parsed: T | undefined;
        try {
          parsed = JSON.parse(payload) as T;
        } catch {
          parseErrors.push(trailingLine);
        }

        if (parsed !== undefined) {
          events.push(parsed);
          await onEvent(parsed);
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

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs?: number,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted) {
    await reader.cancel("aborted").catch(() => {});
    throw new AbortError();
  }

  if (!idleTimeoutMs || idleTimeoutMs <= 0) {
    if (signal) {
      return readWithSignal(reader, signal);
    }
    return reader.read() as Promise<ReadableStreamReadResult<Uint8Array>>;
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      settled = true;
      clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
    };

    const timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }

      cleanup();
      void reader.cancel("idle-timeout");
      reject(
        new ApiConnectionError(
          `流式响应在 ${Math.ceil(idleTimeoutMs / 1000)} 秒内未收到新数据`,
        ),
      );
    }, idleTimeoutMs);

    const onAbort = () => {
      if (settled) {
        return;
      }

      cleanup();
      void reader.cancel("aborted");
      reject(new AbortError());
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    (reader.read() as Promise<ReadableStreamReadResult<Uint8Array>>).then(
      (result) => {
        if (settled) {
          return;
        }

        cleanup();
        resolve(result);
      },
      (error) => {
        if (settled) {
          return;
        }

        cleanup();
        reject(error);
      },
    );
  });
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    await reader.cancel("aborted").catch(() => {});
    throw new AbortError();
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      void reader.cancel("aborted");
      reject(new AbortError());
    };

    signal.addEventListener("abort", onAbort, { once: true });

    (reader.read() as Promise<ReadableStreamReadResult<Uint8Array>>).then(
      (result) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function parseJsonResponseText<T = unknown>(responseText: string): T {
  const trimmed = responseText.replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    throw new Error("响应内容为空");
  }

  const candidates = new Set<string>([trimmed]);
  const fencedBlock = extractFirstCodeBlock(trimmed);
  if (fencedBlock) {
    candidates.add(fencedBlock.trim());
  }

  const extractedJson = extractFirstJsonSubstring(trimmed);
  if (extractedJson) {
    candidates.add(extractedJson.trim());
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch (error) {
      lastError = error;
    }
  }

  const errorMessage =
    lastError instanceof Error ? lastError.message : String(lastError ?? "未知错误");
  throw new Error(`无法从响应中解析 JSON: ${errorMessage}`);
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

function extractFirstCodeBlock(text: string): string | undefined {
  const match = text.match(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/);
  return match?.[1];
}

function extractFirstJsonSubstring(text: string): string | undefined {
  for (let start = 0; start < text.length; start += 1) {
    const opener = text[start];
    if (opener !== "{" && opener !== "[") {
      continue;
    }

    const stack: string[] = [opener];
    let inString = false;
    let escaped = false;

    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === "{" || char === "[") {
        stack.push(char);
        continue;
      }

      if (char === "}" || char === "]") {
        const last = stack.pop();
        if (!last) {
          break;
        }

        if ((last === "{" && char !== "}") || (last === "[" && char !== "]")) {
          break;
        }

        if (stack.length === 0) {
          return text.slice(start, index + 1);
        }
      }
    }
  }

  return undefined;
}
