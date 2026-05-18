import { describe, it, expect } from "bun:test";
import { 
  TextPostProcessingPipeline, 
  TextPostProcessorRegistry, 
  QuoteConverterProcessor, 
  PeriodInsideQuoteRemoverProcessor, 
  SpeakerBracketAlignerProcessor,
  CharacterReplaceProcessor,
  NewlineAddProcessor,
} from "./text-post-processor.ts";

describe("TextPostProcessor", () => {
  const pipeline = new TextPostProcessingPipeline([
    new QuoteConverterProcessor(),
    new PeriodInsideQuoteRemoverProcessor(),
    new SpeakerBracketAlignerProcessor()
  ]);

  it("should convert quotes correctly", () => {
    const original = "Hello";
    const translated = '他说："你好。" 或者是他说：‘你好。’';
    const result = pipeline.process(translated, original);
    // 注意：这里的 。」 也会被 PeriodInsideQuoteRemoverProcessor 处理
    expect(result).toBe("他说：「你好」 或者是他说：『你好』");
  });

  it("should remove period before brackets", () => {
    const original = "He said something.";
    const translated = "他说：「这就结束了。」";
    const result = pipeline.process(translated, original);
    expect(result).toBe("他说：「这就结束了」");
  });

  it("should align speaker brackets - missing in translation", () => {
    const original = "【佐藤】こんにちは";
    const translated = "佐藤，你好。";
    const result = pipeline.process(translated, original);
    expect(result).toBe("【佐藤】佐藤，你好。");
  });

  it("should align speaker brackets - extra in translation", () => {
    const original = "こんにちは";
    const translated = "【佐藤】你好。";
    const result = pipeline.process(translated, original);
    expect(result).toBe("你好。");
  });

  it("should handle batch processing", () => {
    const inputs = [
      { original: "【A】One", translated: "一" },
      { original: "Two", translated: '他说："二。"' }
    ];
    const results = pipeline.processBatch(inputs);
    expect(results).toEqual([
      "【A】一",
      "他说：「二」"
    ]);
  });
});

describe("CharacterReplaceProcessor", () => {
  it("should replace text using regex", () => {
    const p = new CharacterReplaceProcessor({
      translationRegex: "勇者([AB])",
      replacement: "Hero-$1",
    });
    const result = p.process("勇者A 与 勇者B", { originalText: "" });
    expect(result).toBe("Hero-A 与 Hero-B");
  });

  it("should skip if sourceRegex does not match original", () => {
    const p = new CharacterReplaceProcessor({
      sourceRegex: "登场",
      translationRegex: "勇者",
      replacement: "Hero",
    });
    const result = p.process("勇者登场", { originalText: "离开" });
    expect(result).toBe("勇者登场");
  });

  it("should apply if sourceRegex matches original", () => {
    const p = new CharacterReplaceProcessor({
      sourceRegex: "登场",
      translationRegex: "勇者",
      replacement: "Hero",
    });
    const result = p.process("勇者登场", { originalText: "勇者登场" });
    expect(result).toBe("Hero登场");
  });

  it("should return original text if translationRegex is empty", () => {
    const p = new CharacterReplaceProcessor({ translationRegex: "", replacement: "x" });
    const result = p.process("hello", { originalText: "" });
    expect(result).toBe("hello");
  });
});

describe("NewlineAddProcessor", () => {
  it("should break CJK text when width exceeds lineLength", () => {
    const p = new NewlineAddProcessor({ lineLength: 3, lineBreak: "\n" });
    const result = p.process("你好世界");
    // 你(1)+好(1)+世(1)=3 ≤ 3, 界(1) → 4 > 3
    expect(result).toBe("你好世\n界");
  });

  it("should break half-width text at line length", () => {
    const p = new NewlineAddProcessor({ lineLength: 1, lineBreak: "\n" });
    const result = p.process("abcdef");
    // half-width width=0.5, lineLength=1 → 2 chars per line
    expect(result).toBe("ab\ncd\nef");
  });

  it("should break after right-side punctuation", () => {
    const p = new NewlineAddProcessor({ lineLength: 3, lineBreak: "\n" });
    const result = p.process("你好。世界");
    // 。is right-skip, break goes after it
    expect(result).toBe("你好。\n世界");
  });

  it("should break after right-skip even when skips precede overflow", () => {
    const p = new NewlineAddProcessor({ lineLength: 2, lineBreak: "\n" });
    const result = p.process("AAA。BB");
    expect(result).toBe("AAA。\nBB");
  });

  it("should wrap half-width at space boundary", () => {
    const p = new NewlineAddProcessor({ lineLength: 3, lineBreak: "\n" });
    const result = p.process("aa bb cc");
    // a(0.5)a(0.5)' '(0.5)b(0.5)b(0.5)' '(0.5) = 3.0 ≤ 3
    // c(0.5) → 3.5 > 3. findSpaceWordBreak("aa bb "):
    //   end=4('b'), lastIndexOf(' ',4)=2, rest="bb", all half-width → breakPos=3
    // prefix="aa " (emit), suffix="bb " + "c" = "bb c", then cc
    expect(result).toBe("aa \nbb cc");
  });

  it("should add trailing special char", () => {
    const p = new NewlineAddProcessor({ lineLength: 3, lineBreak: "\n", trailingSpecialChar: "↵" });
    const result = p.process("你好世界");
    expect(result).toBe("你好世↵\n界");
  });

  it("should not break if lineLength <= 0", () => {
    const p = new NewlineAddProcessor({ lineLength: 0, lineBreak: "\n" });
    const result = p.process("你好世界");
    expect(result).toBe("你好世界");
  });
});

describe("TextPostProcessorRegistry", () => {
  it("should return all descriptors including new processors", () => {
    const descriptors = TextPostProcessorRegistry.getAllDescriptors();
    const ids = descriptors.map(d => d.id);
    expect(ids).toContain("character-replace");
    expect(ids).toContain("newline-add");
    expect(ids).toContain("quote-converter");
  });

  it("should include paramsSchema for parameterized processors", () => {
    const descriptors = TextPostProcessorRegistry.getAllDescriptors();
    const cr = descriptors.find(d => d.id === "character-replace");
    expect(cr?.paramsSchema).toBeDefined();
    expect(cr?.paramsSchema?.properties.translationRegex).toBeDefined();
    expect(cr?.paramsSchema?.properties.replacement).toBeDefined();
  });

  it("should create pipeline with params using new signature", () => {
    const pipeline = TextPostProcessorRegistry.createPipeline([
      { id: "character-replace", params: { translationRegex: "foo", replacement: "bar" } },
    ]);
    const result = pipeline.process("foo foo", "original");
    expect(result).toBe("bar bar");
  });
});
