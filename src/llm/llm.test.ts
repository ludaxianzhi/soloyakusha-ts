import { describe, expect, test } from "bun:test";
import { AnthropicChatClient } from "./anthropic-chat-client.ts";
import { ChatClient } from "./base.ts";
import { isRetryableOutputValidationError, runOutputValidator } from "./chat-request.ts";
import { FallbackChatClient } from "./fallback-chat-client.ts";
import { OpenAIChatClient } from "./openai-chat-client.ts";
import { LlmClientProvider } from "./provider.ts";
import { RateLimiter } from "./rate-limiter.ts";
import type { ChatRequestOptions, LlmClientConfig } from "./types.ts";
import { createLlmClientConfig, resolveRequestConfig, ThinkingLoopError } from "./types.ts";
import { retryAsync } from "./utils.ts";

describe("resolveRequestConfig", () => {
  test("merges default config and extraBody overrides", () => {
    const resolved = resolveRequestConfig(
      {
        temperature: 0.1,
        extraBody: {
          response_format: "json_schema",
        },
      },
      {
        systemPrompt: "system",
        maxTokens: 512,
        extraBody: {
          seed: 7,
        },
      },
    );

    expect(resolved).toEqual({
      systemPrompt: "system",
      temperature: 0.1,
      maxTokens: 512,
      topP: 1,
      extraBody: {
        seed: 7,
        response_format: "json_schema",
      },
    });
  });

  test("does not inject maxTokens when neither default nor override specifies it", () => {
    const resolved = resolveRequestConfig(
      {
        extraBody: {
          response_format: "json_schema",
        },
      },
      {
        systemPrompt: "system",
      },
    );

    expect(resolved).toEqual({
      systemPrompt: "system",
      temperature: 0.7,
      topP: 1,
      extraBody: {
        response_format: "json_schema",
      },
    });
    expect("maxTokens" in resolved).toBe(false);
  });
});

describe("createLlmClientConfig", () => {
  test("resolves apiKey from environment variables", () => {
    process.env.SOLOYAKUSHA_TEST_KEY = "env-secret";

    const config = createLlmClientConfig({
      modelName: "gpt-test",
      endpoint: "https://example.com/v1",
      apiKeyEnv: "SOLOYAKUSHA_TEST_KEY",
    });

    expect(config.apiKey).toBe("env-secret");
    expect(config.provider).toBe("openai");
    expect(config.modelType).toBe("chat");
    expect(config.retries).toBe(3);
  });

  test("preserves sparse default request config without adding maxTokens", () => {
    const config = createLlmClientConfig({
      modelName: "gpt-test",
      endpoint: "https://example.com/v1",
      apiKey: "secret",
      defaultRequestConfig: {
        temperature: 0.2,
      },
    });

    expect(config.defaultRequestConfig).toEqual({
      temperature: 0.2,
      topP: 1,
    });
    expect(config.defaultRequestConfig && "maxTokens" in config.defaultRequestConfig).toBe(false);
  });
});

describe("RateLimiter", () => {
  test("runs tasks without limiting when no constraints are configured", async () => {
    const limiter = new RateLimiter();

    await expect(limiter.run(async () => 42)).resolves.toBe(42);
  });

  test("limits concurrent tasks with maxParallel", async () => {
    const limiter = new RateLimiter({ maxParallel: 1 });
    let secondStarted = false;
    let firstStartedResolve!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedResolve = resolve;
    });

    const first = limiter.run(
      async () =>
        new Promise<void>((resolve) => {
          firstStartedResolve();
          releaseFirst = resolve;
        }),
    );

    await firstStarted;

    const second = limiter.run(async () => {
      secondStarted = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondStarted).toBe(false);

    releaseFirst();
    await first;
    await second;
    expect(secondStarted).toBe(true);
  });
});

