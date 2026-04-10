import {
  ApiConnectionError,
  ApiHttpError,
  createHttpError,
  joinUrl,
  retryAsync,
} from "../llm/utils.ts";

export async function requestJson<T>(options: {
  endpoint: string;
  path: string;
  method: string;
  timeoutMs: number;
  retries: number;
  errorPrefix: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<T> {
  return retryAsync(
    async () => {
      let response: Response;
      try {
        response = await fetch(joinUrl(options.endpoint, options.path), {
          method: options.method,
          headers: buildHeaders(options.headers, options.body !== undefined),
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch (error) {
        throw new ApiConnectionError(
          `${options.errorPrefix} 连接失败: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }

      if (!response.ok) {
        throw await createHttpError(response, options.errorPrefix);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      const text = await response.text();
      if (!text) {
        return undefined as T;
      }

      return JSON.parse(text) as T;
    },
    {
      retries: options.retries,
      minDelayMs: 1_000,
      maxDelayMs: 8_000,
      multiplier: 2,
      shouldRetry: (error) =>
        error instanceof ApiConnectionError ||
        (error instanceof ApiHttpError &&
          (error.status === 429 || error.status >= 500)),
    },
  );
}

function buildHeaders(
  headers: Record<string, string> | undefined,
  hasBody: boolean,
): Record<string, string> {
  return {
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    ...(headers ?? {}),
  };
}
