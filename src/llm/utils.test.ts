import { describe, expect, test } from "bun:test";
import { parseJsonResponseText } from "./utils.ts";

describe("parseJsonResponseText", () => {
  test("extracts JSON from markdown code fences and surrounding prose", () => {
    const parsed = parseJsonResponseText<{
      translations: Array<{ id: string; translation: string }>;
    }>(
      [
        "当然可以，下面是结果：",
        "```json",
        '{ "translations": [{ "id": "1", "translation": "ok" }] }',
        "```",
        "如果还要别的我也可以继续补。",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      translations: [{ id: "1", translation: "ok" }],
    });
  });

  test("parses raw JSON without modification", () => {
    expect(parseJsonResponseText<{ ok: boolean }>('{"ok":true}')).toEqual({
      ok: true,
    });
  });
});
