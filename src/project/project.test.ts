import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glossary } from "../glossary/glossary.ts";
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

    const translationQueue = project.getWorkQueue("translation");
    const firstBatch = await translationQueue.dispatchReadyItems();
    expect(firstBatch).toHaveLength(1);
    expect(firstBatch[0]?.metadata.dependencyMode).toBe("previousTranslations");
    expect(firstBatch[0]?.contextView?.getContexts()).toEqual([]);

    await project.submitWorkResult({
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
        status: "untranslated",
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

    const translationQueue = project.getWorkQueue("translation");
    const firstBatch = await translationQueue.dispatchReadyItems();
    expect(firstBatch.map((item) => item.fragmentIndex)).toEqual([0]);

    await project.submitWorkResult({
      stepId: "translation",
      chapterId: 1,
      fragmentIndex: 0,
      outputText: "Royal capital bulletin",
    });

    const secondBatch = await translationQueue.dispatchReadyItems();
    expect(secondBatch.map((item) => item.fragmentIndex)).toEqual([1]);

    await project.submitWorkResult({
      stepId: "translation",
      chapterId: 1,
      fragmentIndex: 1,
      outputText: "Church bells of the royal capital",
    });

    glossary.updateTerm("王都", {
      term: "王都",
      translation: "Royal Capital",
      status: "translated",
      totalOccurrenceCount: 3,
      textBlockOccurrenceCount: 3,
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
      expect(glossaryContext.pairs).toHaveLength(2);
      expect(glossaryContext.pairs[0]?.sourceText).toBe("王都教会钟声回荡");
      expect(glossaryContext.pairs[1]?.sourceText).toBe("王都公告正式发布");
    }
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

    const draftQueue = project.getWorkQueue("draft");
    const draftBatch = await draftQueue.dispatchReadyItems();
    expect(draftBatch.map((item) => item.fragmentIndex)).toEqual([0, 1]);

    await project.submitWorkResult({
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

    const translationQueue = project.getWorkQueue("translation");
    const firstBatch = await translationQueue.dispatchReadyItems();
    expect(firstBatch).toHaveLength(1);
    expect(project.getDocumentManager().getPipelineStepState(1, 0, "translation")?.status).toBe(
      "running",
    );

    await project.submitWorkResult({
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
});
