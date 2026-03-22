import { describe, expect, test } from "bun:test";
import type { LlmClientConfig } from "../llm/types.ts";
import { EmbeddingClient } from "../llm/base.ts";
import {
  DefaultTextAligner,
  DynamicTextAligner,
  SimplifiedDynamicTextAligner,
  TEXT_ALIGN_PLACEHOLDER,
} from "./text-align.ts";

class FakeEmbeddingClient extends EmbeddingClient {
  constructor(config: LlmClientConfig) {
    super(config);
  }

  override async getEmbedding(text: string): Promise<number[]> {
    return embeddingTable[text] ?? [0.1, 0.1, 0.1];
  }

  override async getEmbeddings(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.getEmbedding(text)));
  }
}

const embeddingTable: Record<string, number[]> = {
  原文一: [1, 0, 0],
  原文二: [0, 1, 0],
  原文三: [0, 0, 1],
  译文一: [1, 0, 0],
  译文三: [0, 0, 1],
  A: [1, 0, 0],
  B: [0, 1, 0],
  C: [0, 0, 1],
};

const fakeConfig: LlmClientConfig = {
  provider: "openai",
  modelName: "fake-embedding",
  apiKey: "fake",
  endpoint: "https://example.com",
  modelType: "embedding",
  retries: 1,
};

describe("text aligners", () => {
  test("default aligner inserts omission placeholders", async () => {
    const aligner = new DefaultTextAligner(new FakeEmbeddingClient(fakeConfig));
    const aligned = await aligner.alignTexts(
      ["原文一", "原文二", "原文三"],
      ["译文一", "译文三"],
    );

    expect(aligned).toEqual(["译文一", TEXT_ALIGN_PLACEHOLDER, "译文三"]);
  });

  test("dynamic aligner inserts omission placeholders", async () => {
    const aligner = new DynamicTextAligner(new FakeEmbeddingClient(fakeConfig));
    const aligned = await aligner.alignTexts(
      ["原文一", "原文二", "原文三"],
      ["译文一", "译文三"],
    );

    expect(aligned).toEqual(["译文一", TEXT_ALIGN_PLACEHOLDER, "译文三"]);
  });

  test("simplified dynamic aligner inserts omission placeholders", async () => {
    const aligner = new SimplifiedDynamicTextAligner(
      new FakeEmbeddingClient(fakeConfig),
    );
    const aligned = await aligner.alignTexts(
      ["原文一", "原文二", "原文三"],
      ["译文一", "译文三"],
    );

    expect(aligned).toEqual(["译文一", TEXT_ALIGN_PLACEHOLDER, "译文三"]);
  });

  test("default aligner marks identical copied text as omission", async () => {
    const aligner = new DefaultTextAligner(new FakeEmbeddingClient(fakeConfig));
    const aligned = await aligner.alignTexts(["A", "B"], ["A"]);

    expect(aligned[0]).toBe(TEXT_ALIGN_PLACEHOLDER);
  });
});
