import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddingClient } from "../llm/base.ts";
import type { LlmClientConfig } from "../llm/types.ts";
import { ContextIndexBuilder, PrebuiltContextRetriever } from "./context-index.ts";
import { TranslationProject } from "./translation-project.ts";

class FakeEmbeddingClient extends EmbeddingClient {
  constructor(config: LlmClientConfig) {
    super(config);
  }

  override async getEmbedding(text: string): Promise<number[]> {
    const base = text.includes("Hello") ? [1, 0] : [0, 1];
    return base;
  }

  override async getEmbeddings(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.getEmbedding(text)));
  }
}

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
      topology: {
        routes: [
          {
            name: "main",
            chapters: [
              { id: 1, filePath: "sources\\chapter-1.txt" },
              { id: 2, filePath: "sources\\chapter-2.txt" },
            ],
          },
        ],
        links: [{ fromChapter: 0, toRoute: "main" }],
      },
      context: {
        includeEarlierFragments: 2,
        includeEarlierChapters: true,
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

  test("builds and reuses semantic context indexes", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-context-"));
    cleanupTargets.push(workspaceDir);

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "chapter-1.txt"), "Hello there\n", "utf8");
    await writeFile(join(sourceDir, "chapter-2.txt"), "Hello again\n", "utf8");

    const project = new TranslationProject({
      projectName: "semantic",
      projectDir: workspaceDir,
      topology: {
        routes: [
          {
            name: "main",
            chapters: [
              { id: 1, filePath: "sources\\chapter-1.txt" },
              { id: 2, filePath: "sources\\chapter-2.txt" },
            ],
          },
        ],
        links: [{ fromChapter: 0, toRoute: "main" }],
      },
    }, {
      textSplitter: {
        split(units) {
          return units.map((unit) => [unit]);
        },
      },
    });
    await project.initialize();

    await project.submitResult({
      chapterId: 1,
      fragmentIndex: 0,
      translatedText: "你好，那里",
    });

    const builder = new ContextIndexBuilder(
      new FakeEmbeddingClient({
        provider: "openai",
        modelName: "fake-embedding",
        apiKey: "fake",
        endpoint: "https://example.com",
        modelType: "embedding",
        retries: 1,
      }),
    );

    const index = await builder.buildIndex(
      project.getDocumentManager(),
      project.getTopology(),
    );

    const retriever = new PrebuiltContextRetriever({
      indexData: index,
      retrieveK: 1,
    });
    await retriever.load();

    const semanticProject = new TranslationProject(
      {
        projectName: "semantic",
        projectDir: workspaceDir,
        topology: {
          routes: [
            {
              name: "main",
              chapters: [
                { id: 1, filePath: "sources\\chapter-1.txt" },
                { id: 2, filePath: "sources\\chapter-2.txt" },
              ],
            },
          ],
          links: [{ fromChapter: 0, toRoute: "main" }],
        },
      },
      {
        contextRetriever: retriever,
        textSplitter: {
          split(units) {
            return units.map((unit) => [unit]);
          },
        },
      },
    );
    await semanticProject.initialize();

    const task = await semanticProject.buildTask(2, 0);
    expect(
      task.contextView
        .getContexts()
        .some((context) => context.type === "semanticSimilar"),
    ).toBe(true);
  });
});
