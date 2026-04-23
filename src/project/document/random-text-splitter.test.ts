import { describe, expect, test } from "bun:test";
import { RandomTextSplitter } from "./random-text-splitter.ts";
import type { TranslationUnit } from "../types.ts";

describe("RandomTextSplitter", () => {
  test("splits units linearly using left-half normal targets", () => {
    const units = ["aaaa", "bbbb", "cccc", "dddd", "eeee"].map<TranslationUnit>((source) => ({
      source,
      target: [],
      metadata: null,
    }));
    const randomValues = [
      0.5,
      0.25,
      0.1353352832366127,
      0,
      0.5,
      0.25,
    ];
    const splitter = new RandomTextSplitter(10, {
      standardDeviation: 2,
      random: () => randomValues.shift() ?? 0.5,
    });

    const fragments = splitter.split(units);

    expect(fragments.map((fragment) => fragment.map((unit) => unit.source))).toEqual([
      ["aaaa", "bbbb"],
      ["cccc"],
      ["dddd", "eeee"],
    ]);
    expect(
      fragments.map((fragment) => fragment.reduce((sum, unit) => sum + unit.source.length, 0)),
    ).toEqual([8, 4, 8]);
  });

  test("keeps overlong units intact when a single unit exceeds the sampled target", () => {
    const units: TranslationUnit[] = [
      { source: "abcdefghijkl", target: [], metadata: null },
      { source: "xy", target: [], metadata: null },
    ];
    const splitter = new RandomTextSplitter(6, {
      standardDeviation: 0,
      random: () => 0.5,
    });

    const fragments = splitter.split(units);

    expect(fragments.map((fragment) => fragment.map((unit) => unit.source))).toEqual([
      ["abcdefghijkl"],
      ["xy"],
    ]);
  });
});
