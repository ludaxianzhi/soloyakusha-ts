import { describe, expect, test } from "bun:test";
import { buildLlmConfigFromValues } from "./settings-llm.tsx";

describe("buildLlmConfigFromValues", () => {
  test("parses default request config extraBody from YAML", () => {
    const result = buildLlmConfigFromValues(
      {
        provider: "openai",
        endpoint: "https://example.com/v1",
        apiKey: "secret",
        apiKeyEnv: "",
        modelName: "gpt-4.1",
        retries: "3",
        qps: "",
        maxParallelRequests: "",
        defaultSystemPrompt: "",
        defaultTemperature: "0.2",
        defaultTopP: "",
        defaultMaxTokens: "",
        defaultExtraBody: "chat_template_kwargs:\n  enable_thinking: false\n",
      },
      "chat",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.config.defaultRequestConfig).toEqual({
      temperature: 0.2,
      extraBody: {
        chat_template_kwargs: {
          enable_thinking: false,
        },
      },
    });
  });

  test("rejects yaml values whose top level is not an object", () => {
    const result = buildLlmConfigFromValues(
      {
        provider: "openai",
        endpoint: "https://example.com/v1",
        apiKey: "secret",
        apiKeyEnv: "",
        modelName: "gpt-4.1",
        retries: "3",
        qps: "",
        maxParallelRequests: "",
        defaultSystemPrompt: "",
        defaultTemperature: "",
        defaultTopP: "",
        defaultMaxTokens: "",
        defaultExtraBody: "- enable_thinking\n- false",
      },
      "chat",
    );

    expect(result).toEqual({
      ok: false,
      message: "默认 Extra Body 必须是 YAML 对象",
    });
  });

  test("accepts leading tab indentation in yaml extraBody", () => {
    const result = buildLlmConfigFromValues(
      {
        provider: "openai",
        endpoint: "https://example.com/v1",
        apiKey: "secret",
        apiKeyEnv: "",
        modelName: "gpt-4.1",
        retries: "3",
        qps: "",
        maxParallelRequests: "",
        defaultSystemPrompt: "",
        defaultTemperature: "",
        defaultTopP: "",
        defaultMaxTokens: "",
        defaultExtraBody: "chat_template_kwargs:\n\tenable_thinking: false\n",
      },
      "chat",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.config.defaultRequestConfig).toEqual({
      extraBody: {
        chat_template_kwargs: {
          enable_thinking: false,
        },
      },
    });
  });

  test("rejects non-positive retries and malformed optional rate limits", () => {
    const result = buildLlmConfigFromValues(
      {
        provider: "openai",
        endpoint: "https://example.com/v1",
        apiKey: "secret",
        apiKeyEnv: "",
        modelName: "gpt-4.1",
        retries: "0",
        qps: "12abc",
        maxParallelRequests: "",
        defaultSystemPrompt: "",
        defaultTemperature: "",
        defaultTopP: "",
        defaultMaxTokens: "",
        defaultExtraBody: "",
      },
      "chat",
    );

    expect(result).toEqual({
      ok: false,
      message: "重试次数 必须是正整数",
    });
  });

  test("accepts arbitrary positive integers for retries and rate limits", () => {
    const result = buildLlmConfigFromValues(
      {
        provider: "openai",
        endpoint: "https://example.com/v1",
        apiKey: "secret",
        apiKeyEnv: "",
        modelName: "gpt-4.1",
        retries: "7",
        qps: "15",
        maxParallelRequests: "12",
        defaultSystemPrompt: "",
        defaultTemperature: "",
        defaultTopP: "",
        defaultMaxTokens: "",
        defaultExtraBody: "",
      },
      "chat",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.config.retries).toBe(7);
    expect(result.config.qps).toBe(15);
    expect(result.config.maxParallelRequests).toBe(12);
  });
});
