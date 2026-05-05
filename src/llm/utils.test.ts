import { describe, expect, test } from "bun:test";
import { ApiConnectionError, collectJsonSse, parseJsonResponseText } from "./utils.ts";

describe("collectJsonSse", () => {
  test("keeps reading when each chunk arrives before the idle timeout", async () => {
    const events: Array<{ value: number }> = [];
    const response = createDelayedSseResponse([
      { delayMs: 0, payload: 'data: {"value":1}\n' },
      { delayMs: 20, payload: 'data: {"value":2}\n' },
      { delayMs: 20, payload: 'data: {"value":3}\n' },
    ]);

    const result = await collectJsonSse<{ value: number }>(
      response,
      async (event) => {
        events.push(event);
      },
      {
        idleTimeoutMs: 25,
      },
    );

    expect(events).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
    expect(result.events).toEqual(events);
  });

  test("throws when no new chunk arrives before the idle timeout", async () => {
    const response = createDelayedSseResponse([
      { delayMs: 0, payload: 'data: {"value":1}\n' },
      { delayMs: 25, payload: 'data: {"value":2}\n' },
    ]);

    await expect(
      collectJsonSse<{ value: number }>(
        response,
        async () => {},
        {
          idleTimeoutMs: 10,
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        name: ApiConnectionError.name,
        message: "流式响应在 1 秒内未收到新数据",
      }),
    );
  });
});

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

function createDelayedSseResponse(
  chunks: Array<{ delayMs: number; payload: string }>,
): Response {
  const encoder = new TextEncoder();
  let index = 0;
  let cancelled = false;

  return new Response(
    new ReadableStream({
      async pull(controller) {
        if (cancelled) {
          controller.close();
          return;
        }

        const chunk = chunks[index];
        if (!chunk) {
          controller.close();
          return;
        }

        index += 1;
        if (chunk.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, chunk.delayMs));
        }

        if (cancelled) {
          controller.close();
          return;
        }

        controller.enqueue(encoder.encode(chunk.payload));
        if (index >= chunks.length) {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    }),
    { status: 200 },
  );
}
