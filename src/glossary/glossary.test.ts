import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glossary } from "./glossary.ts";
import { GlossaryPersisterFactory } from "./persister.ts";
import { TranslationProject } from "../project/translation-project.ts";

const cleanupTargets: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupTargets.splice(0, cleanupTargets.length).map((target) =>
      rm(target, { recursive: true, force: true }),
    ),
  );
});

describe("glossary", () => {
  test("filters and renders glossary terms as csv", () => {
    const glossary = new Glossary([
      { term: "勇者", translation: "Hero", description: "主角职业" },
      { term: "魔王", translation: "Demon Lord" },
    ]);

    const filtered = glossary.filterTerms("勇者打败了敌人");
    expect(filtered).toHaveLength(1);
    expect(glossary.filterAndRenderAsCsv("勇者打败了敌人")).toContain("Hero");
  });

  test("persists glossary as yaml", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-glossary-"));
    cleanupTargets.push(workspaceDir);

    const filePath = join(workspaceDir, "glossary.yaml");
    const glossary = new Glossary([
      { term: "勇者", translation: "Hero", description: "主角职业" },
    ]);

    const persister = GlossaryPersisterFactory.getPersister(filePath);
    await persister.saveGlossary(glossary, filePath);
    const loaded = await persister.loadGlossary(filePath);

    expect(loaded.getAllTerms()).toEqual(glossary.getAllTerms());
  });

  test("integrates glossary into context view", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-project-glossary-"));
    cleanupTargets.push(workspaceDir);

    const glossaryPath = join(workspaceDir, "glossary.csv");
    await writeFile(
      glossaryPath,
      "term,translation,description\n勇者,Hero,主角职业\n",
      "utf8",
    );

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await Bun.write(join(sourceDir, "chapter-1.txt"), "勇者出发了\n");

    const project = new TranslationProject(
      {
        projectName: "demo",
        projectDir: workspaceDir,
        topology: {
          routes: [
            {
              name: "main",
              chapters: [{ id: 1, filePath: "sources\\chapter-1.txt" }],
            },
          ],
          links: [{ fromChapter: 0, toRoute: "main" }],
        },
        glossary: {
          path: "glossary.csv",
          autoFilter: true,
        },
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
    const task = await project.getNextTask();
    const glossaryContext = task?.contextView.getContext("glossary");

    expect(glossaryContext?.type).toBe("glossary");
    if (glossaryContext?.type === "glossary") {
      expect(glossaryContext.content).toContain("Hero");
    }

    expect(await readFile(glossaryPath, "utf8")).toContain("勇者");
  });
});
