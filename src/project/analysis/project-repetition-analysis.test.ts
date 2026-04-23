import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranslationProject } from "../pipeline/translation-project.ts";

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

  test("persists saved pattern locations and hydrates live translations after reopen", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-project-repetition-persist-"));
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
        projectName: "repetition-persist-demo",
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
    await project.updateTranslatedLine(1, 0, 0, "Academy gate queue");
    await project.updateTranslatedLine(1, 1, 0, "Academy entrance closed");

    const saved = await project.scanAndSaveRepeatedPatterns({
      minOccurrences: 2,
      minLength: 4,
      maxResults: 5,
    });
    expect(saved.patterns[0]?.text).toBe("学院门口");
    expect("translatedSentence" in (saved.patterns[0]?.locations[0] ?? {})).toBe(false);

    await project.updateTranslatedLine(1, 1, 0, "Academy gate queue");

    const reopened = await TranslationProject.openWorkspace(workspaceDir, {
      textSplitter: {
        split(units) {
          return units.map((unit) => [unit]);
        },
      },
    });

    const reopenedSaved = reopened.getSavedRepeatedPatterns();
    expect(reopenedSaved?.patterns.map((pattern) => pattern.text)).toContain("学院门口");

    const hydrated = reopened.hydrateSavedRepeatedPatterns();
    expect(hydrated?.patterns[0]?.isTranslationConsistent).toBe(true);
    expect(hydrated?.patterns[0]?.translations).toHaveLength(1);
  });

  test("invalidates saved pattern scan after chapter structure changes", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-project-repetition-invalidate-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "学院门口正在排队\n学院门口已经关闭\n", "utf8");
    await writeFile(join(sourceDir, "chapter-2.txt"), "操场正在训练\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "repetition-invalidate-demo",
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
    await project.scanAndSaveRepeatedPatterns({
      minOccurrences: 2,
      minLength: 4,
      maxResults: 5,
    });

    expect(project.getSavedRepeatedPatterns()).not.toBeNull();

    await project.addChapter(2, "sources\\chapter-2.txt");
    expect(project.getSavedRepeatedPatterns()).toBeNull();
  });

  test("builds chapter editor pattern hover data from the current chapter translations", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-project-repetition-editor-"));
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
        projectName: "repetition-editor-demo",
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
    await project.updateTranslatedLine(1, 0, 0, "Academy gate queue");
    await project.updateTranslatedLine(1, 1, 0, "Academy gate closed");
    await project.scanAndSaveRepeatedPatterns({
      minOccurrences: 2,
      minLength: 4,
      maxResults: 5,
    });

    const document = project.getChapterTranslationEditorDocument(1, "naturedialog");
    expect(document.repetitionMatches).not.toHaveLength(0);
    expect(document.repetitionMatches[0]).toMatchObject({
      text: "学院门口",
      unitIndex: 0,
    });
    expect(document.repetitionMatches[0]?.hoverText).toContain("Academy gate closed");
  });
});
