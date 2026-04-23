import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearContextNetwork,
  loadContextNetwork,
  saveContextNetwork,
} from "./context-network-storage.ts";

const cleanupTargets: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupTargets.splice(0, cleanupTargets.length).map((target) =>
      rm(target, { recursive: true, force: true }),
    ),
  );
});

describe("context network storage", () => {
  test("round-trips manifest and binary arrays", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-context-network-storage-"));
    cleanupTargets.push(workspaceDir);

    await saveContextNetwork(workspaceDir, {
      manifest: {
        schemaVersion: 1,
        sourceRevision: 2,
        fragmentCount: 3,
        blockSize: 1,
        edgeCount: 3,
        maxOutgoingPerNode: 2,
        createdAt: "2026-04-23T00:00:00.000Z",
      },
      offsets: Uint32Array.from([0, 2, 3, 3]),
      targets: Int32Array.from([1, 2, 0]),
      strengths: Int32Array.from([9, 4, 8]),
    });

    const loaded = await loadContextNetwork(workspaceDir);
    expect(loaded?.manifest.fragmentCount).toBe(3);
    expect(Array.from(loaded?.offsets ?? [])).toEqual([0, 2, 3, 3]);
    expect(Array.from(loaded?.targets ?? [])).toEqual([1, 2, 0]);
    expect(Array.from(loaded?.strengths ?? [])).toEqual([9, 4, 8]);

    await clearContextNetwork(workspaceDir);
    await expect(loadContextNetwork(workspaceDir)).resolves.toBeUndefined();
  });
});