import { describe, it, expect } from "bun:test";
import { 
  TextPostProcessingPipeline, 
  QuoteConverterProcessor, 
  PeriodInsideQuoteRemoverProcessor, 
  SpeakerBracketAlignerProcessor 
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
