import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Glossary } from "../../glossary/glossary.ts";
import { GlossaryPersisterFactory } from "../../glossary/persister.ts";
import type { TranslationPipelineDefinition } from "./pipeline.ts";
import { SqliteProjectStorage } from "../storage/sqlite-project-storage.ts";
import { TranslationProject } from "./translation-project.ts";
import {
  buildWorkspaceBootstrapDocument,
  saveWorkspaceBootstrap,
} from "./translation-project-workspace.ts";

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

  test("prevents concurrent dispatch of items sharing the same untranslated glossary term", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-glossary-term-lock-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "chapter-1.txt"),
      [
        "王都公告正式发布",
        "王都教会钟声回荡",
        "王都广场开始集合",
        "王都骑士开始列队",
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
        projectName: "glossary-term-lock",
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
    ]);

    await project.submitWorkResult({
      runId: thirdBatch[0]!.runId,
      stepId: "translation",
      chapterId: 1,
      fragmentIndex: 2,
      outputText: "Royal capital square gathers",
    });

    const fourthBatch = await translationQueue.dispatchReadyItems();
    expect(fourthBatch.map((item) => [item.fragmentIndex, item.metadata.dependencyMode])).toEqual([
      [3, "previousTranslations"],
    ]);
  });

  test("releases glossary term reservation when a running item returns to queued", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-glossary-term-retry-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "chapter-1.txt"),
      [
        "王都公告正式发布",
        "王都教会钟声回荡",
        "王都广场开始集合",
        "王都骑士开始列队",
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
        projectName: "glossary-term-retry",
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
    await project.submitWorkResult({
      runId: firstBatch[0]!.runId,
      stepId: "translation",
      chapterId: 1,
      fragmentIndex: 0,
      outputText: "Royal capital bulletin",
    });

    const secondBatch = await translationQueue.dispatchReadyItems();
    await project.submitWorkResult({
      runId: secondBatch[0]!.runId,
      stepId: "translation",
      chapterId: 1,
      fragmentIndex: 1,
      outputText: "Church bells of the royal capital",
    });

    const thirdBatch = await translationQueue.dispatchReadyItems();
    expect(thirdBatch.map((item) => item.fragmentIndex)).toEqual([2]);

    await project.submitWorkResult({
      runId: thirdBatch[0]!.runId,
      stepId: "translation",
      chapterId: 1,
      fragmentIndex: 2,
      success: false,
      errorMessage: "retry later",
    });

    const retryBatch = await translationQueue.dispatchReadyItems();
    expect(retryBatch.map((item) => item.fragmentIndex)).toEqual([2]);
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

  test("builds a synthetic main-route topology descriptor for linear workspaces", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-topology-descriptor-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "第一章\n", "utf8");
    await writeFile(join(sourceDir, "chapter-2.txt"), "第二章\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "synthetic-topology",
        projectDir: workspaceDir,
        chapters: [
          { id: 1, filePath: "sources\\chapter-1.txt" },
          { id: 2, filePath: "sources\\chapter-2.txt" },
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

    const topology = project.getStoryTopologyDescriptor();
    expect(topology.hasPersistedTopology).toBe(false);
    expect(topology.hasBranches).toBe(false);
    expect(topology.routes).toEqual([
      {
        id: "main",
        name: "主线",
        parentRouteId: null,
        forkAfterChapterId: null,
        chapters: [1, 2],
        childRouteIds: [],
        depth: 0,
        isMain: true,
      },
    ]);

    const descriptors = project.getChapterDescriptors();
    expect(descriptors.map((chapter) => chapter.routeId)).toEqual(["main", "main"]);
    expect(descriptors.map((chapter) => chapter.routeChapterIndex)).toEqual([0, 1]);
  });

  test("creates a persisted branch topology and annotates chapter descriptors", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-branch-topology-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "第一章\n", "utf8");
    await writeFile(join(sourceDir, "chapter-2.txt"), "第二章\n", "utf8");
    await writeFile(join(sourceDir, "chapter-3.txt"), "第三章\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "branch-topology",
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

    await project.createStoryBranch({
      id: "branch-1",
      name: "分支 1",
      forkAfterChapterId: 1,
      chapterIds: [2, 3],
    });

    const topology = project.getStoryTopologyDescriptor();
    expect(topology.hasPersistedTopology).toBe(true);
    expect(topology.hasBranches).toBe(true);
    expect(topology.routes).toEqual([
      {
        id: "main",
        name: "主线",
        parentRouteId: null,
        forkAfterChapterId: null,
        chapters: [1],
        childRouteIds: ["branch-1"],
        depth: 0,
        isMain: true,
      },
      {
        id: "branch-1",
        name: "分支 1",
        parentRouteId: "main",
        forkAfterChapterId: 1,
        chapters: [2, 3],
        childRouteIds: [],
        depth: 1,
        isMain: false,
      },
    ]);

    const descriptors = project.getChapterDescriptors();
    expect(descriptors.find((chapter) => chapter.id === 1)).toMatchObject({
      routeId: "main",
      isForkPoint: true,
      childBranchCount: 1,
    });
    expect(descriptors.find((chapter) => chapter.id === 2)).toMatchObject({
      routeId: "branch-1",
      routeName: "分支 1",
      routeChapterIndex: 0,
    });

    const topologyFile = await readFile(join(workspaceDir, "Data", "story-topology.json"), "utf8");
    expect(JSON.parse(topologyFile)).toMatchObject({
      routes: [
        { id: "main", chapters: [1] },
        { id: "branch-1", chapters: [2, 3] },
      ],
    });
  });

  test("batch-remove cascades descendant branches when fork points are selected", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-batch-remove-cascade-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "第一章\n", "utf8");
    await writeFile(join(sourceDir, "chapter-2.txt"), "第二章\n", "utf8");
    await writeFile(join(sourceDir, "chapter-3.txt"), "第三章\n", "utf8");
    await writeFile(join(sourceDir, "chapter-4.txt"), "第四章\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "batch-remove-cascade",
        projectDir: workspaceDir,
        chapters: [
          { id: 1, filePath: "sources/chapter-1.txt" },
          { id: 2, filePath: "sources/chapter-2.txt" },
          { id: 3, filePath: "sources/chapter-3.txt" },
          { id: 4, filePath: "sources/chapter-4.txt" },
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

    await project.createStoryBranch({
      id: "branch-a",
      name: "分支 A",
      forkAfterChapterId: 1,
      chapterIds: [2, 3, 4],
    });
    await project.createStoryBranch({
      id: "branch-a-sub",
      name: "分支 A 子线",
      parentRouteId: "branch-a",
      forkAfterChapterId: 2,
      chapterIds: [3, 4],
    });

    await project.removeChapters([1], { cascadeBranches: true });

    expect(project.getChapterDescriptors()).toEqual([]);
    expect(project.getStoryTopologyDescriptor().routes).toEqual([
      {
        id: "main",
        name: "主线",
        parentRouteId: null,
        forkAfterChapterId: null,
        chapters: [],
        childRouteIds: [],
        depth: 0,
        isMain: true,
      },
    ]);
  });

  test("batch-remove blocks deleting fork points when cascade is disabled", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-batch-remove-block-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "第一章\n", "utf8");
    await writeFile(join(sourceDir, "chapter-2.txt"), "第二章\n", "utf8");
    await writeFile(join(sourceDir, "chapter-3.txt"), "第三章\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "batch-remove-block",
        projectDir: workspaceDir,
        chapters: [
          { id: 1, filePath: "sources/chapter-1.txt" },
          { id: 2, filePath: "sources/chapter-2.txt" },
          { id: 3, filePath: "sources/chapter-3.txt" },
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
    await project.createStoryBranch({
      id: "branch-a",
      name: "分支 A",
      forkAfterChapterId: 1,
      chapterIds: [2, 3],
    });

    await expect(project.removeChapters([1], { cascadeBranches: false })).rejects.toThrow(
      "分叉点",
    );
    expect(project.getChapterDescriptors().map((chapter) => chapter.id)).toEqual([1, 2, 3]);
  });

  test("batch-remove deduplicates chapter IDs before deletion", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-batch-remove-dedupe-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "第一章\n", "utf8");
    await writeFile(join(sourceDir, "chapter-2.txt"), "第二章\n", "utf8");
    await writeFile(join(sourceDir, "chapter-3.txt"), "第三章\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "batch-remove-dedupe",
        projectDir: workspaceDir,
        chapters: [
          { id: 1, filePath: "sources/chapter-1.txt" },
          { id: 2, filePath: "sources/chapter-2.txt" },
          { id: 3, filePath: "sources/chapter-3.txt" },
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

    await project.removeChapters([2, 2]);
    expect(project.getChapterDescriptors().map((chapter) => chapter.id)).toEqual([1, 3]);
  });

  test("batch-remove validates full input and avoids partial deletion on invalid chapter IDs", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-batch-remove-validate-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "第一章\n", "utf8");
    await writeFile(join(sourceDir, "chapter-2.txt"), "第二章\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "batch-remove-validate",
        projectDir: workspaceDir,
        chapters: [
          { id: 1, filePath: "sources/chapter-1.txt" },
          { id: 2, filePath: "sources/chapter-2.txt" },
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

    await expect(project.removeChapters([1, 99])).rejects.toThrow("章节 99 不存在");
    expect(project.getChapterDescriptors().map((chapter) => chapter.id)).toEqual([1, 2]);
  });

  test("removing a chapter deletes its orphaned source file inside workspace", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-remove-source-file-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    const chapterPath = join(sourceDir, "chapter-1.txt");
    await writeFile(chapterPath, "第一章\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "remove-source-file",
        projectDir: workspaceDir,
        chapters: [{ id: 1, filePath: "sources/chapter-1.txt" }],
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

    expect(await fileExists(chapterPath)).toBe(true);
    await project.removeChapter(1);
    expect(await fileExists(chapterPath)).toBe(false);
  });

  test("removing one chapter does not delete source file when still referenced by another chapter", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-remove-shared-source-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    const chapterPath = join(sourceDir, "shared.txt");
    await writeFile(chapterPath, "共享章节\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "remove-shared-source",
        projectDir: workspaceDir,
        chapters: [
          { id: 1, filePath: "sources/shared.txt" },
          { id: 2, filePath: "sources/shared.txt" },
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

    await project.removeChapter(1);
    expect(await fileExists(chapterPath)).toBe(true);
    await project.removeChapter(2);
    expect(await fileExists(chapterPath)).toBe(false);
  });

  test("removing a chapter does not delete source files outside workspace", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-remove-external-source-"));
    cleanupTargets.push(workspaceDir);

    const externalDir = await mkdtemp(join(tmpdir(), "soloyakusha-external-source-"));
    cleanupTargets.push(externalDir);
    const externalPath = join(externalDir, "chapter-external.txt");
    await writeFile(externalPath, "外部章节\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "remove-external-source",
        projectDir: workspaceDir,
        chapters: [{ id: 1, filePath: resolve(externalPath) }],
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

    await project.removeChapter(1);
    expect(await fileExists(externalPath)).toBe(true);
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

  test("requeues cleared chapter translations after project completion", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-clear-chapter-queue-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "第一章\n", "utf8");
    await writeFile(join(sourceDir, "chapter-2.txt"), "第二章\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "clear-chapter-queue",
        projectDir: workspaceDir,
        chapters: [
          { id: 1, filePath: "sources\\chapter-1.txt" },
          { id: 2, filePath: "sources\\chapter-2.txt" },
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

    const translationQueue = project.getWorkQueue("translation");
    const firstBatch = await translationQueue.dispatchReadyItems();
    await project.submitWorkResult({
      runId: firstBatch[0]!.runId,
      stepId: "translation",
      chapterId: 1,
      fragmentIndex: 0,
      outputText: "Chapter 1",
    });

    const secondBatch = await translationQueue.dispatchReadyItems();
    await project.submitWorkResult({
      runId: secondBatch[0]!.runId,
      stepId: "translation",
      chapterId: 2,
      fragmentIndex: 0,
      outputText: "Chapter 2",
    });

    expect(project.getLifecycleSnapshot().status).toBe("completed");

    await project.clearChapterTranslations([2]);

    expect(project.getFragment(1, 0)?.translation.lines).toEqual(["Chapter 1"]);
    expect(project.getFragment(2, 0)?.translation.lines).toEqual([""]);

    const snapshot = project.getProjectSnapshot();
    expect(snapshot.progress.translatedFragments).toBe(1);
    expect(snapshot.progress.translatedChapters).toBe(1);
    expect(snapshot.lifecycle.status).toBe("stopped");
    expect(snapshot.lifecycle.queuedWorkItems).toBe(1);
    expect(snapshot.lifecycle.activeWorkItems).toBe(0);
    expect(snapshot.queueSnapshots[0]?.progress.completedFragments).toBe(1);
    expect(snapshot.queueSnapshots[0]?.progress.readyFragments).toBe(1);
    expect(snapshot.queueSnapshots[0]?.progress.waitingFragments).toBe(0);
    expect(project.getReadyWorkItemSnapshots().map((item) => item.chapterId)).toEqual([2]);

    await project.startTranslation();
    const resumedBatch = await translationQueue.dispatchReadyItems();
    expect(resumedBatch.map((item) => [item.chapterId, item.fragmentIndex])).toEqual([[2, 0]]);
  });

  test("requeues all fragments after clearing all translations from a completed project", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-clear-all-queue-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "第一句\n第二句\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "clear-all-queue",
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
    await project.submitWorkResult({
      runId: firstBatch[0]!.runId,
      stepId: "translation",
      chapterId: 1,
      fragmentIndex: 0,
      outputText: "Line 1",
    });

    const secondBatch = await translationQueue.dispatchReadyItems();
    await project.submitWorkResult({
      runId: secondBatch[0]!.runId,
      stepId: "translation",
      chapterId: 1,
      fragmentIndex: 1,
      outputText: "Line 2",
    });

    expect(project.getLifecycleSnapshot().status).toBe("completed");

    await project.clearAllTranslations();

    expect(project.getFragment(1, 0)?.translation.lines).toEqual([""]);
    expect(project.getFragment(1, 1)?.translation.lines).toEqual([""]);

    const snapshot = project.getProjectSnapshot();
    expect(snapshot.progress.translatedFragments).toBe(0);
    expect(snapshot.progress.translatedChapters).toBe(0);
    expect(snapshot.lifecycle.status).toBe("stopped");
    expect(snapshot.lifecycle.queuedWorkItems).toBe(2);
    expect(snapshot.lifecycle.activeWorkItems).toBe(0);
    expect(snapshot.queueSnapshots[0]?.progress.completedFragments).toBe(0);
    expect(snapshot.queueSnapshots[0]?.progress.readyFragments).toBe(1);
    expect(snapshot.queueSnapshots[0]?.progress.waitingFragments).toBe(1);
    expect(project.getReadyWorkItemSnapshots().map((item) => item.fragmentIndex)).toEqual([0]);

    await project.startTranslation();
    const resumedBatch = await translationQueue.dispatchReadyItems();
    expect(resumedBatch.map((item) => item.fragmentIndex)).toEqual([0]);
  });

  test("clearing translations during a run aborts the active run and rebuilds the queue", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-clear-running-queue-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "第一句\n第二句\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "clear-running-queue",
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
    const staleRunId = firstBatch[0]!.runId;

    await project.clearChapterTranslations([1]);

    const snapshot = project.getProjectSnapshot();
    expect(snapshot.lifecycle.status).toBe("aborted");
    expect(snapshot.lifecycle.activeWorkItems).toBe(0);
    expect(snapshot.lifecycle.queuedWorkItems).toBe(2);
    expect(snapshot.queueSnapshots[0]?.progress.completedFragments).toBe(0);
    expect(snapshot.queueSnapshots[0]?.progress.readyFragments).toBe(1);
    expect(snapshot.queueSnapshots[0]?.progress.waitingFragments).toBe(1);
    expect(project.getFragment(1, 0)?.translation.lines).toEqual([""]);
    expect(project.getFragment(1, 1)?.translation.lines).toEqual([""]);

    await expect(
      project.submitWorkResult({
        runId: staleRunId,
        stepId: "translation",
        chapterId: 1,
        fragmentIndex: 0,
        outputText: "stale result",
      }),
    ).rejects.toThrow("当前项目不接受翻译结果");

    const resumed = await project.startTranslation();
    expect(resumed.status).toBe("running");

    const resumedBatch = await translationQueue.dispatchReadyItems();
    expect(resumedBatch.map((item) => item.fragmentIndex)).toEqual([0]);
    expect(resumedBatch[0]?.runId).not.toBe(staleRunId);
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

    const persistedState = await new SqliteProjectStorage(join(workspaceDir, "Data", "project.sqlite"))
      .loadProjectState();
    expect(persistedState).toBeTruthy();
    expect(persistedState!.lifecycle?.lastSavedAt).toBe(lifecycle.lastSavedAt);
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

  test("clears inactive style guidance fields when switching guidance mode", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-project-style-guidance-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "第一句\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "style-guidance",
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

    await project.updateWorkspaceConfig({
      styleGuidanceMode: "requirements",
      styleRequirementsText: "整体口语化，避免半文言句式，并且让叙述更贴近现代简中读者的阅读习惯。",
    });

    expect(project.getWorkspaceConfig()).toMatchObject({
      styleGuidanceMode: "requirements",
      styleRequirementsText: "整体口语化，避免半文言句式，并且让叙述更贴近现代简中读者的阅读习惯。",
      styleLibraryName: undefined,
    });

    await project.updateWorkspaceConfig({
      styleGuidanceMode: "examples",
      styleLibraryName: "campus-style",
    });

    expect(project.getWorkspaceConfig()).toMatchObject({
      styleGuidanceMode: "examples",
      styleRequirementsText: undefined,
      styleLibraryName: "campus-style",
    });
  });

  test("loads glossary from the persisted workspace glossary path", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-project-glossary-load-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
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

    await createPersistedWorkspaceFixture(workspaceDir, {
      schemaVersion: 1,
      projectName: "glossary-load",
      chapters: [{ id: 1, filePath: "sources\\chapter-1.txt" }],
      glossary: {
        path: "glossary.json",
      },
      translator: {},
      slidingWindow: {},
      customRequirements: [],
    });

    const project = await TranslationProject.openWorkspace(
      workspaceDir,
      {
        textSplitter: {
          split(units) {
            return units.map((unit) => [unit]);
          },
        },
      },
    );

    expect(project.getGlossary()?.getTerm("王都")?.translation).toBe("Royal Capital");
    expect(project.getWorkspaceFileManifest().glossaryPath).toBe(glossaryPath);
  });

  test("rejects deprecated JSON workspaces and asks users to delete them", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-project-legacy-"));
    cleanupTargets.push(workspaceDir);

    await mkdir(join(workspaceDir, "Data"), { recursive: true });
    await writeFile(
      join(workspaceDir, "Data", "workspace-config.json"),
      JSON.stringify({
        schemaVersion: 1,
        projectName: "legacy-workspace",
        chapters: [],
        glossary: {},
        translator: {},
        slidingWindow: {},
        customRequirements: [],
      }),
      "utf8",
    );

    await expect(TranslationProject.openWorkspace(workspaceDir)).rejects.toThrow(
      "请删除该旧工作区后重新创建",
    );
  });
});

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createPersistedWorkspaceFixture(
  workspaceDir: string,
  config: {
    schemaVersion: 1;
    projectName: string;
    chapters: Array<{ id: number; filePath: string }>;
    glossary: { path?: string; autoFilter?: boolean };
    translator: Record<string, unknown>;
    slidingWindow: Record<string, unknown>;
    customRequirements: string[];
    textSplitMaxChars?: number;
    contextSize?: number;
    defaultImportFormat?: string;
    defaultExportFormat?: string;
  },
): Promise<void> {
  const databasePath = join(workspaceDir, "Data", "project.sqlite");
  const storage = new SqliteProjectStorage(databasePath);
  await storage.saveWorkspaceConfig(config);
  await saveWorkspaceBootstrap(
    workspaceDir,
    buildWorkspaceBootstrapDocument(config.projectName),
  );
}
