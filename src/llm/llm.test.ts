import { describe, expect, test } from "bun:test";
import { ChatClient } from "./base.ts";
import { FallbackChatClient } from "./fallback-chat-client.ts";
import { LlmClientProvider } from "./provider.ts";
import type { ChatRequestOptions, LlmClientConfig } from "./types.ts";
import { createLlmClientConfig, resolveRequestConfig } from "./types.ts";

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

function createStubConfig(modelName: string): LlmClientConfig {
  return {
    provider: "openai",
    modelName,
    endpoint: "https://example.com/v1",
    apiKey: "secret",
    modelType: "chat",
    retries: 0,
  };
}