describe("LlmClientProvider", () => {
  test("reuses the same instance for equivalent configs", () => {
    const provider = new LlmClientProvider();
    provider.register("primary", {
      provider: "openai",
      modelType: "chat",
      modelName: "gpt-4.1",
      endpoint: "https://example.com/v1",
      apiKey: "secret",
    });
    provider.register("alias", {
      provider: "openai",
      modelType: "chat",
      modelName: "gpt-4.1",
      endpoint: "https://example.com/v1",
      apiKey: "secret",
    });

    const primary = provider.getChatClient("primary");
    const alias = provider.getChatClient("alias");

    expect(primary).toBe(alias);
    expect(primary).toBeInstanceOf(ChatClient);
  });
});

describe("FallbackChatClient", () => {
  test("falls back to the next model and restarts from the first model for the next request", async () => {
    const primary = new StubChatClient("primary", [new Error("primary down"), "primary success"]);
    const fallback = new StubChatClient("fallback", ["fallback success"]);
    const client = new FallbackChatClient([primary, fallback]);

    await expect(client.singleTurnRequest("first")).resolves.toBe("fallback success");
    await expect(client.singleTurnRequest("second")).resolves.toBe("primary success");
    expect(primary.prompts).toEqual(["first", "second"]);
    expect(fallback.prompts).toEqual(["first"]);
  });

  test("reports all model failures after exhausting the fallback chain", async () => {
    const primary = new StubChatClient("primary", [new Error("primary down")]);
    const fallback = new StubChatClient("fallback", [new Error("fallback down")]);
    const client = new FallbackChatClient([primary, fallback]);

    await expect(client.singleTurnRequest("prompt")).rejects.toThrow(
      "模型回退链全部失败：primary: primary down | fallback: fallback down",
    );
  });

  test("retries output validation failures before falling back", async () => {
    const primary = new RetryingStubChatClient("primary", ["not-json", "still-not-json"], 2);
    const fallback = new RetryingStubChatClient("fallback", ['{"ok":true}'], 2);
    const client = new FallbackChatClient([primary, fallback]);

    await expect(
      client.singleTurnRequest("prompt", {
        outputValidator(responseText) {
          JSON.parse(responseText);
        },
      }),
    ).resolves.toBe('{"ok":true}');
    expect(primary.prompts).toEqual(["prompt", "prompt"]);
    expect(fallback.prompts).toEqual(["prompt"]);
  });
});

