import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { resolveWebUiPort } from "./server.ts";

describe("WebUI server port resolution", () => {
  test("falls back to a free port when the preferred port is occupied", async () => {
    const probeServer = createServer();
    await new Promise<void>((resolve, reject) => {
      probeServer.once("error", reject);
      probeServer.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
    });

    try {
      const address = probeServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to acquire probe port");
      }

      const occupiedPort = address.port;
      const resolvedPort = await resolveWebUiPort(occupiedPort, "127.0.0.1");

      expect(resolvedPort).not.toBe(occupiedPort);
      expect(resolvedPort).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => probeServer.close(() => resolve()));
    }
  });
});