import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextNetworkOrderingStrategy } from "./context-network-ordering.ts";
import { StoryTopology } from "../context/story-topology.ts";
import { TranslationProject } from "../pipeline/translation-project.ts";

const cleanupTargets: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupTargets.splice(0, cleanupTargets.length).map((target) =>
      rm(target, { recursive: true, force: true }),
    ),
  );
});

describe("ContextNetworkOrderingStrategy", () => {
  test("enforces route-linear order while allowing unrelated branches to dispatch concurrently", async () => {
    const project = await createProject();
    const topology = StoryTopology.createEmpty();
    topology.setMainRouteChapters([1, 2]);
    topology.addBranch({ id: "branch-a", name: "A", forkAfterChapterId: 1, chapters: [3] });
    topology.addBranch({ id: "branch-b", name: "B", forkAfterChapterId: 1, chapters: [4] });
    await project.saveStoryTopology(topology);

    await project.saveContextNetwork({
      manifest: {
        schemaVersion: 1,
        sourceRevision: project.getWorkspaceConfig().dependencyTracking?.sourceRevision ?? 0,
        fragmentCount: 5,
        blockSize: 1,
        edgeCount: 5,
        maxOutgoingPerNode: 2,
        createdAt: "2026-04-23T00:00:00.000Z",
      },
      offsets: Uint32Array.from([0, 0, 1, 2, 4, 5]),
      targets: Int32Array.from([0, 0, 2, 0, 0]),
      strengths: Int32Array.from([5, 9, 10, 7, 8]),
    });

    await project.startTranslation();
    const queue = project.getWorkQueue("translation");

    const firstBatch = await queue.dispatchReadyItems();
    expect(firstBatch.map(describeItem)).toEqual(["1:0"]);
    await submitSuccess(project, firstBatch[0]!);

    const secondBatch = await queue.dispatchReadyItems();
    expect(secondBatch.map(describeItem)).toEqual(["2:0", "3:0", "4:0"]);

    const branchAFirst = secondBatch.find((item) => item.chapterId === 3 && item.fragmentIndex === 0);
    const branchAFirstPairs = branchAFirst?.contextView?.getDependencyPairs() ?? [];
    expect(branchAFirstPairs.map(describePair)).toEqual(["1:0"]);

    await submitSuccess(project, branchAFirst!);

    const thirdBatch = await queue.dispatchReadyItems();
    expect(thirdBatch.map(describeItem)).toEqual(["3:1"]);
    const branchASecondPairs = thirdBatch[0]?.contextView?.getDependencyPairs() ?? [];
    expect(branchASecondPairs.map(describePair)).toEqual(["3:0", "1:0"]);
  });

  test("fails hard when context network source revision is stale", async () => {
    const project = await createProject();
    await project.saveContextNetwork({
      manifest: {
        schemaVersion: 1,
        sourceRevision: (project.getWorkspaceConfig().dependencyTracking?.sourceRevision ?? 0) + 1,
        fragmentCount: 5,
        blockSize: 1,
        edgeCount: 0,
        createdAt: "2026-04-23T00:00:00.000Z",
      },
      offsets: Uint32Array.from([0, 0, 0, 0, 0, 0]),
      targets: Int32Array.from([]),
      strengths: Int32Array.from([]),
    });

    await expect(
      (async () => {
        await project.startTranslation();
        await project.getWorkQueue("translation").dispatchReadyItems();
      })(),
    ).rejects.toThrow("上下文网络已过期");
  });
});

async function createProject(): Promise<TranslationProject> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-context-network-ordering-"));
  cleanupTargets.push(workspaceDir);

  const sourceDir = join(workspaceDir, "sources");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "chapter-1.txt"), "main-1\n", "utf8");
  await writeFile(join(sourceDir, "chapter-2.txt"), "main-2\n", "utf8");
  await writeFile(join(sourceDir, "chapter-3.txt"), "branch-a-1\nbranch-a-2\n", "utf8");
  await writeFile(join(sourceDir, "chapter-4.txt"), "branch-b-1\n", "utf8");

  const project = new TranslationProject(
    {
      projectName: "context-network-ordering",
      projectDir: workspaceDir,
      chapters: [
        { id: 1, filePath: "sources/chapter-1.txt" },
        { id: 2, filePath: "sources/chapter-2.txt" },
        { id: 3, filePath: "sources/chapter-3.txt" },
        { id: 4, filePath: "sources/chapter-4.txt" },
      ],
    },
    {
      orderingStrategy: new ContextNetworkOrderingStrategy(2),
      textSplitter: {
        split(units) {
          return units.map((unit) => [unit]);
        },
      },
    },
  );
  await project.initialize();
  return project;
}

async function submitSuccess(
  project: TranslationProject,
  item: { runId: string; stepId: string; chapterId: number; fragmentIndex: number },
): Promise<void> {
  await project.submitWorkResult({
    runId: item.runId,
    stepId: item.stepId,
    chapterId: item.chapterId,
    fragmentIndex: item.fragmentIndex,
    success: true,
    outputText: `${item.chapterId}:${item.fragmentIndex}`,
  });
}

function describeItem(item: { chapterId: number; fragmentIndex: number }): string {
  return `${item.chapterId}:${item.fragmentIndex}`;
}

function describePair(pair: { chapterId: number; fragmentIndex: number }): string {
  return `${pair.chapterId}:${pair.fragmentIndex}`;
}