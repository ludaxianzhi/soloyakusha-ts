import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlainTextFileHandler } from "../file-handlers/plain-text-file-handler.ts";
import {
  SlidingWindowTextSplitter,
  TranslationDocumentManager,
} from "./translation-document-manager.ts";

const cleanupTargets: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupTargets.splice(0, cleanupTargets.length).map((target) =>
      rm(target, { recursive: true, force: true }),
    ),
  );
});

describe("SlidingWindowTextSplitter", () => {
  test("splits text with source-length based overlaps", () => {
    const splitter = new SlidingWindowTextSplitter(8, 4);
    const fragments = splitter.split([
      { source: "aaaa", target: [] },
      { source: "bbbb", target: [] },
      { source: "cccc", target: [] },
      { source: "dddd", target: [] },
    ]);

    expect(fragments.map((fragment) => fragment.units.map((unit) => unit.source))).toEqual([
      ["aaaa", "bbbb"],
      ["bbbb", "cccc"],
      ["cccc", "dddd"],
    ]);
    expect(fragments.map((fragment) => fragment.originalUnitIndexes)).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    expect(fragments.map((fragment) => [
      fragment.windowStartUnitIndex,
      fragment.windowEndUnitIndex,
    ])).toEqual([
      [0, 2],
      [1, 3],
      [2, 4],
    ]);
  });
});

describe("TranslationDocumentManager sliding window export", () => {
  test("merges overlapping fragment translations back to the original unit order", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-window-"));
    cleanupTargets.push(workspaceDir);

    const sourcePath = join(workspaceDir, "chapter.txt");
    await writeFile(sourcePath, "aaaa\nbbbb\ncccc\ndddd\n", "utf8");

    const manager = new TranslationDocumentManager(workspaceDir, {
      textSplitter: new SlidingWindowTextSplitter(8, 4),
    });
    await manager.loadChapters([{ chapterId: 1, filePath: sourcePath }]);

    const chapter = manager.getChapterById(1);
    expect(chapter?.fragments).toHaveLength(3);
    expect(chapter?.fragments.map((fragment) => fragment.meta?.originalUnitIndexes)).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);

    const persistedPath = join(workspaceDir, "Data", "Chapters", "1.json");
    const persisted = JSON.parse(await readFile(persistedPath, "utf8")) as {
      fragments: Array<{
        meta?: {
          originalUnitIndexes?: number[];
          windowStartUnitIndex?: number;
          windowEndUnitIndex?: number;
        };
      }>;
    };
    expect(persisted.fragments.map((fragment) => fragment.meta?.originalUnitIndexes)).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    expect(persisted.fragments.map((fragment) => [
      fragment.meta?.windowStartUnitIndex,
      fragment.meta?.windowEndUnitIndex,
    ])).toEqual([
      [0, 2],
      [1, 3],
      [2, 4],
    ]);

    await manager.updateTranslation(1, 0, ["A1", "B1"]);
    await manager.updateTranslation(1, 1, ["B2", "C2"]);
    await manager.updateTranslation(1, 2, ["C3", "D3"]);

    expect(manager.getChapterSourceText(1)).toBe("aaaa\nbbbb\ncccc\ndddd");
    expect(manager.getChapterTranslatedText(1)).toBe("A1\nB1\nC2\nD3");

    const mergedUnits = manager.getChapterTranslationUnits(1);
    expect(mergedUnits.map((unit) => unit.source)).toEqual([
      "aaaa",
      "bbbb",
      "cccc",
      "dddd",
    ]);
    expect(mergedUnits.map((unit) => unit.target.at(-1) ?? "")).toEqual([
      "A1",
      "B1",
      "C2",
      "D3",
    ]);

    const reloadedManager = new TranslationDocumentManager(workspaceDir);
    await reloadedManager.loadChapters([{ chapterId: 1, filePath: sourcePath }]);

    const exportPath = join(workspaceDir, "merged.txt");
    await reloadedManager.exportChapter(1, exportPath, new PlainTextFileHandler());

    expect(await readFile(exportPath, "utf8")).toBe("A1\nB1\nC2\nD3\n");
    expect(reloadedManager.getChapterTranslationUnits(1)).toHaveLength(4);
  });
});
