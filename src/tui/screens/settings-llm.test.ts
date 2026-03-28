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
});
