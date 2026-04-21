import { describe, expect, test } from "bun:test";
import { ProjectService } from "./project-service.ts";

describe("ProjectService translation loop", () => {
  test("processes dispatched work items concurrently", async () => {
    const processor = createControlledProcessor(["A", "B"]);
    const project = createFakeTranslationProject([
      { id: "A", fragmentIndex: 0, dependsOn: [] },
      { id: "B", fragmentIndex: 1, dependsOn: [] },
    ]);
    const service = createService(processor, 2);
    const serviceAny = service as any;
    serviceAny.refreshSnapshot = () => undefined;

    serviceAny.startTranslationLoop(project);

    await waitFor(() => processor.maxActiveCount === 2);
    expect(processor.startedIds).toEqual(["A", "B"]);

    processor.resolve("A", "A done");
    processor.resolve("B", "B done");

    await waitFor(() => project.getLifecycleSnapshot().status === "completed");
    expect(project.completedIds).toEqual(["A", "B"]);
    expect(processor.maxActiveCount).toBe(2);
  });

  test("redispatches newly ready work after each completion", async () => {
    const processor = createControlledProcessor(["A", "B", "C"]);
    const project = createFakeTranslationProject([
      { id: "A", fragmentIndex: 0, dependsOn: [] },
      { id: "B", fragmentIndex: 1, dependsOn: [] },
      { id: "C", fragmentIndex: 2, dependsOn: ["A"] },
    ]);
    const service = createService(processor, 2);
    const serviceAny = service as any;
    serviceAny.refreshSnapshot = () => undefined;

    serviceAny.startTranslationLoop(project);

    await waitFor(() => processor.startedIds.length === 2);
    expect(processor.startedIds).toEqual(["A", "B"]);

    processor.resolve("A", "A done");

    await waitFor(() => processor.startedIds.includes("C"));
    expect(processor.startedIds).toEqual(["A", "B", "C"]);
    expect(project.completedIds).toEqual(["A"]);

    processor.resolve("B", "B done");
    processor.resolve("C", "C done");

    await waitFor(() => project.getLifecycleSnapshot().status === "completed");
    expect(project.completedIds).toEqual(["A", "B", "C"]);
  });
});

function createService(
  processor: ReturnType<typeof createControlledProcessor>,
  maxConcurrentWorkItems: number,
): ProjectService {
  return new ProjectService(
    { emit: () => undefined, addLog: () => undefined } as any,
    { removeWorkspace: async () => undefined } as any,
    {} as any,
    { recordTranslationBlock: async () => undefined } as any,
    {
      createTranslationRuntime: async () => ({
        processor: {
          processWorkItem: processor.processWorkItem,
          process: async () => {
            throw new Error("not implemented");
          },
        },
        maxConcurrentWorkItems,
        close: async () => undefined,
      }),
    },
  );
}

function createControlledProcessor(ids: string[]) {
  const deferredById = new Map(
    ids.map((id) => [id, deferred<{ outputText: string }>()] as const),
  );
  const startedIds: string[] = [];
  let activeCount = 0;
  let maxActiveCount = 0;

  return {
    startedIds,
    get maxActiveCount() {
      return maxActiveCount;
    },
    processWorkItem: async (workItem: { inputText: string }) => {
      startedIds.push(workItem.inputText);
      activeCount += 1;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      try {
        const result = await deferredById.get(workItem.inputText)!.promise;
        return {
          outputText: result.outputText,
          translations: [],
          glossaryUpdates: [],
          responseText: result.outputText,
          responseSchema: { type: "object" },
          promptName: "test",
          systemPrompt: "",
          userPrompt: "",
        };
      } finally {
        activeCount -= 1;
      }
    },
    resolve: (id: string, outputText: string) => {
      deferredById.get(id)?.resolve({ outputText });
    },
  };
}

function createFakeTranslationProject(
  items: Array<{ id: string; fragmentIndex: number; dependsOn: string[] }>,
) {
  const state = new Map(
    items.map((item) => [
      item.id,
      {
        ...item,
        status: "queued" as "queued" | "running" | "completed",
      },
    ]),
  );
  const completedIds: string[] = [];
  const lifecycle = {
    status: "running" as "running" | "completed",
    queuedWorkItems: items.length,
    activeWorkItems: 0,
  };

  const syncLifecycle = () => {
    lifecycle.queuedWorkItems = [...state.values()].filter((item) => item.status === "queued").length;
    lifecycle.activeWorkItems = [...state.values()].filter((item) => item.status === "running").length;
    lifecycle.status = [...state.values()].every((item) => item.status === "completed")
      ? "completed"
      : "running";
  };

  return {
    completedIds,
    getLifecycleSnapshot: () => ({
      ...lifecycle,
      canStart: false,
      canStop: lifecycle.status === "running",
      canAbort: lifecycle.status === "running",
      canResume: false,
      canSave: true,
      hasPendingWork: lifecycle.status === "running",
    }),
    dispatchReadyWorkItems: async () => {
      const readyItems = [...state.values()]
        .filter(
          (item) =>
            item.status === "queued" &&
            item.dependsOn.every((dependencyId) => state.get(dependencyId)?.status === "completed"),
        )
        .sort((left, right) => left.fragmentIndex - right.fragmentIndex);

      for (const item of readyItems) {
        item.status = "running";
      }
      syncLifecycle();

      return readyItems.map((item) => ({
        runId: "run-1",
        stepId: "translation",
        chapterId: 1,
        fragmentIndex: item.fragmentIndex,
        queueSequence: item.fragmentIndex + 1,
        status: "running" as const,
        inputText: item.id,
        requirements: [],
        metadata: {},
      }));
    },
    submitWorkResult: async (result: {
      fragmentIndex: number;
      success?: boolean;
      errorMessage?: string;
    }) => {
      const item = items.find((entry) => entry.fragmentIndex === result.fragmentIndex);
      if (!item) {
        throw new Error(`missing item for fragment ${result.fragmentIndex}`);
      }
      const current = state.get(item.id)!;
      current.status = result.success === false ? "queued" : "completed";
      if (result.success !== false) {
        completedIds.push(item.id);
      }
      syncLifecycle();
    },
    saveProgress: async () => undefined,
    saveTranslationRuntimeProgress: async () => undefined,
    getGlossary: () => undefined,
    getDocumentManager: () => ({}),
    getProjectSnapshot: () => ({ projectName: "demo" }),
    getWorkspaceFileManifest: () => ({ projectDir: "C:\\demo" }),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
