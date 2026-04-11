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

describe("TranslationProject repetition analysis", () => {
  test("builds repeated-pattern analysis from the current project corpus", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-project-repetition-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "chapter-1.txt"),
      [
        "学院门口正在排队",
        "学院门口已经关闭",
      ].join("\n"),
      "utf8",
    );

    const project = new TranslationProject(
      {
        projectName: "repetition-demo",
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
    await project.getDocumentManager().updateTranslation(1, 0, "Students are queueing at the academy gate");
    await project.getDocumentManager().updateTranslation(1, 1, "The academy gate is already closed");

    const result = project.analyzeRepeatedPatterns({
      minOccurrences: 2,
      minLength: 4,
      maxResults: 5,
    });

    expect(result.totalSentenceCount).toBe(2);
    expect(result.patterns[0]).toMatchObject({
      text: "学院门口",
      occurrenceCount: 2,
      isTranslationConsistent: false,
    });
    expect(result.patterns[0]?.locations.map((location) => location.fragmentIndex)).toEqual([
      0, 1,
    ]);
    expect(result.patterns[0]?.locations.map((location) => location.chapterFilePath)).toEqual([
      "sources\\chapter-1.txt",
      "sources\\chapter-1.txt",
    ]);

    await project.updateTranslatedLine(1, 1, 0, "Students are queueing at the academy gate");
    const refreshed = project.analyzeRepeatedPatterns({
      minOccurrences: 2,
      minLength: 4,
      maxResults: 5,
    });
    expect(refreshed.patterns[0]?.isTranslationConsistent).toBe(true);
    expect(refreshed.patterns[0]?.translations).toHaveLength(1);
  });

  test("supports limiting repeated-pattern analysis to a chapter subset", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-project-repetition-scope-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "学院门口正在排队\n", "utf8");
    await writeFile(join(sourceDir, "chapter-2.txt"), "操场正在训练\n", "utf8");
    await writeFile(join(sourceDir, "chapter-3.txt"), "学院门口已经关闭\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "repetition-scope-demo",
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

    const fullResult = project.analyzeRepeatedPatterns({
      minOccurrences: 2,
      minLength: 4,
      maxResults: 5,
    });
    expect(fullResult.patterns.map((pattern) => pattern.text)).toContain("学院门口");

    const scopedResult = project.analyzeRepeatedPatterns({
      minOccurrences: 2,
      minLength: 4,
      maxResults: 5,
      chapterIds: [1, 2],
    });
    expect(scopedResult.totalSentenceCount).toBe(2);
    expect(scopedResult.patterns).toEqual([]);

    const crossChapterScopedResult = project.analyzeRepeatedPatterns({
      minOccurrences: 2,
      minLength: 4,
      maxResults: 5,
      chapterIds: [1, 3],
    });
    expect(crossChapterScopedResult.totalSentenceCount).toBe(2);
    expect(crossChapterScopedResult.patterns[0]).toMatchObject({
      text: "学院门口",
      occurrenceCount: 2,
    });
  });
});
