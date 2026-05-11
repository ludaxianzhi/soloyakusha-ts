import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicChatClient } from "./anthropic-chat-client.ts";
import { ChatClient } from "./base.ts";
import { isRetryableOutputValidationError, runOutputValidator } from "./chat-request.ts";
import { FallbackChatClient } from "./fallback-chat-client.ts";
import { OpenAIChatClient } from "./openai-chat-client.ts";
import { PcaEmbeddingClient } from "./pca-embedding-client.ts";
import { LlmClientProvider } from "./provider.ts";
import { RateLimiter } from "./rate-limiter.ts";
import { createToolLoopChatClient } from "./tool-loop-chat-client.ts";
import type {
  ChatRequestOptions,
  ChatResponse,
  LlmClientConfig,
  LlmConversationMessage,
} from "./types.ts";
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

  test("shallow-merges duplicate extraBody keys with override precedence", () => {
    const resolved = resolveRequestConfig(
      {
        extraBody: {
          response_format: {
            type: "text",
          },
        },
      },
      {
        extraBody: {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "structured_output",
            },
          },
          seed: 7,
        },
      },
    );

    expect(resolved.extraBody).toEqual({
      response_format: {
        type: "text",
      },
      seed: 7,
    });
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

  test("preserves injectVirtualTool flag", () => {
    const config = createLlmClientConfig({
      modelName: "gpt-test",
      endpoint: "https://example.com/v1",
      apiKey: "secret",
      injectVirtualTool: true,
    });

    expect(config.injectVirtualTool).toBe(true);
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

  test("wraps embedding client with PCA projection when configured", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "soloyakusha-llm-pca-"));
    const weightsPath = join(rootDir, "weights.json");

    const componentsBase64 = Buffer.from(
      new Uint8Array(new Float32Array([1, 0]).buffer),
    ).toString("base64");
    const meanBase64 = Buffer.from(
      new Uint8Array(new Float32Array([0, 0]).buffer),
    ).toString("base64");

    await writeFile(
      weightsPath,
      JSON.stringify(
        {
          pca: {
            target_dim: 1,
            input_dim: 2,
            components: {
              dtype: "float32",
              shape: [1, 2],
              data: componentsBase64,
            },
            mean: {
              dtype: "float32",
              shape: [2],
              data: meanBase64,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      const provider = new LlmClientProvider();
      provider.register("embed", {
        provider: "openai",
        modelType: "embedding",
        modelName: "text-embedding-3-small",
        endpoint: "https://example.com/v1",
        apiKey: "secret",
        pca: {
          enabled: true,
          weightsFilePath: weightsPath,
        },
      });

      const embeddingClient = provider.getEmbeddingClient("embed");
      expect(embeddingClient).toBeInstanceOf(PcaEmbeddingClient);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
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
  test("injects the virtual tool into OpenAI chat requests", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | undefined;
    const fetchMock = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(
                encoder.encode(
                  [
                    'data: {"choices":[{"delta":{"content":"ok"}}]}',
                    'data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
                    "data: [DONE]",
                    "",
                  ].join("\n"),
                ),
              );
              controller.close();
            },
          }),
          { status: 200 },
        );
      },
      {
        preconnect: originalFetch.preconnect,
      },
    ) satisfies typeof fetch;
    globalThis.fetch = fetchMock;

    try {
      const client = new OpenAIChatClient({
        ...createStubConfig("tool-primed-model"),
        injectVirtualTool: true,
      });

      await expect(client.singleTurnRequest("prompt")).resolves.toBe("ok");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestBody?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "agent_environment_probe",
          description: expect.stringContaining("Never Use"),
          parameters: {
            type: "object",
            properties: {
              reason: {
                type: "string",
                description: "Unused placeholder field. Never send it.",
              },
            },
            additionalProperties: false,
          },
        },
      },
    ]);
  });

  test("parses streamed OpenAI tool calls from the richer response API", async () => {
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
                    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{\\"q\\":\\"hel"}}]}}]}',
                    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"lo\\"}"}}]}}]}',
                    'data: {"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
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
      const client = new OpenAIChatClient(createStubConfig("tool-call-model"));
      await expect(
        client.singleTurnResponse("prompt", {
          tools: [
            {
              name: "lookup",
              description: "lookup something",
            },
          ],
        }),
      ).resolves.toEqual({
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: "lookup",
            argumentsText: '{"q":"hello"}',
            arguments: {
              q: "hello",
            },
          },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

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
  test("injects and parses Anthropic tools via the richer response API", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | undefined;
    const fetchMock = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(
                encoder.encode(
                  [
                    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup"}}',
                    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"hel"}}',
                    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"lo\\"}"}}',
                    'data: {"type":"message_delta","usage":{"input_tokens":3,"output_tokens":2}}',
                    'data: {"type":"message_stop"}',
                    "",
                  ].join("\n"),
                ),
              );
              controller.close();
            },
          }),
          { status: 200 },
        );
      },
      {
        preconnect: originalFetch.preconnect,
      },
    ) satisfies typeof fetch;
    globalThis.fetch = fetchMock;

    try {
      const client = new AnthropicChatClient({
        provider: "anthropic",
        modelName: "claude-tool-model",
        endpoint: "https://example.com/v1",
        apiKey: "secret",
        modelType: "chat",
        retries: 1,
        injectVirtualTool: true,
      });

      await expect(
        client.singleTurnResponse("prompt", {
          tools: [
            {
              name: "lookup",
              description: "lookup something",
            },
          ],
        }),
      ).resolves.toEqual({
        content: "",
        toolCalls: [
          {
            id: "toolu_1",
            name: "lookup",
            argumentsText: '{"q":"hello"}',
            arguments: {
              q: "hello",
            },
          },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestBody?.tools).toEqual([
      {
        name: "lookup",
        description: "lookup something",
        input_schema: {
          type: "object",
          additionalProperties: false,
        },
      },
      {
        name: "agent_environment_probe",
        description: expect.stringContaining("Never Use"),
        input_schema: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "Unused placeholder field. Never send it.",
            },
          },
          additionalProperties: false,
        },
      },
    ]);
  });

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

