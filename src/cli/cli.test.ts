import { describe, expect, test } from "bun:test";
import { parseArgs, readOptionValues } from "./cli.ts";

describe("dataset CLI argument parsing", () => {
  test("collects repeated model options into fallback chains", () => {
    const parsed = parseArgs([
      "build-dataset",
      "--dictionary-model",
      "dict-primary",
      "--dictionary-model",
      "dict-fallback",
      "--outline-model",
      "outline-primary",
      "--outline-model",
      "outline-fallback",
    ]);

    expect(readOptionValues(parsed, "dictionary-model", "glossary-model")).toEqual([
      "dict-primary",
      "dict-fallback",
    ]);
    expect(readOptionValues(parsed, "outline-model", "summary-model")).toEqual([
      "outline-primary",
      "outline-fallback",
    ]);
  });
});
