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

  test("reloads persisted fragments from SQLite workspace storage", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-window-reload-"));
    cleanupTargets.push(workspaceDir);

    const sourcePath = join(workspaceDir, "chapter.txt");
    await writeFile(sourcePath, "aaaa\nbbbb\ncccc\ndddd\n", "utf8");

    const manager = new TranslationDocumentManager(workspaceDir, {
      textSplitter: new DefaultTextSplitter(4),
    });
    await manager.loadChapters([{ chapterId: 1, filePath: sourcePath }]);
    await manager.updateTranslation(1, 0, ["A1"]);
    await manager.updateTranslation(1, 1, ["B1"]);
    await manager.updateTranslation(1, 2, ["C2"]);
    await manager.updateTranslation(1, 3, ["D3"]);

    const reloadedManager = new TranslationDocumentManager(workspaceDir, {
      textSplitter: new DefaultTextSplitter(4),
    });
    await reloadedManager.loadChapters([{ chapterId: 1, filePath: sourcePath }]);

    expect(reloadedManager.getChapterTranslatedText(1)).toBe("A1\nB1\nC2\nD3");
    expect(reloadedManager.getChapterById(1)?.fragments).toHaveLength(4);
  });
});