describe("OpenAIChatClient", () => {
  test("stores reasoning text and meta in completion history", async () => {
    const historyEntries: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    const fetchMock = Object.assign(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(
                encoder.encode(
                  [
                    'data: {"choices":[{"delta":{"reasoning_content":"先思考。"}}]}',
                    'data: {"choices":[{"delta":{"content":"最终答案"}}]}',
                    'data: {"usage":{"prompt_tokens":10,"completion_tokens":6,"total_tokens":16,"completion_tokens_details":{"reasoning_tokens":2}}}',
                    "data: [DONE]",
                    "",
                  ].join("\n"),
                ),
              );
              controller.close();
            },
          }),
          { status: 200 },
        ),
      {
        preconnect: originalFetch.preconnect,
      },
    ) satisfies typeof fetch;
    globalThis.fetch = fetchMock;

    try {
      const client = new OpenAIChatClient(createStubConfig("reasoning-model"), {
        historyLogger: {
          async logCompletion(entry) {
            historyEntries.push(entry as Record<string, unknown>);
          },
          async logError(entry) {
            historyEntries.push(entry as Record<string, unknown>);
          },
        },
      });

      await expect(
        client.singleTurnRequest("prompt", {
          meta: {
            label: "翻译-最终翻译",
            feature: "翻译",
            operation: "最终翻译",
          },
        }),
      ).resolves.toBe("最终答案");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(historyEntries).toHaveLength(1);
    expect(historyEntries[0]).toMatchObject({
      response: "最终答案",
      reasoning: "先思考。",
      meta: {
        label: "翻译-最终翻译",
        feature: "翻译",
        operation: "最终翻译",
      },
    });
  });

  test("throws ThinkingLoopError when reasoning stream enters repetitive loop", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = Object.assign(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              const repeatedChunk = "a".repeat(2000);
              const lines = Array.from({ length: 5 }, () =>
                `data: ${JSON.stringify({
                  choices: [{ delta: { reasoning_content: repeatedChunk } }],
                })}`,
              );

              controller.enqueue(
                encoder.encode([...lines, "data: [DONE]", ""].join("\n")),
              );
              controller.close();
            },
          }),
          { status: 200 },
        ),
      {
        preconnect: originalFetch.preconnect,
      },
    ) satisfies typeof fetch;
    globalThis.fetch = fetchMock;

    try {
      const client = new OpenAIChatClient({
        ...createStubConfig("reasoning-loop-model"),
        retries: 1,
      });

      await expect(client.singleTurnRequest("prompt")).rejects.toBeInstanceOf(
        ThinkingLoopError,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("AnthropicChatClient", () => {
  test("throws ThinkingLoopError when thinking stream enters repetitive loop", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = Object.assign(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              const repeatedChunk = "a".repeat(2000);
              const lines = Array.from({ length: 5 }, () =>
                `data: ${JSON.stringify({
                  type: "content_block_delta",
                  delta: {
                    type: "thinking_delta",
                    thinking: repeatedChunk,
                  },
                })}`,
              );

              controller.enqueue(
                encoder.encode([...lines, 'data: {"type":"message_stop"}', ""].join("\n")),
              );
              controller.close();
            },
          }),
          { status: 200 },
        ),
      {
        preconnect: originalFetch.preconnect,
      },
    ) satisfies typeof fetch;
    globalThis.fetch = fetchMock;

    try {
      const client = new AnthropicChatClient({
        provider: "anthropic",
        modelName: "claude-loop-model",
        endpoint: "https://example.com/v1",
        apiKey: "secret",
        modelType: "chat",
        retries: 1,
      });

      await expect(client.singleTurnRequest("prompt")).rejects.toBeInstanceOf(
        ThinkingLoopError,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

class StubChatClient extends ChatClient {
  readonly prompts: string[] = [];

  constructor(
    modelName: string,
    private readonly responses: Array<string | Error>,
  ) {
    super(createStubConfig(modelName));
  }

  override async singleTurnRequest(
    prompt: string,
    _options?: ChatRequestOptions,
  ): Promise<string> {
    this.prompts.push(prompt);
    const next = this.responses.shift();
    if (!next) {
      throw new Error("missing test response");
    }
    if (next instanceof Error) {
      throw next;
    }

    return next;
  }
}

class RetryingStubChatClient extends ChatClient {
  readonly prompts: string[] = [];

  constructor(
    modelName: string,
    private readonly responses: Array<string | Error>,
    retries: number,
  ) {
    super({
      ...createStubConfig(modelName),
      retries,
    });
  }

  override async singleTurnRequest(
    prompt: string,
    options: ChatRequestOptions = {},
  ): Promise<string> {
    return retryAsync(
      async () => {
        this.prompts.push(prompt);
        const next = this.responses.shift();
        if (!next) {
          throw new Error("missing test response");
        }
        if (next instanceof Error) {
          throw next;
        }

        await runOutputValidator(next, options);
        return next;
      },
      {
        retries: this.config.retries,
        minDelayMs: 0,
        maxDelayMs: 0,
        multiplier: 1,
        shouldRetry: isRetryableOutputValidationError,
      },
    );
  }
}

function createStubConfig(modelName: string): LlmClientConfig {
  return {
    provider: "openai",
    modelName,
    endpoint: "https://example.com/v1",
    apiKey: "secret",
    modelType: "chat",
    retries: 0,
    supportsStructuredOutput: true,
  };
}
