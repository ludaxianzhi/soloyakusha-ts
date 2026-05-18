import { describe, it, expect } from "bun:test";
import {
  TextPreProcessingPipeline,
  TextPreProcessorRegistry,
  TextReplacePreProcessor,
} from "./text-pre-processor.ts";

describe("TextReplacePreProcessor", () => {
  it("should replace matched text", () => {
    const p = new TextReplacePreProcessor({
      matchRegex: "foo",
      replacement: "bar",
    });
    expect(p.process("foo foo")).toBe("bar bar");
  });

  it("should support capture group references", () => {
    const p = new TextReplacePreProcessor({
      matchRegex: "(\\w+)-(\\d+)",
      replacement: "$2:$1",
    });
    expect(p.process("hero-01 villain-02")).toBe("01:hero 02:villain");
  });

  it("should treat empty replacement as remove", () => {
    const p = new TextReplacePreProcessor({
      matchRegex: "bad\\s*",
      replacement: "",
    });
    expect(p.process("good bad better")).toBe("good better");
  });

  it("should only process lines matching filterRegex", () => {
    const p = new TextReplacePreProcessor({
      filterRegex: "^【.*】",
      matchRegex: "foo",
      replacement: "bar",
    });
    expect(p.process("【A】foo line\nother foo line")).toBe(
      "【A】bar line\nother foo line",
    );
  });

  it("should process all lines when filterRegex is empty", () => {
    const p = new TextReplacePreProcessor({
      filterRegex: "",
      matchRegex: "foo",
      replacement: "bar",
    });
    expect(p.process("foo\nfoo")).toBe("bar\nbar");
  });

  it("should not modify text when matchRegex is empty", () => {
    const p = new TextReplacePreProcessor({
      matchRegex: "",
    });
    expect(p.process("hello world")).toBe("hello world");
  });

  it("should tolerate invalid regex gracefully", () => {
    const p = new TextReplacePreProcessor({
      matchRegex: "[invalid",
    });
    expect(p.process("hello")).toBe("hello");
  });
});

describe("TextPreProcessingPipeline", () => {
  it("should chain multiple processors in order", () => {
    const pipeline = new TextPreProcessingPipeline([
      new TextReplacePreProcessor({ matchRegex: "a", replacement: "b" }),
      new TextReplacePreProcessor({ matchRegex: "b", replacement: "c" }),
    ]);
    expect(pipeline.process("a")).toBe("c");
  });

  it("should return original text when no processors", () => {
    const pipeline = new TextPreProcessingPipeline();
    expect(pipeline.process("hello")).toBe("hello");
  });

  it("should support addProcessor chain", () => {
    const pipeline = new TextPreProcessingPipeline()
      .addProcessor(new TextReplacePreProcessor({ matchRegex: "a", replacement: "b" }));
    expect(pipeline.process("a")).toBe("b");
  });
});

describe("TextPreProcessorRegistry", () => {
  it("should return text-replace descriptor", () => {
    const descriptors = TextPreProcessorRegistry.getAllDescriptors();
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]!.id).toBe("text-replace");
    expect(descriptors[0]!.name).toBe("文本替换");
    expect(descriptors[0]!.paramsSchema).toBeDefined();
  });

  it("should include paramsSchema with all three fields", () => {
    const descriptors = TextPreProcessorRegistry.getAllDescriptors();
    const schema = descriptors[0]!.paramsSchema!;
    expect(schema.properties.filterRegex?.type).toBe("string");
    expect(schema.properties.matchRegex?.type).toBe("string");
    expect(schema.properties.replacement?.type).toBe("string");
    expect(schema.required).toContain("matchRegex");
  });

  it("should get processor by id", () => {
    const processor = TextPreProcessorRegistry.getProcessor("text-replace");
    expect(processor).toBeDefined();
    expect(processor!.id).toBe("text-replace");
  });

  it("should return undefined for unknown id", () => {
    const processor = TextPreProcessorRegistry.getProcessor("unknown");
    expect(processor).toBeUndefined();
  });

  it("should create pipeline from steps", () => {
    const pipeline = TextPreProcessorRegistry.createPipeline([
      { id: "text-replace", params: { matchRegex: "foo", replacement: "bar" } },
    ]);
    expect(pipeline.process("foo")).toBe("bar");
  });

  it("should skip unknown step ids in pipeline", () => {
    const pipeline = TextPreProcessorRegistry.createPipeline([
      { id: "unknown" },
      { id: "text-replace", params: { matchRegex: "foo", replacement: "bar" } },
    ]);
    expect(pipeline.process("foo")).toBe("bar");
  });
});
