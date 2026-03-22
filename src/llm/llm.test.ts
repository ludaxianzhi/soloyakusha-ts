import { describe, expect, test } from "bun:test";
import { ChatClient } from "./base.ts";
import { LlmClientProvider } from "./provider.ts";
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
