import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glossary } from "../glossary/glossary.ts";
import { GlossaryPersisterFactory } from "../glossary/persister.ts";
import type { TranslationPipelineDefinition } from "./pipeline.ts";
import { TranslationProject } from "./translation-project.ts";

const cleanupTargets: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupTargets.splice(0, cleanupTargets.length).map((target) =>
      rm(target, { recursive: true, force: true }),
    ),
  );
});

describe("TranslationProject", () => {
  test("dispatches sequential translation queue items with N-1 and N-2 contexts", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-project-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "第一句\n第二句\n第三句\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "demo",
        projectDir: workspaceDir,
        chapters: [{ id: 1, filePath: "sources\\chapter-1.txt" }],
        customRequirements: ["保持称谓一致"],
      },
      {
        textSplitter: {
          split(units) {
            return units.map((unit) => [unit]);
          },
        },
      },
    );
    await project.initialize();
    await project.startTranslation();

    const translationQueue = project.getWorkQueue("translation");
    const firstBatch = await translationQueue.dispatchReadyItems();
    expect(firstBatch).toHaveLength(1);
    expect(firstBatch[0]?.metadata.dependencyMode).toBe("previousTranslations");
    expect(firstBatch[0]?.contextView?.getContexts()).toEqual([]);

    await project.submitWorkResult({
      runId: firstBatch[0]!.runId,
      stepId: "translation",
      chapterId: 1,
      fragmentIndex: 0,
      outputText: "Line 1",
    });

    const secondBatch = await translationQueue.dispatchReadyItems();
    expect(secondBatch).toHaveLength(1);
    const secondContext = secondBatch[0]?.contextView?.getContext("dependencyTranslation");
    expect(secondContext?.type).toBe("dependencyTranslation");
    if (secondContext?.type === "dependencyTranslation") {
      expect(secondContext.pairs).toHaveLength(1);
      expect(secondContext.pairs[0]?.translatedText).toBe("Line 1");
    }

    await project.submitWorkResult({
      runId: secondBatch[0]!.runId,
      stepId: "translation",
      chapterId: 1,
      fragmentIndex: 1,
      outputText: "Line 2",
    });

    const thirdBatch = await translationQueue.dispatchReadyItems();
    const thirdContext = thirdBatch[0]?.contextView?.getContext("dependencyTranslation");
    expect(thirdContext?.type).toBe("dependencyTranslation");
    if (thirdContext?.type === "dependencyTranslation") {
      expect(thirdContext.pairs).toHaveLength(2);
      expect(thirdContext.pairs[0]?.translatedText).toBe("Line 2");
      expect(thirdContext.pairs[1]?.translatedText).toBe("Line 1");
    }
  });

  test("dispatches glossary-satisfied translation items concurrently", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-glossary-deps-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "chapter-1.txt"),
      [
        "王都公告正式发布",
        "王都教会钟声回荡",
        "没有词汇表支持的等待片段",
        "王都广场开始集合",
      ].join("\n"),
      "utf8",
    );

    const glossary = new Glossary([
      {
        term: "王都",
        translation: "",
      },
    ]);

    const project = new TranslationProject(
      {
        projectName: "glossary-deps",
        projectDir: workspaceDir,
        chapters: [{ id: 1, filePath: "sources\\chapter-1.txt" }],
      },
      {
        glossary,
        textSplitter: {
          split(units) {
            return units.map((unit) => [unit]);
          },
        },
      },
    );
    await project.initialize();
    await project.startTranslation();

    const translationQueue = project.getWorkQueue("translation");
    const firstBatch = await translationQueue.dispatchReadyItems();
    expect(firstBatch.map((item) => item.fragmentIndex)).toEqual([0]);

    await project.submitWorkResult({
      runId: firstBatch[0]!.runId,
      stepId: "translation",
      chapterId: 1,
      fragmentIndex: 0,
      outputText: "Royal capital bulletin",
    });

    const secondBatch = await translationQueue.dispatchReadyItems();
    expect(secondBatch.map((item) => item.fragmentIndex)).toEqual([1]);

    await project.submitWorkResult({
      runId: secondBatch[0]!.runId,
      stepId: "translation",
      chapterId: 1,
      fragmentIndex: 1,
      outputText: "Church bells of the royal capital",
    });

    const thirdBatch = await translationQueue.dispatchReadyItems();
    expect(thirdBatch.map((item) => [item.fragmentIndex, item.metadata.dependencyMode])).toEqual([
      [2, "previousTranslations"],
      [3, "glossaryTerms"],
    ]);

    const glossaryItem = thirdBatch.find((item) => item.fragmentIndex === 3);
    const glossaryContext = glossaryItem?.contextView?.getContext("dependencyTranslation");
    expect(glossaryContext?.type).toBe("dependencyTranslation");
    if (glossaryContext?.type === "dependencyTranslation") {
      expect(glossaryContext.pairs).toHaveLength(1);
      expect(glossaryContext.pairs[0]?.sourceText).toBe("王都教会钟声回荡");
    }
  });

  test("loads plot summaries into context view and filters branch predecessors by topology", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-plot-context-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    const dataDir = join(workspaceDir, "Data");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "主线第一章\n", "utf8");
    await writeFile(join(sourceDir, "chapter-2.txt"), "主线第二章\n", "utf8");
    await writeFile(join(sourceDir, "chapter-3.txt"), "支线章节\n", "utf8");
    await writeFile(
      join(dataDir, "story-topology.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          routes: [
            {
              id: "main",
              name: "主线",
              parentRouteId: null,
              forkAfterChapterId: null,
              chapters: [1, 2],
            },
            {
              id: "branch-a",
              name: "支线A",
              parentRouteId: "main",
              forkAfterChapterId: 1,
              chapters: [3],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      join(dataDir, "plot-summaries.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          entries: [
            {
              chapterId: 1,
              startFragmentIndex: 0,
              endFragmentIndex: 1,
              summary: {
                mainEvents: "主线第一章总结",
                keyCharacters: "主角",
                setting: "城门前",
                notes: "",
              },
              createdAt: "2025-01-01T00:00:00.000Z",
            },
            {
              chapterId: 2,
              startFragmentIndex: 0,
              endFragmentIndex: 1,
              summary: {
                mainEvents: "主线第二章总结",
                keyCharacters: "配角",
                setting: "城内",
                notes: "",
              },
              createdAt: "2025-01-01T00:01:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const project = new TranslationProject(
      {
        projectName: "plot-context",
        projectDir: workspaceDir,
        chapters: [
          { id: 1, filePath: "sources\\chapter-1.txt" },
          { id: 2, filePath: "sources\\chapter-2.txt" },
          { id: 3, filePath: "sources\\chapter-3.txt" },
        ],
      },
      {
        textSplitter: {
          split(units) {
            return units.map((unit) => [unit]);
          },
        },
      },
    );
    await project.initialize();
    await project.startTranslation();

    expect(project.hasPlotSummaries()).toBe(true);
    expect(project.getStoryTopology()?.getAllRoutes()).toHaveLength(2);

    const queue = project.getWorkQueue("translation");
    const firstBatch = await queue.dispatchReadyItems();
    await project.submitWorkResult({
      runId: firstBatch[0]!.runId,
      stepId: "translation",
      chapterId: 1,
      fragmentIndex: 0,
      outputText: "Main 1",
    });

    const secondBatch = await queue.dispatchReadyItems();
    await project.submitWorkResult({
      runId: secondBatch[0]!.runId,
      stepId: "translation",
      chapterId: 2,
      fragmentIndex: 0,
      outputText: "Main 2",
    });

    const thirdBatch = await queue.dispatchReadyItems();
    expect(thirdBatch).toHaveLength(1);
    expect(thirdBatch[0]?.chapterId).toBe(3);

    const plotSummaryContext = thirdBatch[0]?.contextView?.getContext("plotSummary");
    expect(plotSummaryContext?.type).toBe("plotSummary");
    if (plotSummaryContext?.type === "plotSummary") {
      expect(plotSummaryContext.summaries).toHaveLength(1);
      expect(plotSummaryContext.summaries[0]).toContain("主线第一章总结");
      expect(plotSummaryContext.summaries[0]).not.toContain("主线第二章总结");
    }

    const predecessorSummaries = project.getPlotSummariesForPosition(3, 0);
    expect(predecessorSummaries.map((entry) => entry.chapterId)).toEqual([1]);
  });

  test("allows different fragments to run at different pipeline steps asynchronously", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-pipeline-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "第一句\n第二句\n", "utf8");

    const pipeline: TranslationPipelineDefinition = {
      steps: [
        {
          id: "draft",
          description: "草稿",
          buildInput: ({ chapterId, fragmentIndex, runtime }) =>
            runtime.getSourceText(chapterId, fragmentIndex),
        },
        {
          id: "polish",
          description: "润色",
          buildInput: ({ previousStepOutput }) => previousStepOutput?.lines.join("\n") ?? "",
        },
      ],
      finalStepId: "polish",
    };

    const project = new TranslationProject(
      {
        projectName: "pipeline",
        projectDir: workspaceDir,
        chapters: [{ id: 1, filePath: "sources\\chapter-1.txt" }],
      },
      {
        pipeline,
        textSplitter: {
          split(units) {
            return units.map((unit) => [unit]);
          },
        },
      },
    );
    await project.initialize();
    await project.startTranslation();

    const draftQueue = project.getWorkQueue("draft");
    const draftBatch = await draftQueue.dispatchReadyItems();
    expect(draftBatch.map((item) => item.fragmentIndex)).toEqual([0, 1]);

    await project.submitWorkResult({
      runId: draftBatch[0]!.runId,
      stepId: "draft",
      chapterId: 1,
      fragmentIndex: 0,
      outputText: "Draft 1",
    });

    const polishQueue = project.getWorkQueue("polish");
    const polishBatch = await polishQueue.dispatchReadyItems();
    expect(polishBatch.map((item) => item.fragmentIndex)).toEqual([0]);
    expect(project.getDocumentManager().getPipelineStepState(1, 1, "draft")?.status).toBe("running");
  });

  test("requeues failed work items inside the same step queue", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-work-queue-status-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "第一句\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "status",
        projectDir: workspaceDir,
        chapters: [{ id: 1, filePath: "sources\\chapter-1.txt" }],
      },
      {
        textSplitter: {
          split(units) {
            return units.map((unit) => [unit]);
          },
        },
      },
    );
    await project.initialize();
    await project.startTranslation();

    const translationQueue = project.getWorkQueue("translation");
    const firstBatch = await translationQueue.dispatchReadyItems();
    expect(firstBatch).toHaveLength(1);
    expect(project.getDocumentManager().getPipelineStepState(1, 0, "translation")?.status).toBe(
      "running",
    );

    await project.submitWorkResult({
      runId: firstBatch[0]!.runId,
      stepId: "translation",
      chapterId: 1,
      fragmentIndex: 0,
      success: false,
      errorMessage: "mock failure",
    });

    expect(project.getDocumentManager().getPipelineStepState(1, 0, "translation")?.status).toBe(
      "queued",
    );
    const secondBatch = await translationQueue.dispatchReadyItems();
    expect(secondBatch).toHaveLength(1);
  });

  test("provides structured project and queue snapshots for UI display", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-project-info-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "第一句\n第二句\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "info",
        projectDir: workspaceDir,
        chapters: [{ id: 1, filePath: "sources\\chapter-1.txt" }],
      },
      {
        textSplitter: {
          split(units) {
            return units.map((unit) => [unit]);
          },
        },
      },
    );
    await project.initialize();

    const initialSnapshot = project.getProjectSnapshot();
    expect(initialSnapshot.projectName).toBe("info");
    expect(initialSnapshot.lifecycle.status).toBe("idle");
    expect(initialSnapshot.lifecycle.canStart).toBe(true);
    expect(initialSnapshot.pipeline.stepCount).toBe(1);
    expect(initialSnapshot.queueSnapshots[0]?.progress.readyFragments).toBe(1);
    expect(initialSnapshot.queueSnapshots[0]?.progress.waitingFragments).toBe(1);
    expect(initialSnapshot.queueSnapshots[0]?.entries[0]?.readyToDispatch).toBe(true);
    expect(initialSnapshot.queueSnapshots[0]?.entries[1]?.blockedReason).toBe(
      "waiting_for_previous_fragments",
    );

    await project.startTranslation();
    const runningBatch = await project.getWorkQueue("translation").dispatchReadyItems();

    const runningItems = project.getActiveWorkItems();
    expect(runningItems).toHaveLength(1);
    expect(runningItems[0]?.status).toBe("running");

    await project.submitWorkResult({
      runId: runningBatch[0]!.runId,
      stepId: "translation",
      chapterId: 1,
      fragmentIndex: 0,
      outputText: "Line 1",
    });

    const readyItems = project.getReadyWorkItemSnapshots();
    expect(readyItems).toHaveLength(1);
    expect(readyItems[0]?.fragmentIndex).toBe(1);
  });

  test("imports fully translated fragments as completed work and clears partial fragments", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-imported-translation-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "占位\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "imported-translation",
        projectDir: workspaceDir,
        chapters: [{ id: 1, filePath: "sources\\chapter-1.txt" }],
      },
      {
        parseUnits: () => [
          { source: "第一行", target: ["Line 1"] },
          { source: "第二行", target: ["Line 2"] },
          { source: "第三行", target: ["Line 3"] },
          { source: "第四行", target: [] },
        ],
        textSplitter: {
          split(units) {
            return [units.slice(0, 2), units.slice(2, 4)];
          },
        },
      },
    );
    await project.initialize();
    await project.reconcileImportedTranslations([1], { importTranslation: true });

    expect(project.getFragment(1, 0)?.translation.lines).toEqual(["Line 1", "Line 2"]);
    expect(project.getFragment(1, 1)?.translation.lines).toEqual(["", ""]);

    const snapshot = project.getProjectSnapshot();
    expect(snapshot.progress.translatedFragments).toBe(1);
    expect(snapshot.progress.translatedChapters).toBe(0);
    expect(snapshot.lifecycle.queuedWorkItems).toBe(1);
    expect(snapshot.lifecycle.activeWorkItems).toBe(0);
    expect(snapshot.queueSnapshots[0]?.progress.completedFragments).toBe(1);
    expect(snapshot.queueSnapshots[0]?.progress.readyFragments).toBe(1);
    expect(project.getReadyWorkItemSnapshots().map((item) => item.fragmentIndex)).toEqual([1]);
  });

  test("clears imported translations when source-only import is requested", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-imported-source-only-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "占位\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "imported-source-only",
        projectDir: workspaceDir,
        chapters: [{ id: 1, filePath: "sources\\chapter-1.txt" }],
      },
      {
        parseUnits: () => [
          { source: "第一行", target: ["Line 1"] },
          { source: "第二行", target: ["Line 2"] },
          { source: "第三行", target: ["Line 3"] },
          { source: "第四行", target: [] },
        ],
        textSplitter: {
          split(units) {
            return [units.slice(0, 2), units.slice(2, 4)];
          },
        },
      },
    );
    await project.initialize();
    await project.reconcileImportedTranslations([1], { importTranslation: false });

    expect(project.getFragment(1, 0)?.translation.lines).toEqual(["", ""]);
    expect(project.getFragment(1, 1)?.translation.lines).toEqual(["", ""]);

    const snapshot = project.getProjectSnapshot();
    expect(snapshot.progress.translatedFragments).toBe(0);
    expect(snapshot.lifecycle.queuedWorkItems).toBe(2);
    expect(snapshot.lifecycle.activeWorkItems).toBe(0);
    expect(snapshot.queueSnapshots[0]?.progress.completedFragments).toBe(0);
    expect(snapshot.queueSnapshots[0]?.progress.readyFragments).toBe(1);
    expect(snapshot.queueSnapshots[0]?.progress.waitingFragments).toBe(1);
  });

  test("resumes from persisted intermediate pipeline steps after interruption", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-project-resume-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "第一句\n第二句\n", "utf8");

    const pipeline: TranslationPipelineDefinition = {
      steps: [
        {
          id: "draft",
          description: "草稿",
          buildInput: ({ chapterId, fragmentIndex, runtime }) =>
            runtime.getSourceText(chapterId, fragmentIndex),
        },
        {
          id: "polish",
          description: "润色",
          buildInput: ({ previousStepOutput }) => previousStepOutput?.lines.join("\n") ?? "",
        },
      ],
      finalStepId: "polish",
    };

    const firstProject = new TranslationProject(
      {
        projectName: "resume",
        projectDir: workspaceDir,
        chapters: [{ id: 1, filePath: "sources\\chapter-1.txt" }],
      },
      {
        pipeline,
        textSplitter: {
          split(units) {
            return units.map((unit) => [unit]);
          },
        },
      },
    );
    await firstProject.initialize();
    await firstProject.startTranslation();

    const draftBatch = await firstProject.getWorkQueue("draft").dispatchReadyItems();
    expect(draftBatch.map((item) => item.fragmentIndex)).toEqual([0, 1]);

    await firstProject.submitWorkResult({
      runId: draftBatch[0]!.runId,
      stepId: "draft",
      chapterId: 1,
      fragmentIndex: 0,
      outputText: "Draft 1",
    });

    const resumedProject = new TranslationProject(
      {
        projectName: "resume",
        projectDir: workspaceDir,
        chapters: [{ id: 1, filePath: "sources\\chapter-1.txt" }],
      },
      {
        pipeline,
        textSplitter: {
          split(units) {
            return units.map((unit) => [unit]);
          },
        },
      },
    );
    await resumedProject.initialize();

    const lifecycleAfterReload = resumedProject.getLifecycleSnapshot();
    expect(lifecycleAfterReload.status).toBe("interrupted");
    expect(resumedProject.getDocumentManager().getPipelineStepState(1, 1, "draft")?.status).toBe(
      "queued",
    );
    expect(resumedProject.getDocumentManager().getPipelineStepState(1, 0, "polish")?.status).toBe(
      "queued",
    );

    await resumedProject.startTranslation();
    const resumedDraftBatch = await resumedProject.getWorkQueue("draft").dispatchReadyItems();
    const resumedPolishBatch = await resumedProject.getWorkQueue("polish").dispatchReadyItems();
    expect(resumedDraftBatch.map((item) => item.fragmentIndex)).toEqual([1]);
    expect(resumedPolishBatch.map((item) => item.fragmentIndex)).toEqual([0]);
  });

  test("manages translation start and stop lifecycle explicitly", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-project-lifecycle-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "第一句\n第二句\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "lifecycle",
        projectDir: workspaceDir,
        chapters: [{ id: 1, filePath: "sources\\chapter-1.txt" }],
      },
      {
        textSplitter: {
          split(units) {
            return units.map((unit) => [unit]);
          },
        },
      },
    );
    await project.initialize();

    await expect(project.getWorkQueue("translation").dispatchReadyItems()).rejects.toThrow();

    const started = await project.startTranslation();
    expect(started.status).toBe("running");

    const firstBatch = await project.getWorkQueue("translation").dispatchReadyItems();
    expect(firstBatch).toHaveLength(1);

    const stopping = await project.stopTranslation();
    expect(stopping.status).toBe("stopping");
    await expect(project.getWorkQueue("translation").dispatchReadyItems()).rejects.toThrow();

    await project.submitWorkResult({
      runId: firstBatch[0]!.runId,
      stepId: "translation",
      chapterId: 1,
      fragmentIndex: 0,
      outputText: "Line 1",
    });
    expect(project.getLifecycleSnapshot().status).toBe("stopped");

    await project.startTranslation();
    const secondBatch = await project.getWorkQueue("translation").dispatchReadyItems();
    expect(secondBatch).toHaveLength(1);

    const stopped = await project.stopTranslation({ mode: "immediate" });
    expect(stopped.status).toBe("stopped");
    expect(project.getDocumentManager().getPipelineStepState(1, 1, "translation")?.status).toBe(
      "queued",
    );

    await expect(
      project.submitWorkResult({
        runId: secondBatch[0]!.runId,
        stepId: "translation",
        chapterId: 1,
        fragmentIndex: 1,
        outputText: "Line 2",
      }),
    ).rejects.toThrow("当前项目不接受翻译结果");
  });

  test("supports explicit abort and later resume", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-project-abort-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "第一句\n第二句\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "abort",
        projectDir: workspaceDir,
        chapters: [{ id: 1, filePath: "sources\\chapter-1.txt" }],
      },
      {
        textSplitter: {
          split(units) {
            return units.map((unit) => [unit]);
          },
        },
      },
    );
    await project.initialize();
    await project.startTranslation();

    const firstBatch = await project.getWorkQueue("translation").dispatchReadyItems();
    expect(firstBatch).toHaveLength(1);
    expect(project.getLifecycleSnapshot().canAbort).toBe(true);

    const aborted = await project.abortTranslation("user_requested_abort");
    expect(aborted.status).toBe("aborted");
    expect(aborted.abortReason).toBe("user_requested_abort");
    expect(aborted.canResume).toBe(true);
    expect(project.getDocumentManager().getPipelineStepState(1, 0, "translation")?.status).toBe(
      "queued",
    );

    await expect(
      project.submitWorkResult({
        runId: firstBatch[0]!.runId,
        stepId: "translation",
        chapterId: 1,
        fragmentIndex: 0,
        outputText: "Line 1",
      }),
    ).rejects.toThrow("当前项目不接受翻译结果");

    const resumed = await project.startTranslation();
    expect(resumed.status).toBe("running");
    const resumedBatch = await project.getWorkQueue("translation").dispatchReadyItems();
    expect(resumedBatch.map((item) => item.fragmentIndex)).toEqual([0]);
  });

  test("persists progress save metadata in project state", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-project-save-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "第一句\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "save",
        projectDir: workspaceDir,
        chapters: [{ id: 1, filePath: "sources\\chapter-1.txt" }],
      },
      {
        textSplitter: {
          split(units) {
            return units.map((unit) => [unit]);
          },
        },
      },
    );
    await project.initialize();
    await project.startTranslation();
    await project.saveProgress();

    const lifecycle = project.getLifecycleSnapshot();
    expect(lifecycle.lastSavedAt).toBeTruthy();
    expect(lifecycle.canSave).toBe(true);

    const persistedState = JSON.parse(
      await readFile(join(workspaceDir, "Data", "project-state.json"), "utf8"),
    ) as { lifecycle?: { lastSavedAt?: string } };
    expect(persistedState.lifecycle?.lastSavedAt).toBe(lifecycle.lastSavedAt);
  });

  test("saves glossary using the current workspace glossary path", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-project-glossary-save-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "第一句\n", "utf8");

    const glossary = new Glossary([
      {
        term: "勇者",
        translation: "Hero",
      },
    ]);

    const project = new TranslationProject(
      {
        projectName: "glossary-save",
        projectDir: workspaceDir,
        chapters: [{ id: 1, filePath: "sources\\chapter-1.txt" }],
      },
      {
        glossary,
        textSplitter: {
          split(units) {
            return units.map((unit) => [unit]);
          },
        },
      },
    );
    await project.initialize();
    await project.updateWorkspaceConfig({
      glossary: {
        path: "glossary.json",
      },
    });

    expect(project.getWorkspaceFileManifest().glossaryPath).toBe(join(workspaceDir, "glossary.json"));

    await project.saveProgress();

    const persistedGlossary = await GlossaryPersisterFactory.getPersister(
      join(workspaceDir, "glossary.json"),
    ).loadGlossary(join(workspaceDir, "glossary.json"));
    expect(persistedGlossary.getTerm("勇者")?.translation).toBe("Hero");
  });

  test("loads glossary from the persisted workspace glossary path", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-project-glossary-load-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(join(workspaceDir, "Data"), { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "第一句\n", "utf8");

    const glossaryPath = join(workspaceDir, "glossary.json");
    await GlossaryPersisterFactory.getPersister(glossaryPath).saveGlossary(
      new Glossary([
        {
          term: "王都",
          translation: "Royal Capital",
        },
      ]),
      glossaryPath,
    );

    await writeFile(
      join(workspaceDir, "Data", "workspace-config.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          projectName: "glossary-load",
          chapters: [{ id: 1, filePath: "sources\\chapter-1.txt" }],
          glossary: {
            path: "glossary.json",
          },
          translator: {},
          slidingWindow: {},
          customRequirements: [],
        },
        null,
        2,
      ),
      "utf8",
    );

    const project = new TranslationProject(
      {
        projectName: "glossary-load",
        projectDir: workspaceDir,
        chapters: [{ id: 1, filePath: "sources\\chapter-1.txt" }],
      },
      {
        textSplitter: {
          split(units) {
            return units.map((unit) => [unit]);
          },
        },
      },
    );

    await project.initialize();

    expect(project.getGlossary()?.getTerm("王都")?.translation).toBe("Royal Capital");
    expect(project.getWorkspaceFileManifest().glossaryPath).toBe(glossaryPath);
  });
});
