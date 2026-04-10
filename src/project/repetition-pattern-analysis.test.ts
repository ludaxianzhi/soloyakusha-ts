import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranslationDocumentManager } from "./translation-document-manager.ts";
import {
  buildRepetitionPatternCorpus,
  RepetitionPatternAnalyzer,
} from "./repetition-pattern-analysis.ts";

const cleanupTargets: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupTargets.splice(0, cleanupTargets.length).map((target) =>
      rm(target, { recursive: true, force: true }),
    ),
  );
});

describe("RepetitionPatternAnalyzer", () => {
  test("maps repeated patterns back to sentence locations and translation variants", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-repetition-analysis-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "chapter-1.txt"),
      [
        "王都中央广场入口今天开放",
        "王都中央广场入口正在排队",
        "王都中央广场入口夜间关闭",
      ].join("\n"),
      "utf8",
    );

    const documentManager = new TranslationDocumentManager(workspaceDir, {
      textSplitter: {
        split(units) {
          return units.map((unit) => [unit]);
        },
      },
    });
    await documentManager.loadChapters([
      {
        chapterId: 1,
        filePath: join(sourceDir, "chapter-1.txt"),
      },
    ]);
    await documentManager.updateTranslation(1, 0, "Royal Plaza entrance opens today");
    await documentManager.updateTranslation(1, 1, "Royal Plaza entrance has a queue");
    await documentManager.updateTranslation(1, 2, "Central Plaza entrance closes at night");

    const corpus = buildRepetitionPatternCorpus({
      documentManager,
      chapters: [{ id: 1, filePath: "sources\\chapter-1.txt" }],
    });
    const result = new RepetitionPatternAnalyzer().analyze(corpus, {
      minOccurrences: 3,
      minLength: 8,
    });

    expect(corpus.entries.map((entry) => entry.globalStartIndex)).toEqual([0, 13, 26]);
    expect(result.totalSentenceCount).toBe(3);
    expect(result.patterns[0]).toMatchObject({
      text: "王都中央广场入口",
      occurrenceCount: 3,
      isTranslationConsistent: false,
    });
    expect(result.patterns[0]?.locations.map((location) => location.unitIndex)).toEqual([
      0, 1, 2,
    ]);
    expect(result.patterns[0]?.locations.map((location) => location.matchStartInSentence)).toEqual([
      0, 0, 0,
    ]);
    expect(result.patterns[0]?.translations.map((variant) => ({
      text: variant.text,
      count: variant.count,
    }))).toEqual([
      { text: "Central Plaza entrance closes at night", count: 1 },
      { text: "Royal Plaza entrance has a queue", count: 1 },
      { text: "Royal Plaza entrance opens today", count: 1 },
    ]);
  });
});
