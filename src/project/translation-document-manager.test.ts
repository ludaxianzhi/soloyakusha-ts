import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlainTextFileHandler } from "../file-handlers/plain-text-file-handler.ts";
import {
  DefaultTextSplitter,
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

describe("TranslationDocumentManager sliding window views", () => {
  test("derives chapter-bounded sliding windows from base fragments and backfills only the focus fragment", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-window-"));
    cleanupTargets.push(workspaceDir);

    const sourcePath = join(workspaceDir, "chapter.txt");
    await writeFile(sourcePath, "aaaa\nbbbb\ncccc\ndddd\n", "utf8");

    const manager = new TranslationDocumentManager(workspaceDir, {
      textSplitter: new DefaultTextSplitter(4),
    });
    await manager.loadChapters([{ chapterId: 1, filePath: sourcePath }]);

    const windows = manager.getChapterSlidingWindowFragments(1, { overlapChars: 4 });
    expect(windows.map((window) => window.source.lines)).toEqual([
      ["aaaa", "bbbb"],
      ["aaaa", "bbbb", "cccc"],
      ["bbbb", "cccc", "dddd"],
      ["cccc", "dddd"],
    ]);
    expect(windows.map((window) => [window.focusLineStart, window.focusLineEnd])).toEqual([
      [0, 1],
      [1, 2],
      [1, 2],
      [1, 2],
    ]);
    expect(windows[1]?.lines.map((line) => [line.fragmentIndex, line.lineIndex])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);

    await manager.updateSlidingWindowTranslation(windows[0]!, ["A1", "B_ctx"]);
    await manager.updateSlidingWindowTranslation(windows[1]!, ["A_ctx", "B1", "C_ctx"]);
    await manager.updateSlidingWindowTranslation(windows[2]!, ["B_ctx", "C1", "D_ctx"]);
    await manager.updateSlidingWindowTranslation(windows[3]!, ["C_ctx", "D1"]);

    expect(manager.getChapterSourceText(1)).toBe("aaaa\nbbbb\ncccc\ndddd");
    expect(manager.getChapterTranslatedText(1)).toBe("A1\nB1\nC1\nD1");

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
      "C1",
      "D1",
    ]);

    const reloadedManager = new TranslationDocumentManager(workspaceDir);
    await reloadedManager.loadChapters([{ chapterId: 1, filePath: sourcePath }]);

    const exportPath = join(workspaceDir, "merged.txt");
    await reloadedManager.exportChapter(1, exportPath, new PlainTextFileHandler());

    expect(await readFile(exportPath, "utf8")).toBe("A1\nB1\nC1\nD1\n");
    expect(reloadedManager.getChapterTranslationUnits(1)).toHaveLength(4);
  });

  test("upgrades legacy sliding-window chapter files to base fragments without persisting window metadata", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-window-upgrade-"));
    cleanupTargets.push(workspaceDir);

    const sourcePath = join(workspaceDir, "chapter.txt");
    await writeFile(sourcePath, "aaaa\nbbbb\ncccc\ndddd\n", "utf8");

    const chapterDataPath = join(workspaceDir, "Data", "Chapters", "1.json");
    await mkdir(join(workspaceDir, "Data", "Chapters"), { recursive: true });
    await writeFile(
      chapterDataPath,
      JSON.stringify(
        {
          id: 1,
          filePath: sourcePath,
          fragments: [
            {
              source: { lines: ["aaaa", "bbbb"] },
              translation: { lines: ["A1", "B1"] },
              pipelineStates: {},
              meta: {
                metadataList: [null, null],
                targetGroups: [[], []],
                originalUnitIndexes: [0, 1],
                windowStartUnitIndex: 0,
                windowEndUnitIndex: 2,
              },
              hash: "legacy-0",
            },
            {
              source: { lines: ["bbbb", "cccc"] },
              translation: { lines: ["B2", "C2"] },
              pipelineStates: {},
              meta: {
                metadataList: [null, null],
                targetGroups: [[], []],
                originalUnitIndexes: [1, 2],
                windowStartUnitIndex: 1,
                windowEndUnitIndex: 3,
              },
              hash: "legacy-1",
            },
            {
              source: { lines: ["cccc", "dddd"] },
              translation: { lines: ["C3", "D3"] },
              pipelineStates: {},
              meta: {
                metadataList: [null, null],
                targetGroups: [[], []],
                originalUnitIndexes: [2, 3],
                windowStartUnitIndex: 2,
                windowEndUnitIndex: 4,
              },
              hash: "legacy-2",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const manager = new TranslationDocumentManager(workspaceDir, {
      textSplitter: new DefaultTextSplitter(4),
    });
    await manager.loadChapters([{ chapterId: 1, filePath: sourcePath }]);

    expect(manager.getChapterTranslatedText(1)).toBe("A1\nB1\nC2\nD3");
    expect(manager.getChapterById(1)?.fragments).toHaveLength(4);

    const persisted = JSON.parse(await readFile(chapterDataPath, "utf8")) as {
      fragments: Array<{
        meta?: {
          metadataList?: unknown[];
          targetGroups?: string[][];
          originalUnitIndexes?: number[];
          windowStartUnitIndex?: number;
          windowEndUnitIndex?: number;
        };
      }>;
    };
    expect(
      persisted.fragments.every(
        (fragment) =>
          fragment.meta?.originalUnitIndexes === undefined &&
          fragment.meta?.windowStartUnitIndex === undefined &&
          fragment.meta?.windowEndUnitIndex === undefined,
      ),
    ).toBe(true);
  });
});
