import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glossary } from "../../glossary/glossary.ts";
import {
  buildChapterTranslationEditorUnits,
  createChapterTranslationEditorDocument,
  validateChapterTranslationEditorContent,
} from "./chapter-translation-editor.ts";
import type { ChapterEntry } from "../types.ts";
import { TranslationProject } from "../pipeline/translation-project.ts";

const cleanupTargets: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupTargets.splice(0, cleanupTargets.length).map((target) =>
      rm(target, { recursive: true, force: true }),
    ),
  );
});

describe("chapter translation editor", () => {
  test("keeps untranslated units roundtrippable in naturedialog drafts", () => {
    const chapter = createChapterEntryForTest({
      id: 1,
      filePath: "chapter-1.txt",
      lines: ["【爱丽丝】你好", "旁白"],
      translations: ["", ""],
    });

    const draft = createChapterTranslationEditorDocument({
      chapterId: 1,
      format: "naturedialog",
      units: buildChapterTranslationEditorUnits(chapter),
      glossaryTerms: [
        { term: "爱丽丝", translation: "Alice" },
        { term: "旁白", translation: "Narration" },
      ],
    });

    expect(draft.content).toContain("● ");
    expect(draft.baseline.unitCount).toBe(2);
    expect(draft.glossaryMatches.some((match) => match.term === "爱丽丝")).toBe(true);

    const validation = validateChapterTranslationEditorContent({
      baseline: draft.baseline,
      units: draft.units,
      content: draft.content,
    });

    expect(validation.canApply).toBe(true);
    expect(validation.parsedUnitCount).toBe(2);
    expect(validation.updates.map((update) => update.nextText)).toEqual(["", ""]);
  });

  test("rejects source edits and missing units during validation", () => {
    const chapter = createChapterEntryForTest({
      id: 1,
      filePath: "chapter-1.txt",
      lines: ["第一句", "第二句"],
      translations: ["译文一", "译文二"],
    });
    const draft = createChapterTranslationEditorDocument({
      chapterId: 1,
      format: "naturedialog",
      units: buildChapterTranslationEditorUnits(chapter),
    });

    const editedSource = draft.content.replace("○ 第一句", "○ 被改掉的原文");
    const sourceValidation = validateChapterTranslationEditorContent({
      baseline: draft.baseline,
      units: draft.units,
      content: editedSource,
    });
    expect(sourceValidation.canApply).toBe(false);
    expect(sourceValidation.diagnostics.some((diagnostic) => diagnostic.code === "source-mismatch")).toBe(
      true,
    );

    const removedUnit = draft.content.replace("\n○ 第二句\n● 译文二\n", "\n");
    const countValidation = validateChapterTranslationEditorContent({
      baseline: draft.baseline,
      units: draft.units,
      content: removedUnit,
    });
    expect(countValidation.canApply).toBe(false);
    expect(
      countValidation.diagnostics.some((diagnostic) => diagnostic.code === "unit-count-mismatch"),
    ).toBe(true);
  });

  test("applies validated m3t editor content back to project translations", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-editor-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "【爱丽丝】你好\n旁白\n", "utf8");

    const project = new TranslationProject(
      {
        projectName: "editor-demo",
        projectDir: workspaceDir,
        chapters: [{ id: 1, filePath: "sources\\chapter-1.txt" }],
      },
      {
        glossary: new Glossary([{ term: "爱丽丝", translation: "Alice" }]),
        textSplitter: {
          split(units) {
            return units.map((unit) => [unit]);
          },
        },
      },
    );
    await project.initialize();

    const draft = project.getChapterTranslationEditorDocument(1, "m3t");
    const edited = draft.content
      .replace("● \n\n○ 旁白", "● Hello\n\n○ 旁白")
      .replace(/● \n\s*$/, "● Narration\n");

    const result = await project.applyChapterTranslationEditorContent(1, "m3t", edited);
    expect(result.canApply).toBe(true);
    expect(result.updates.filter((update) => update.changed)).toHaveLength(2);

    const preview = project.getChapterTranslationPreview(1);
    expect(preview.units.map((unit) => unit.translatedText)).toEqual(["【爱丽丝】Hello", "Narration"]);
  });

  test("editor draft prefers latest fragment translation over imported target groups", () => {
    const chapter = createChapterEntryForTest({
      id: 1,
      filePath: "chapter-1.txt",
      lines: ["第一句"],
      translations: ["校对后的新译文"],
    });
    chapter.fragments[0]!.meta!.targetGroups = [["导入时旧译文"]];

    const draft = createChapterTranslationEditorDocument({
      chapterId: 1,
      format: "m3t",
      units: buildChapterTranslationEditorUnits(chapter),
    });

    expect(draft.units[0]?.translatedText).toBe("校对后的新译文");
    expect(draft.units[0]?.targetCandidates).toEqual(["校对后的新译文"]);
    expect(draft.content).toContain("校对后的新译文");
    expect(draft.content).not.toContain("导入时旧译文");
  });
});

function createChapterEntryForTest(input: {
  id: number;
  filePath: string;
  lines: string[];
  translations: string[];
}): ChapterEntry {
  return {
    id: input.id,
    filePath: input.filePath,
    fragments: [
      {
        source: { lines: [...input.lines] },
        translation: { lines: [...input.translations] },
        pipelineStates: {},
        meta: {
          metadataList: input.lines.map(() => null),
          targetGroups: input.translations.map((translation) => (translation ? [translation] : [])),
        },
        hash: "test-hash",
      },
    ],
  };
}
