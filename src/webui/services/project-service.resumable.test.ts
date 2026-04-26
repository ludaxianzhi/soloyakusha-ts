import { describe, expect, test } from "bun:test";
import { Glossary } from "../../glossary/glossary.ts";
import { ProjectService } from "./project-service.ts";

describe("ProjectService resumable batch tasks", () => {
  test("scanDictionary can abort and resume from the last checkpoint", async () => {
    const service = createService();
    const serviceAny = service as any;

    const replacedTerms: string[] = [];
    const project = {
      getGlossary: () => new Glossary(),
      replaceGlossary: (glossary: Glossary) => {
        replacedTerms.splice(0, replacedTerms.length, ...glossary.getAllTerms().map((term) => term.term));
      },
      saveProgress: async () => undefined,
      getProjectSnapshot: () => createProjectSnapshot(),
      getStoryTopology: () => null,
      hasPlotSummaries: () => false,
      getDocumentManager: () => ({}),
    };

    const firstBatch = deferred<Array<{ term: string; category?: string }>>();
    const scanCalls: number[] = [];
    serviceAny.project = project;
    serviceAny.refreshSnapshot = () => undefined;
    serviceAny.markDictionaryChanged = () => undefined;
    serviceAny.createGlossaryScanner = async () => ({
      scanner: {
        scanBatch: async (batch: { batchIndex: number }) => {
          scanCalls.push(batch.batchIndex);
          if (batch.batchIndex === 0) {
            return firstBatch.promise;
          }
          return [{ term: "王都", category: "placeName" }];
        },
      },
      extractorConfig: {
        requestOptions: undefined,
      },
    });
    serviceAny.createGlossaryScanTask = () => ({
      status: "paused",
      totalLines: 2,
      totalBatches: 2,
      completedBatches: 0,
      nextBatchIndex: 0,
      lines: [
        { lineNumber: 1, text: "勇者来了，王都守卫戒备", blockId: "block-1" },
        { lineNumber: 2, text: "王都召见勇者", blockId: "block-2" },
      ],
      batches: [
        {
          batchIndex: 0,
          startLineNumber: 1,
          endLineNumber: 1,
          charCount: 12,
          text: "勇者来了，王都守卫戒备",
          lines: [],
        },
        { batchIndex: 1, startLineNumber: 2, endLineNumber: 2, charCount: 8, text: "王都召见勇者", lines: [] },
      ],
      glossary: new Glossary(),
      requestOptions: undefined,
      abortRequested: false,
    });

    void service.scanDictionary();
    await waitFor(() => service.getStatus().scanDictionaryProgress?.status === "running");

    await service.abortGlossaryScan();
    firstBatch.resolve([{ term: "勇者", category: "personName" }]);
    await waitFor(() => service.getStatus().scanDictionaryProgress?.status === "paused");

    expect(scanCalls).toEqual([0]);
    expect(service.getStatus().scanDictionaryProgress).toMatchObject({
      status: "paused",
      completedBatches: 1,
      totalBatches: 2,
    });

    await service.resumeGlossaryScan();
    await waitFor(() => service.getStatus().scanDictionaryProgress?.status === "done");

    expect(scanCalls).toEqual([0, 1]);
    expect(replacedTerms).toEqual(["勇者", "王都"]);
    expect(service.getStatus().scanDictionaryProgress).toMatchObject({
      status: "done",
      completedBatches: 2,
      totalBatches: 2,
    });
  });

  test("startPlotSummary can abort and resume from the last checkpoint", async () => {
    const service = createService();
    const serviceAny = service as any;

    const project = {
      getWorkspaceFileManifest: () => ({ projectDir: "C:\\temp\\project" }),
      getDocumentManager: () => ({
        getChapterById: (chapterId: number) => ({
          id: chapterId,
          fragments: [{}, {}].slice(0, 1),
        }),
      }),
      reloadNarrativeArtifacts: async () => undefined,
      getStoryTopology: () => null,
      hasPlotSummaries: () => true,
    };

    const firstBatch = deferred<void>();
    const summarizeCalls: Array<[number, number, number]> = [];
    serviceAny.project = project;
    serviceAny.refreshSnapshot = () => undefined;
    serviceAny.createPlotSummaryRuntime = async () => ({
      summarizer: {
        loadSummaries: async () => undefined,
        summarizeFragments: async (chapterId: number, startFragmentIndex: number, count: number) => {
          summarizeCalls.push([chapterId, startFragmentIndex, count]);
          if (summarizeCalls.length === 1) {
            await firstBatch.promise;
          }
        },
      },
      plotConfig: {
        fragmentsPerBatch: 1,
        maxContextSummaries: 20,
        requestOptions: undefined,
      },
      chapters: [
        { chapterId: 1, fragmentCount: 1 },
        { chapterId: 2, fragmentCount: 1 },
      ],
      totalBatches: 2,
    });

    void service.startPlotSummary();
    await waitFor(() => service.getStatus().plotSummaryProgress?.status === "running");

    await service.abortPlotSummary();
    firstBatch.resolve();
    await waitFor(() => service.getStatus().plotSummaryProgress?.status === "paused");

    expect(summarizeCalls).toEqual([[1, 0, 1]]);
    expect(service.getStatus().plotSummaryProgress).toMatchObject({
      status: "paused",
      completedBatches: 1,
      totalBatches: 2,
    });

    await service.resumePlotSummary();
    await waitFor(() => service.getStatus().plotSummaryProgress?.status === "done");

    expect(summarizeCalls).toEqual([
      [1, 0, 1],
      [2, 0, 1],
    ]);
    expect(service.getStatus().plotSummaryProgress).toMatchObject({
      status: "done",
      completedBatches: 2,
      totalBatches: 2,
    });
  });

  test("proofread can force abort without applying the in-flight fragment", async () => {
    const firstFragment = deferred<{
      outputText: string;
      translations: [];
      glossaryUpdates: [];
      responseText: string;
      responseSchema: { type: string };
      promptName: string;
      systemPrompt: string;
      userPrompt: string;
    }>();
    const service = createService({
      createProofreadRuntime: async () => ({
        processor: {
          process: async () => firstFragment.promise,
        },
        close: async () => undefined,
      }),
    });
    const serviceAny = service as any;

    const updates: Array<[number, number, string]> = [];
    let persistedTask: any;
    const project = {
      getGlossary: () => new Glossary(),
      getChapterDescriptors: () => [
        { id: 1, sourceLineCount: 1, translatedLineCount: 1 },
      ],
      getOrderedFragments: () => [{ chapterId: 1 }],
      getDocumentManager: () => ({
        getChapterFragmentCount: () => 1,
        updateTranslation: async (chapterId: number, fragmentIndex: number, text: string) => {
          updates.push([chapterId, fragmentIndex, text]);
        },
      }),
      buildProofreadFragmentInput: () => ({
        sourceText: "原文",
        currentTranslationText: "旧译文",
        requirements: [],
      }),
      saveProofreadTaskState: async (task: unknown) => {
        persistedTask = task;
      },
      getProofreadTaskState: () => persistedTask,
      getProjectSnapshot: () => createProjectSnapshot(),
      getStoryTopology: () => null,
      hasPlotSummaries: () => false,
    };

    serviceAny.project = project;
    serviceAny.refreshSnapshot = () => undefined;
    serviceAny.markChaptersChanged = () => undefined;
    serviceAny.markRepeatedPatternsChanged = () => undefined;

    await service.startProofread({ chapterIds: [1], mode: "linear" });
    await waitFor(() => service.getStatus().proofreadProgress?.status === "running");

    await service.forceAbortProofread();
    firstFragment.resolve({
      outputText: "新译文",
      translations: [],
      glossaryUpdates: [],
      responseText: "新译文",
      responseSchema: { type: "object" },
      promptName: "proofread",
      systemPrompt: "",
      userPrompt: "",
    });

    await waitFor(() => service.getStatus().proofreadProgress?.status === "paused");
    expect(updates).toEqual([]);
    expect(service.getStatus().proofreadProgress).toMatchObject({
      status: "paused",
      completedBatches: 0,
      totalBatches: 1,
    });
  });

  test("proofread task can be removed from persisted state", async () => {
    const service = createService();
    const serviceAny = service as any;

    let persistedTask: any = {
      taskId: "proofread-1",
      mode: "linear",
      status: "paused",
      chapterIds: [1],
      chapters: [{ chapterId: 1, fragmentCount: 1 }],
      totalChapters: 1,
      completedChapters: 0,
      totalBatches: 1,
      completedBatches: 0,
      nextChapterIndex: 0,
      nextFragmentIndex: 0,
      warningCount: 0,
      abortRequested: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const project = {
      saveProofreadTaskState: async (task: unknown) => {
        persistedTask = task;
      },
      getProofreadTaskState: () => persistedTask,
    };

    serviceAny.project = project;
    serviceAny.proofreadTaskState = persistedTask;
    serviceAny.proofreadProgress = {
      status: "paused",
      mode: "linear",
      totalChapters: 1,
      completedChapters: 0,
      totalBatches: 1,
      completedBatches: 0,
      chapterIds: [1],
      warningCount: 0,
    };

    await service.removeProofreadTask();

    expect(persistedTask).toBeUndefined();
    expect(service.getStatus().proofreadProgress).toBeNull();
  });
});

function createService(
  options: ConstructorParameters<typeof ProjectService>[4] = {},
): ProjectService {
  return new ProjectService(
    { emit: () => undefined, addLog: () => undefined } as any,
    { removeWorkspace: async () => undefined } as any,
    {} as any,
    {} as any,
    options,
  );
}

function createProjectSnapshot() {
  return {
    projectName: "demo",
    lifecycle: {
      status: "idle",
      queuedWorkItems: 0,
      activeWorkItems: 0,
      canStart: true,
      canStop: false,
      canAbort: false,
      canResume: false,
      canSave: true,
    },
    progress: {
      totalChapters: 0,
      translatedChapters: 0,
      totalFragments: 0,
      translatedFragments: 0,
      fragmentProgressRatio: 0,
      chapterProgressRatio: 0,
    },
    pipeline: {
      stepCount: 0,
      finalStepId: "translation",
      steps: [],
    },
    queueSnapshots: [],
    activeWorkItems: [],
    readyWorkItems: [],
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
