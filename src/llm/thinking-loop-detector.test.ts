import { describe, expect, test } from "bun:test";
import { ThinkingLoopDetector } from "./thinking-loop-detector.ts";
import { ThinkingLoopError } from "./types.ts";

describe("ThinkingLoopDetector", () => {
  test("throws ThinkingLoopError after repeated low-ratio hits", () => {
    const detector = new ThinkingLoopDetector({
      windowSize: 200,
      checkIntervalChars: 50,
      ratioThreshold: 0.6,
      minChars: 100,
      consecutiveHits: 2,
      tailCheckChars: 20,
      tailRepeatMin: 2,
    });

    detector.addThinkingText("a".repeat(50));
    detector.addThinkingText("a".repeat(50));
    expect(() => detector.addThinkingText("a".repeat(50))).toThrow(ThinkingLoopError);
  });

  test("resets consecutive hit counter when check no longer matches", () => {
    const detector = new ThinkingLoopDetector({
      windowSize: 200,
      checkIntervalChars: 50,
      ratioThreshold: 0.6,
      minChars: 100,
      consecutiveHits: 2,
      tailCheckChars: 20,
      tailRepeatMin: 2,
    });

    detector.addThinkingText("a".repeat(50));
    detector.addThinkingText("a".repeat(50)); // first hit
    detector.addThinkingText("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX"); // reset hit counter
    detector.addThinkingText("a".repeat(50)); // first hit after reset
    expect(() => detector.addThinkingText("a".repeat(50))).toThrow(ThinkingLoopError);
  });

  test("does not check before minimum character threshold", () => {
    const detector = new ThinkingLoopDetector({
      windowSize: 200,
      checkIntervalChars: 50,
      ratioThreshold: 0.6,
      minChars: 300,
      consecutiveHits: 2,
      tailCheckChars: 20,
      tailRepeatMin: 2,
    });

    for (let index = 0; index < 4; index += 1) {
      detector.addThinkingText("a".repeat(50));
    }
  });
});
