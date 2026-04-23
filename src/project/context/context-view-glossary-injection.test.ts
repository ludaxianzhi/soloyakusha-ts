import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glossary } from "../../glossary/glossary.ts";
import { TranslationProject } from "../pipeline/translation-project.ts";

const cleanupTargets: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupTargets.splice(0, cleanupTargets.length).map((target) =>
      rm(target, { recursive: true, force: true }),
    ),
  );
});

describe("TranslationContextView glossary injection", () => {
  test("uses cascading glossary matching with longest-match preference in prompt injection", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-context-injection-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "勇者来到王都\n", "utf8");

    const glossary = new Glossary([
      { term: "勇者", translation: "Hero", description: "尊称：陛下" },
      { term: "陛下", translation: "Your Majesty" },
      { term: "王都", translation: "Royal Capital" },
      { term: "王", translation: "King" },
    ]);

    const project = new TranslationProject(
      {
        projectName: "context-injection",
        projectDir: workspaceDir,
        chapters: [{ id: 1, filePath: "sources/chapter-1.txt" }],
        glossary: {
          path: "glossary.csv",
          autoFilter: true,
        },
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
    const tasks = await project.getWorkQueue("translation").dispatchReadyItems();
    const glossaryContext = tasks[0]?.contextView?.getContext("glossary");

    expect(glossaryContext?.type).toBe("glossary");
    if (glossaryContext?.type !== "glossary") {
      return;
    }

    const lines = glossaryContext.content.split(/\r?\n/);
    expect(lines.some((line) => line.startsWith("勇者,"))).toBe(true);
    expect(lines.some((line) => line.startsWith("陛下,"))).toBe(true);
    expect(lines.some((line) => line.startsWith("王都,"))).toBe(true);
    expect(lines.some((line) => line.startsWith("王,"))).toBe(false);
  });
});
