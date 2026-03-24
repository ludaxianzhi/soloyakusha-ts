import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GlobalConfigManager,
  getDefaultGlobalConfigFilePath,
} from "./manager.ts";

const cleanupTargets: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupTargets.splice(0, cleanupTargets.length).map((target) =>
      rm(target, { recursive: true, force: true }),
    ),
  );
});

describe("getDefaultGlobalConfigFilePath", () => {
  test("uses the user home directory", () => {
    const filePath = getDefaultGlobalConfigFilePath().replace(/\\/g, "/");
    expect(filePath).toEndWith(".soloyakusha-ts/config.json");
  });
});

describe("GlobalConfigManager", () => {
  test("persists llm profiles and reloads them", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "soloyakusha-global-config-"));
    cleanupTargets.push(rootDir);

    const filePath = join(rootDir, "config", "settings.json");
    const manager = new GlobalConfigManager({ filePath });

    await manager.setLlmProfile("writer", {
      provider: "openai",
      modelType: "chat",
      modelName: "gpt-4.1",
      endpoint: "https://example.com/v1",
      apiKey: "secret",
      retries: 5,
      defaultRequestConfig: {
        temperature: 0.2,
        extraBody: {
          response_format: "json_schema",
        },
      },
    });
    await manager.setDefaultLlmProfileName("writer");

    const reloaded = new GlobalConfigManager({ filePath });
    const profile = await reloaded.getRequiredLlmProfile("writer");

    expect(await reloaded.getDefaultLlmProfileName()).toBe("writer");
    expect(await reloaded.listLlmProfileNames()).toEqual(["writer"]);
    expect(profile).toEqual({
      provider: "openai",
      modelType: "chat",
      modelName: "gpt-4.1",
      endpoint: "https://example.com/v1",
      apiKey: "secret",
      retries: 5,
      qps: undefined,
      maxParallelRequests: undefined,
      apiKeyEnv: undefined,
      defaultRequestConfig: {
        systemPrompt: undefined,
        temperature: 0.2,
        maxTokens: undefined,
        topP: undefined,
        extraBody: {
          response_format: "json_schema",
        },
      },
    });

    const saved = JSON.parse(await readFile(filePath, "utf8")) as {
      version: number;
      llm: { defaultProfileName?: string };
    };
    expect(saved.version).toBe(1);
    expect(saved.llm.defaultProfileName).toBe("writer");
  });

  test("updates and removes llm profiles through api", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "soloyakusha-global-config-"));
    cleanupTargets.push(rootDir);

    const filePath = join(rootDir, "settings.json");
    const manager = new GlobalConfigManager({ filePath });

    await manager.setLlmProfile("writer", {
      provider: "openai",
      modelType: "chat",
      modelName: "gpt-4.1-mini",
      endpoint: "https://example.com/v1",
      apiKey: "secret",
      retries: 3,
    });
    await manager.setDefaultLlmProfileName("writer");

    const updated = await manager.updateLlmProfile("writer", (current) => ({
      ...current,
      modelName: "gpt-4.1",
      defaultRequestConfig: {
        systemPrompt: "system",
        maxTokens: 1024,
      },
    }));

    expect(updated.modelName).toBe("gpt-4.1");
    expect(updated.defaultRequestConfig).toEqual({
      systemPrompt: "system",
      temperature: undefined,
      maxTokens: 1024,
      topP: undefined,
      extraBody: undefined,
    });

    expect(await manager.removeLlmProfile("writer")).toBe(true);
    expect(await manager.getDefaultLlmProfileName()).toBeUndefined();
    expect(await manager.listLlmProfileNames()).toEqual([]);
    expect(await manager.removeLlmProfile("writer")).toBe(false);
  });

  test("resolves env-based llm profile to runtime config", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "soloyakusha-global-config-"));
    cleanupTargets.push(rootDir);

    process.env.SOLOYAKUSHA_GLOBAL_TEST_KEY = "env-secret";

    const manager = new GlobalConfigManager({
      filePath: join(rootDir, "settings.json"),
    });

    await manager.setLlmProfile("embedding", {
      provider: "openai",
      modelType: "embedding",
      modelName: "text-embedding-3-small",
      endpoint: "https://example.com/v1",
      apiKeyEnv: "SOLOYAKUSHA_GLOBAL_TEST_KEY",
      retries: 3,
    });

    const resolved = await manager.getResolvedLlmProfile("embedding");
    expect(resolved.apiKey).toBe("env-secret");
    expect(resolved.modelType).toBe("embedding");

    delete process.env.SOLOYAKUSHA_GLOBAL_TEST_KEY;
  });
});