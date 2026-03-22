import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  test("tracks progress and preceding contexts across chapters", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-project-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "第一句\n第二句\n", "utf8");
    await writeFile(join(sourceDir, "chapter-2.txt"), "第三句\n", "utf8");

    const project = new TranslationProject({
      projectName: "demo",
      projectDir: workspaceDir,
      chapters: [
        { id: 1, filePath: "sources\\chapter-1.txt" },
        { id: 2, filePath: "sources\\chapter-2.txt" },
      ],
      context: {
        includeEarlierFragments: 2,
      },
      customRequirements: ["保持称谓一致"],
    }, {
      textSplitter: {
        split(units) {
          return units.map((unit) => [unit]);
        },
      },
    });

    await project.initialize();

    const firstTask = await project.getNextTask();
    expect(firstTask?.chapterId).toBe(1);
    expect(firstTask?.fragmentIndex).toBe(0);
    expect(firstTask?.contextView.getContexts()).toEqual([]);

    const secondTaskView = project.getContextView(1, 1);
    expect(secondTaskView.getContexts()).toEqual([]);

    await project.submitResult({
      chapterId: 1,
      fragmentIndex: 0,
      translatedText: "Line 1",
    });

    const precedingFromView = secondTaskView.getContext("precedingTranslation");
    expect(precedingFromView?.type).toBe("precedingTranslation");
    if (precedingFromView?.type === "precedingTranslation") {
      expect(precedingFromView.pairs[0]?.translatedText).toBe("Line 1");
    }

    const secondTask = await project.getNextTask();
    expect(secondTask?.chapterId).toBe(1);
    expect(secondTask?.fragmentIndex).toBe(1);
    const precedingFromTask = secondTask?.contextView.getContext("precedingTranslation");
    expect(precedingFromTask?.type).toBe("precedingTranslation");
    if (precedingFromTask?.type === "precedingTranslation") {
      expect(precedingFromTask.pairs[0]?.translatedText).toBe("Line 1");
    }

    await project.submitResult({
      chapterId: 1,
      fragmentIndex: 1,
      translatedText: "Line 2",
    });

    const thirdTask = await project.getNextTask();
    expect(thirdTask?.chapterId).toBe(2);
    const precedingFromThirdTask =
      thirdTask?.contextView.getContext("precedingTranslation");
    expect(precedingFromThirdTask?.type).toBe("precedingTranslation");
    if (precedingFromThirdTask?.type === "precedingTranslation") {
      expect(precedingFromThirdTask.pairs).toHaveLength(2);
    }

    const progress = project.getProgress();
    expect(progress.totalChapters).toBe(2);
    expect(progress.totalFragments).toBe(3);
    expect(progress.translatedFragments).toBe(2);
    expect(progress.translatedChapters).toBe(1);
    expect(progress.fragmentProgressRatio).toBeCloseTo(2 / 3);
  });

  test("traverses chapters and preceding context in configured linear order", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-linear-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-a.txt"), "第一章第一句\n", "utf8");
    await writeFile(join(sourceDir, "chapter-b.txt"), "第二章第一句\n", "utf8");

    const project = new TranslationProject({
      projectName: "linear",
      projectDir: workspaceDir,
      chapters: [
        { id: 20, filePath: "sources\\chapter-b.txt" },
        { id: 10, filePath: "sources\\chapter-a.txt" },
      ],
      context: {
        includeEarlierFragments: 1,
      },
    }, {
      textSplitter: {
        split(units) {
          return units.map((unit) => [unit]);
        },
      },
    });
    await project.initialize();

    const firstTask = await project.getNextTask();
    expect(firstTask?.chapterId).toBe(20);

    await project.submitResult({
      chapterId: 20,
      fragmentIndex: 0,
      translatedText: "Chapter B Line 1",
    });

    const secondTask = await project.getNextTask();
    expect(secondTask?.chapterId).toBe(10);
    expect(secondTask?.contextView.getContexts().map((context) => context.type)).toEqual([
      "precedingTranslation",
    ]);

    const precedingContext = secondTask?.contextView.getContext("precedingTranslation");
    expect(precedingContext?.type).toBe("precedingTranslation");
    if (precedingContext?.type === "precedingTranslation") {
      expect(precedingContext.pairs).toHaveLength(1);
      expect(precedingContext.pairs[0]?.chapterId).toBe(20);
      expect(precedingContext.pairs[0]?.translatedText).toBe("Chapter B Line 1");
    }
  });
});
