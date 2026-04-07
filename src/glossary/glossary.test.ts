import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FullTextGlossaryScanner } from "./scanner.ts";
import { Glossary } from "./glossary.ts";
import { GlossaryPersisterFactory } from "./persister.ts";
import { DefaultGlossaryUpdater } from "./updater.ts";
import { ChatClient } from "../llm/base.ts";
import type { ChatRequestOptions, LlmClientConfig } from "../llm/types.ts";
import { TranslationDocumentManager } from "../project/translation-document-manager.ts";
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

  test("tracks term status and occurrence stats by text block", () => {
    const glossary = new Glossary([
      { term: "勇者", translation: "" },
      { term: "陛下", translation: "Your Majesty" },
    ]);

    glossary.updateOccurrenceStats([
      { blockId: "block-1", text: "勇者来了，勇者出发了" },
      { blockId: "block-1", text: "勇者必须胜利" },
      { blockId: "block-2", text: "陛下召见勇者" },
    ]);

    expect(glossary.getTerm("勇者")).toMatchObject({
      status: "untranslated",
      totalOccurrenceCount: 4,
      textBlockOccurrenceCount: 2,
    });
    expect(glossary.getTerm("陛下")).toMatchObject({
      status: "translated",
      totalOccurrenceCount: 1,
      textBlockOccurrenceCount: 1,
    });
  });

  test("supports on-demand translated term lookup and incremental updates", () => {
    const glossary = new Glossary([
      { term: "勇者", translation: "Hero" },
      { term: "王都", translation: "" },
      { term: "魔王", translation: "Demon Lord" },
    ]);

    expect(glossary.getTranslatedTermsForText("勇者来到王都")).toMatchObject([
      { term: "勇者", translation: "Hero", status: "translated" },
    ]);
    expect(glossary.getUntranslatedTermsForText("勇者来到王都")).toMatchObject([
      { term: "王都", translation: "", status: "untranslated" },
    ]);

    glossary.applyTranslations([{ term: "王都", translation: "Royal Capital" }]);

    expect(glossary.getTerm("王都")).toMatchObject({
      translation: "Royal Capital",
      status: "translated",
    });
  });

  test("updates glossary translations via dedicated updater request", async () => {
    const glossary = new Glossary([
      { term: "勇者", translation: "Hero" },
      { term: "王都", translation: "", description: "城市名" },
    ]);
    const client = new FakeChatClient([
      JSON.stringify({
        glossaryUpdates: [{ term: "王都", translation: "Royal Capital" }],
      }),
    ]);
    const updater = new DefaultGlossaryUpdater(client);

    const result = await updater.updateGlossary({
      glossary,
      untranslatedTerms: glossary.getUntranslatedTermsForText("勇者来到王都"),
      translationUnits: [
        {
          id: "1",
          sourceText: "勇者来到王都",
          translatedText: "Hero arrived at the Royal Capital",
        },
      ],
      requirements: ["保持术语一致"],
    });

    expect(result.updates).toEqual([{ term: "王都", translation: "Royal Capital" }]);
    expect(result.appliedTerms[0]).toMatchObject({
      term: "王都",
      translation: "Royal Capital",
      status: "translated",
    });
    expect(glossary.getTerm("王都")).toMatchObject({
      translation: "Royal Capital",
      status: "translated",
    });
    expect(client.requests[0]?.prompt).toContain("translatedText: Hero arrived at the Royal Capital");
    expect(client.requests[0]?.prompt).toContain("term: 王都");
  });

  test("persists extended glossary fields as csv", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-glossary-"));
    cleanupTargets.push(workspaceDir);

    const filePath = join(workspaceDir, "glossary.csv");
    const glossary = new Glossary([
      {
        term: "王都",
        translation: "Royal Capital",
        category: "placeName",
        totalOccurrenceCount: 3,
        textBlockOccurrenceCount: 2,
        description: "主要城市",
      },
    ]);

    const persister = GlossaryPersisterFactory.getPersister(filePath);
    await persister.saveGlossary(glossary, filePath);
    const loaded = await persister.loadGlossary(filePath);

    expect(loaded.getAllTerms()).toEqual(glossary.getAllTerms());
  });

  test("loads legacy csv and infers default status values", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-glossary-legacy-"));
    cleanupTargets.push(workspaceDir);

    const filePath = join(workspaceDir, "glossary.csv");
    await writeFile(
      filePath,
      "term,translation,description\n勇者,Hero,主角职业\n口癖,,角色固定说法\n",
      "utf8",
    );

    const glossary = await GlossaryPersisterFactory.getPersister(filePath).loadGlossary(filePath);

    expect(glossary.getTerm("勇者")).toMatchObject({
      status: "translated",
      totalOccurrenceCount: 0,
      textBlockOccurrenceCount: 0,
    });
    expect(glossary.getTerm("口癖")).toMatchObject({
      status: "untranslated",
      totalOccurrenceCount: 0,
      textBlockOccurrenceCount: 0,
    });
  });

  test("integrates glossary into context view", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-project-glossary-"));
    cleanupTargets.push(workspaceDir);

    const glossaryPath = join(workspaceDir, "glossary.csv");
    await writeFile(
      glossaryPath,
      "term,translation,status,description\n勇者,Hero,translated,主角职业\n王都,,untranslated,城市名\n",
      "utf8",
    );

    const sourceDir = join(workspaceDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    await Bun.write(join(sourceDir, "chapter-1.txt"), "勇者出发了\n");

    const project = new TranslationProject(
      {
        projectName: "demo",
        projectDir: workspaceDir,
        chapters: [{ id: 1, filePath: "sources\\chapter-1.txt" }],
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
    await project.startTranslation();
    const tasks = await project.getWorkQueue("translation").dispatchReadyItems();
    const glossaryContext = tasks[0]?.contextView?.getContext("glossary");

    expect(glossaryContext?.type).toBe("glossary");
    if (glossaryContext?.type === "glossary") {
      expect(glossaryContext.content).toContain("Hero");
      expect(glossaryContext.content).not.toContain("王都");
    }

    expect(await readFile(glossaryPath, "utf8")).toContain("勇者");
  });

  test("scans full text lines with large batches and formats grouped output", async () => {
    const client = new FakeChatClient([
      '{"entities":[{"term":"勇者","category":"personName"},{"term":"陛下","category":"personTitle"}]}',
      '{"entities":[{"term":"勇者","category":"personName"}]}',
    ]);
    const scanner = new FullTextGlossaryScanner(client);

    const result = await scanner.scanLines(
      [
        { lineNumber: 1, text: "勇者来了", blockId: "block-1" },
        { lineNumber: 2, text: "陛下召见勇者", blockId: "block-2" },
        { lineNumber: 3, text: "勇者说勇者必胜", blockId: "block-2" },
      ],
      { maxCharsPerBatch: 15 },
    );

    expect(result.batches).toHaveLength(2);
    expect(client.requests[0]?.prompt).toContain("L00001: 勇者来了");
    expect(client.requests[1]?.prompt).toContain("L00003: 勇者说勇者必胜");
    expect(client.requests[0]?.options?.requestConfig?.systemPrompt).toContain("术语扫描器");
    expect(client.requests[0]?.options?.requestConfig?.systemPrompt).toContain("只返回 term 和 category 两个字段");
    expect(client.requests[0]?.options?.requestConfig?.systemPrompt).not.toContain("description");
    expect(result.glossary.getTerm("勇者")).toMatchObject({
      category: "personName",
      status: "untranslated",
      totalOccurrenceCount: 4,
      textBlockOccurrenceCount: 2,
    });
    // 陛下 只出现在一个文本块中，应被过滤
    expect(result.glossary.getTerm("陛下")).toBeUndefined();

    const formatted = scanner.formatResult(result);
    expect(formatted).toContain("[人名]");
    expect(formatted).not.toContain("[人物称呼]");
    expect(formatted).toContain("总出现: 4");
  });

  test("scans document manager as a continuous full text line stream", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-fulltext-scanner-"));
    cleanupTargets.push(workspaceDir);

    const sourcePath = join(workspaceDir, "chapter-1.txt");
    await writeFile(sourcePath, "第一行\n第二行\n第三行\n", "utf8");

    const documentManager = new TranslationDocumentManager(workspaceDir, {
      textSplitter: {
        split(units) {
          return units.map((unit) => [unit]);
        },
      },
    });
    await documentManager.loadChapters([{ chapterId: 1, filePath: sourcePath }]);

    const client = new FakeChatClient(['{"entities":[{"term":"第一行","category":"properNoun"}]}']);
    const scanner = new FullTextGlossaryScanner(client);
    const result = await scanner.scanDocumentManager(documentManager, {
      maxCharsPerBatch: 100,
    });

    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]?.lines).toHaveLength(3);
    expect(client.requests[0]?.prompt).toContain("L00001: 第一行");
    expect(client.requests[0]?.prompt).toContain("L00003: 第三行");
    expect(client.requests[0]?.options?.requestConfig?.systemPrompt).toContain("严格 JSON");
  });

  test("applies occurrence top-k and top-p filtering after base scan filtering", async () => {
    const client = new FakeChatClient([
      JSON.stringify({
        entities: [
          { term: "勇者", category: "personName" },
          { term: "王都", category: "placeName" },
          { term: "公爵", category: "personTitle" },
          { term: "圣剑", category: "properNoun" },
        ],
      }),
    ]);
    const scanner = new FullTextGlossaryScanner(client);

    const result = await scanner.scanLines(
      [
        { lineNumber: 1, text: "勇者 勇者 勇者 王都 公爵 圣剑", blockId: "block-1" },
        { lineNumber: 2, text: "勇者 勇者 王都 王都 公爵 圣剑", blockId: "block-2" },
        { lineNumber: 3, text: "勇者 王都 公爵 公爵", blockId: "block-3" },
        { lineNumber: 4, text: "王都 公爵 公爵", blockId: "block-4" },
      ],
      {
        maxCharsPerBatch: 200,
        occurrenceTopK: 3,
        occurrenceTopP: 0.5,
      },
    );

    // 公爵和王都各出现在 4 个文本块中，文本块数最高，应被保留
    expect(result.glossary.getTerm("公爵")).toMatchObject({
      totalOccurrenceCount: 6,
      textBlockOccurrenceCount: 4,
    });
    expect(result.glossary.getTerm("王都")).toMatchObject({
      totalOccurrenceCount: 5,
      textBlockOccurrenceCount: 4,
    });
    // 勇者文本块数较少（3），被裁剪掉
    expect(result.glossary.getTerm("勇者")).toBeUndefined();
    expect(result.glossary.getTerm("圣剑")).toBeUndefined();
    expect(result.glossary.getAllTerms()).toHaveLength(2);
  });
});

class FakeChatClient extends ChatClient {
  readonly requests: Array<{ prompt: string; options?: ChatRequestOptions }> = [];
  private readonly responses: string[];

  constructor(responses: string[]) {
    super(createFakeChatConfig());
    this.responses = [...responses];
  }

  override async singleTurnRequest(
    prompt: string,
    options?: ChatRequestOptions,
  ): Promise<string> {
    this.requests.push({ prompt, options });
    return this.responses.shift() ?? '{"entities":[]}';
  }
}

function createFakeChatConfig(): LlmClientConfig {
  return {
    provider: "openai",
    modelName: "fake-model",
    apiKey: "test-key",
    endpoint: "https://example.com",
    modelType: "chat",
    retries: 0,
  };
}
