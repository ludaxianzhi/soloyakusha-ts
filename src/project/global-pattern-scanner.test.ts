import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GLOBAL_PATTERN_MIN_LENGTH,
  DEFAULT_GLOBAL_PATTERN_MIN_OCCURRENCES,
  GlobalAssociationPatternScanner,
} from "./global-pattern-scanner.ts";

describe("GlobalAssociationPatternScanner", () => {
  test("finds repeated source patterns with default thresholds", () => {
    const repeatedPattern = "王都中央广场入口";
    const text = [
      `${repeatedPattern}今天开放`,
      `${repeatedPattern}正在排队`,
      `${repeatedPattern}夜间关闭`,
    ].join("\n");

    const result = new GlobalAssociationPatternScanner().scanText(text);

    expect(DEFAULT_GLOBAL_PATTERN_MIN_OCCURRENCES).toBe(3);
    expect(DEFAULT_GLOBAL_PATTERN_MIN_LENGTH).toBe(8);
    expect(result.patterns[0]).toMatchObject({
      text: repeatedPattern,
      occurrenceCount: 3,
    });
  });

  test("supports configurable thresholds", () => {
    const text = [
      "学院门口正在排队",
      "学院门口已经关闭",
    ].join("\n");

    const result = new GlobalAssociationPatternScanner().scanText(text, {
      minOccurrences: 2,
      minLength: 4,
    });

    expect(result.patterns[0]).toMatchObject({
      text: "学院门口",
      occurrenceCount: 2,
    });
  });

  test("filters newline-spanning redundant patterns", () => {
    const repeatedPattern = "圣堂回廊东门";
    const text = [
      `${repeatedPattern}已开启`,
      `${repeatedPattern}已关闭`,
      `${repeatedPattern}已整备`,
    ].join("\n");

    const result = new GlobalAssociationPatternScanner().scanText(text, {
      minOccurrences: 3,
      minLength: 4,
    });

    expect(result.patterns.some((pattern) => /[\r\n]/.test(pattern.text))).toBe(false);
    expect(result.patterns.some((pattern) => pattern.text === "圣堂回廊")).toBe(false);
  });
});