describe("ToolLoopChatClient", () => {
  test("runs the tool loop through the provider factory on OpenAI-compatible completions", async () => {
    const originalFetch = globalThis.fetch;
    const requestBodies: Array<Record<string, unknown>> = [];
    let requestCount = 0;
    const fetchMock = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        requestCount += 1;

        if (requestCount === 1) {
          return createSseResponse([
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{\\"q\\":\\"hel"}}]}}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"lo\\"}"}}]}}]}',
            'data: {"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
            'data: [DONE]',
            '',
          ]);
        }

        return createSseResponse([
          'data: {"choices":[{"delta":{"content":"final answer"}}]}',
          'data: {"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13}}',
          'data: [DONE]',
          '',
        ]);
      },
      {
        preconnect: originalFetch.preconnect,
      },
    ) satisfies typeof fetch;
    globalThis.fetch = fetchMock;

    try {
      const provider = new LlmClientProvider();
      provider.register("primary", createStubConfig("gpt-tool-loop"));

      const client = provider.getToolLoopChatClient("primary", {
        tools: [
          {
            name: "lookup",
            description: "lookup something",
            execute(argumentsValue) {
              expect(argumentsValue).toEqual({
                q: "hello",
              });

              return {
                result: "world",
              };
            },
          },
        ],
      });

      await expect(client.singleTurnRequest("prompt")).resolves.toBe("final answer");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.messages).toEqual([
      {
        role: "user",
        content: "prompt",
      },
    ]);
    expect(requestBodies[1]?.messages).toEqual([
      {
        role: "user",
        content: "prompt",
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "lookup",
              arguments: '{"q":"hello"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        name: "lookup",
        content: '{\n  "result": "world"\n}',
      },
    ]);
  });

  test("runs the tool loop through Anthropic message chaining", async () => {
    const originalFetch = globalThis.fetch;
    const requestBodies: Array<Record<string, unknown>> = [];
    let requestCount = 0;
    const fetchMock = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        requestCount += 1;

        if (requestCount === 1) {
          return createSseResponse([
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup"}}',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"hel"}}',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"lo\\"}"}}',
            'data: {"type":"message_delta","usage":{"input_tokens":3,"output_tokens":2}}',
            'data: {"type":"message_stop"}',
            '',
          ]);
        }

        return createSseResponse([
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"final answer"}}',
          'data: {"type":"message_delta","usage":{"input_tokens":8,"output_tokens":4}}',
          'data: {"type":"message_stop"}',
          '',
        ]);
      },
      {
        preconnect: originalFetch.preconnect,
      },
    ) satisfies typeof fetch;
    globalThis.fetch = fetchMock;

    try {
      const client = createToolLoopChatClient(
        new AnthropicChatClient({
          provider: "anthropic",
          modelName: "claude-tool-loop",
          endpoint: "https://example.com/v1",
          apiKey: "secret",
          modelType: "chat",
          retries: 1,
        }),
        {
          tools: [
            {
              name: "lookup",
              description: "lookup something",
              execute(argumentsValue) {
                expect(argumentsValue).toEqual({
                  q: "hello",
                });

                return {
                  result: "world",
                };
              },
            },
          ],
        },
      );

      await expect(client.singleTurnRequest("prompt")).resolves.toBe("final answer");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]?.messages).toEqual([
      {
        role: "user",
        content: "prompt",
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "lookup",
            input: {
              q: "hello",
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: '{\n  "result": "world"\n}',
          },
        ],
      },
    ]);
  });

  test("can execute the loop against a generic scripted conversation client", async () => {
    const baseClient = new ScriptedConversationChatClient([
      {
        content: "",
        toolCalls: [
          {
            name: "sum",
            arguments: {
              left: 1,
              right: 2,
            },
          },
        ],
      },
      {
        content: "done",
        toolCalls: [],
      },
    ]);

    const client = createToolLoopChatClient(baseClient, {
      tools: [
        {
          name: "sum",
          description: "sum two numbers",
          execute(argumentsValue, context) {
            expect(context.iteration).toBe(1);
            expect(argumentsValue).toEqual({
              left: 1,
              right: 2,
            });
            return "3";
          },
        },
      ],
    });

    await expect(client.singleTurnRequest("prompt")).resolves.toBe("done");
    expect(baseClient.conversations[1]).toEqual([
      {
        role: "user",
        content: "prompt",
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tool_call_1_1_sum",
            name: "sum",
            arguments: {
              left: 1,
              right: 2,
            },
          },
        ],
      },
      {
        role: "tool",
        content: "3",
        toolCallId: "tool_call_1_1_sum",
        toolName: "sum",
        isError: undefined,
      },
    ]);
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

class ScriptedConversationChatClient extends ChatClient {
  readonly conversations: LlmConversationMessage[][] = [];

  constructor(private readonly scriptedResponses: ChatResponse[]) {
    super(createStubConfig("scripted-conversation"));
  }

  override async singleTurnRequest(
    prompt: string,
    options?: ChatRequestOptions,
  ): Promise<string> {
    const response = await this.singleTurnResponse(prompt, options);
    return response.content;
  }

  override async singleTurnResponse(
    prompt: string,
    options?: ChatRequestOptions,
  ): Promise<ChatResponse> {
    return this.conversationResponse([{ role: "user", content: prompt }], options);
  }

  override async conversationResponse(
    messages: ReadonlyArray<LlmConversationMessage>,
    _options: ChatRequestOptions = {},
  ): Promise<ChatResponse> {
    this.conversations.push(messages.map((message) => ({ ...message })) as LlmConversationMessage[]);
    const next = this.scriptedResponses.shift();
    if (!next) {
      throw new Error("missing scripted conversation response");
    }
    return next;
  }
}

function createSseResponse(lines: string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(lines.join("\n")));
        controller.close();
      },
    }),
    { status: 200 },
  );
}
