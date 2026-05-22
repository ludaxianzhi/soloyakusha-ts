import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepSourceNameInTarget } from "./base.ts";
import { TranslationFileHandlerFactory } from "./factory.ts";
import { DblTp1FileHandler } from "./dbl-tp1-file-handler.ts";
import { DblTp2FileHandler } from "./dbl-tp2-file-handler.ts";
import { VntJsonFileHandler } from "./vnt-json-file-handler.ts";
import { NdWithMetaFileHandler } from "./nd-with-meta-file-handler.ts";
import { NatureDialogFileHandler } from "./nature-dialog-file-handler.ts";
import { TranslationDocumentManager } from "../project/document/translation-document-manager.ts";

const cleanupTargets: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupTargets.splice(0, cleanupTargets.length).map((target) =>
      rm(target, { recursive: true, force: true }),
    ),
  );
});

describe("file handlers", () => {
  test("reads and writes vnt json format", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-galjson-"));
    cleanupTargets.push(workspaceDir);

    const filePath = join(workspaceDir, "scene.json");
    await writeFile(
      filePath,
      JSON.stringify(
        [
          { message: "旁白" },
          { name: "Alice", message: "你好" },
        ],
        null,
        2,
      ),
      "utf8",
    );

    const handler = new VntJsonFileHandler();
    const units = await handler.readTranslationUnits(filePath);
    expect(units[0]).toEqual({ source: "旁白", target: [] });
    expect(units[1]).toEqual({ source: "【Alice】你好", target: [] });

    await handler.writeTranslationUnits(filePath, [
      { source: "旁白", target: ["Narration"] },
      { source: "【Alice】你好", target: ["【Alice】Hello"] },
    ]);

    const written = JSON.parse(await readFile(filePath, "utf8")) as Array<Record<string, string>>;
    expect(written[0]).toEqual({ message: "Narration" });
    expect(written[1]).toEqual({ name: "Alice", message: "Hello" });
  });

  test("escapes embedded line breaks when reading vnt json", async () => {
    const handler = new VntJsonFileHandler();

    const parsed = handler.parseTranslationDocument(
      JSON.stringify([
        { message: "第一行\n第二行" },
      ]),
    );

    expect(parsed.units).toEqual([
      { source: "第一行\\n第二行", target: [] },
    ]);
  });

  test("round-trips blank nature dialog units as empty output", async () => {
    const handler = new NatureDialogFileHandler();

    const parsed = handler.parseTranslationDocument("○ \n\n");
    expect(parsed.units).toEqual([
      { source: "<blank/>", target: ["<blank/>"], metadata: null },
    ]);

    expect(handler.formatTranslationUnits(parsed.units)).toBe("○ \n● \n");
  });

  test("keeps source names in nature dialog keepname format", async () => {
    const handler = new NatureDialogFileHandler();
    handler.applyParams({ keepSourceName: true });
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-keepname-"));
    cleanupTargets.push(workspaceDir);

    const filePath = join(workspaceDir, "dialog.txt");
    await handler.writeTranslationUnits(filePath, [
      {
        source: "【未翻译名】「こんにちは」",
        target: ["【Alice】Hello"],
      },
    ]);

    const content = await readFile(filePath, "utf8");
    expect(content).toContain("● 【未翻译名】Hello");
  });

  test("integrates handlers with translation document manager", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "soloyakusha-doc-handler-"));
    cleanupTargets.push(workspaceDir);

    const sourcePath = join(workspaceDir, "scene.json");
    await writeFile(
      sourcePath,
      JSON.stringify([{ name: "Alice", message: "你好" }], null, 2),
      "utf8",
    );

    const manager = new TranslationDocumentManager(workspaceDir, {
      textSplitter: {
        split(units) {
          return units.map((unit) => [unit]);
        },
      },
      fileHandlerResolver: TranslationFileHandlerFactory.createExtensionResolver({
        ".json": "vnt_json",
      }),
    });

    await manager.loadChapters([{ chapterId: 1, filePath: sourcePath }]);
    expect(manager.getSourceText(1, 0)).toBe("【Alice】你好");

    await manager.updateTranslation(1, 0, "【Alice】Hello");
    const exportPath = join(workspaceDir, "export.json");
    await manager.exportChapter(
      1,
      exportPath,
      TranslationFileHandlerFactory.getHandler("vnt_json"),
    );

    const exported = JSON.parse(await readFile(exportPath, "utf8")) as Array<Record<string, string>>;
    expect(exported[0]).toEqual({ name: "Alice", message: "Hello" });
  });

  describe("dbl_tp1 handler", () => {
    test("parses source and target lines without names", () => {
      const handler = new DblTp1FileHandler();
      const content =
        "☆00000004☆☆責める顔だ。\n" +
        "★00000004★★她的表情满是责备。\n" +
        "\n" +
        "☆00000005☆☆身に覚えなどないはずの。\n" +
        "★00000005★★这幅画面，宛如诅咒。\n";

      const parsed = handler.parseTranslationDocument(content);
      expect(parsed.units).toHaveLength(2);
      expect(parsed.units[0]).toEqual({
        source: "責める顔だ。",
        target: ["她的表情满是责备。"],
        metadata: "00000004",
      });
      expect(parsed.units[1]).toEqual({
        source: "身に覚えなどないはずの。",
        target: ["这幅画面，宛如诅咒。"],
        metadata: "00000005",
      });
    });

    test("parses source and target lines with names", () => {
      const handler = new DblTp1FileHandler();
      const content =
        "☆00000006☆トワ＠１☆「嫌いよ、あなたなんて……！」\n" +
        "★00000006★トワ＠１★「我讨厌你，最讨厌你了……！」\n" +
        "\n" +
        "☆00000007☆トワ＠１☆「……なんて」\n" +
        "★00000007★トワ＠１★「……了」\n";

      const parsed = handler.parseTranslationDocument(content);
      expect(parsed.units).toHaveLength(2);
      expect(parsed.units[0]).toEqual({
        source: "【トワ＠１】「嫌いよ、あなたなんて……！」",
        target: ["【トワ＠１】「我讨厌你，最讨厌你了……！」"],
        metadata: "00000006",
      });
      expect(parsed.units[1]).toEqual({
        source: "【トワ＠１】「……なんて」",
        target: ["【トワ＠１】「……了」"],
        metadata: "00000007",
      });
    });

    test("handles mixed name and no-name entries", () => {
      const handler = new DblTp1FileHandler();
      const content =
        "☆00000008☆☆胸が潰れてしまいそうな悲しみと、焦燥感。\n" +
        "★00000008★★悲伤涌来，心脏好像要被撕裂似的。\n" +
        "\n" +
        "☆00000009☆キャラ☆「こんにちは」\n" +
        "★00000009★キャラ★「你好」\n";

      const parsed = handler.parseTranslationDocument(content);
      expect(parsed.units).toHaveLength(2);
      expect(parsed.units[0]).toEqual({
        source: "胸が潰れてしまいそうな悲しみと、焦燥感。",
        target: ["悲伤涌来，心脏好像要被撕裂似的。"],
        metadata: "00000008",
      });
      expect(parsed.units[1]).toEqual({
        source: "【キャラ】「こんにちは」",
        target: ["【キャラ】「你好」"],
        metadata: "00000009",
      });
    });

    test("readers only the last target of multiple candidates", () => {
      const handler = new DblTp1FileHandler();
      const content =
        "☆00000001☆☆hello\n" +
        "★00000001★★你好\n" +
        "★00000001★★您好\n";

      const parsed = handler.parseTranslationDocument(content);
      expect(parsed.units).toHaveLength(1);
      expect(parsed.units[0]!.target).toEqual(["您好"]);
    });

    test("round-trips parse and format preserving structure", () => {
      const handler = new DblTp1FileHandler();
      const input =
        "☆00000004☆☆責める顔だ。\n" +
        "★00000004★★她的表情满是责备。\n" +
        "\n" +
        "☆00000006☆トワ＠１☆「嫌いよ」\n" +
        "★00000006★トワ＠１★「我讨厌你」";

      const parsed = handler.parseTranslationDocument(input);
      const output = handler.formatTranslationUnits(parsed.units);
      expect(output).toBe(input);
    });

    test("writes and reads files correctly", async () => {
      const dir = await mkdtemp(join(tmpdir(), "soloyakusha-dbltp1-"));
      cleanupTargets.push(dir);

      const filePath = join(dir, "dialog.txt");
      const handler = new DblTp1FileHandler();
      await handler.writeTranslationUnits(filePath, [
        {
          source: "こんにちは",
          target: ["你好"],
          metadata: "00000001",
        },
        {
          source: "【キャラ】さようなら",
          target: ["【キャラ】再见"],
          metadata: "00000002",
        },
      ]);

      const units = await handler.readTranslationUnits(filePath);
      expect(units).toHaveLength(2);
      expect(units[0]).toEqual({
        source: "こんにちは",
        target: ["你好"],
        metadata: "00000001",
      });
      expect(units[1]).toEqual({
        source: "【キャラ】さようなら",
        target: ["【キャラ】再见"],
        metadata: "00000002",
      });
    });

    test("supports custom control characters", () => {
      const handler = new DblTp1FileHandler();
      handler.applyParams({ sourceChar: "◎", targetChar: "◇" });
      const content =
        "◎00000001◎◎hello\n" +
        "◇00000001◇◇world\n";

      const parsed = handler.parseTranslationDocument(content);
      expect(parsed.units).toHaveLength(1);
      expect(parsed.units[0]!.source).toBe("hello");
      expect(parsed.units[0]!.target).toEqual(["world"]);
      expect(parsed.units[0]!.metadata).toBe("00000001");
    });

    test("retrieves handler through factory", () => {
      const handler = TranslationFileHandlerFactory.getHandler("dbl_tp1");
      expect(handler).toBeInstanceOf(DblTp1FileHandler);
      expect(handler.formatName).toBe("dbl_tp1");
    });

    test("assigns fallback ids for units without metadata", () => {
      const handler = new DblTp1FileHandler();
      const result = handler.formatTranslationUnits([
        { source: "first", target: ["第一"] },
        { source: "second", target: ["第二"] },
      ]);

      const lines = result.split("\n");
      expect(lines[0]).toStartWith("☆00000001☆☆");
      expect(lines[3]).toStartWith("☆00000002☆☆");
    });

    test("returns empty string for empty units", () => {
      const handler = new DblTp1FileHandler();
      expect(handler.formatTranslationUnits([])).toBe("");
    });

    test("handles source-only entries (no target)", () => {
      const handler = new DblTp1FileHandler();
      const content = "☆00000001☆☆hello\n";

      const parsed = handler.parseTranslationDocument(content);
      expect(parsed.units).toHaveLength(1);
      expect(parsed.units[0]!.source).toBe("hello");
      expect(parsed.units[0]!.target).toEqual([]);
      expect(parsed.units[0]!.metadata).toBe("00000001");
    });
  });

  describe("keepSourceNameInTarget", () => {
    test("replaces target name with source name when source has a name", () => {
      const result = keepSourceNameInTarget([
        {
          source: "【Alice】Hello",
          target: ["【Bob】你好"],
          metadata: null,
        },
      ]);

      expect(result[0]!.target).toEqual(["【Alice】你好"]);
    });

    test("keeps target unchanged when source has no name", () => {
      const result = keepSourceNameInTarget([
        {
          source: "Hello",
          target: ["你好"],
          metadata: null,
        },
      ]);

      expect(result[0]!.target).toEqual(["你好"]);
    });

    test("keeps target unchanged when target has no name", () => {
      const result = keepSourceNameInTarget([
        {
          source: "【Alice】Hello",
          target: ["你好"],
          metadata: null,
        },
      ]);

      expect(result[0]!.target).toEqual(["你好"]);
    });

    test("processes multiple targets in array", () => {
      const result = keepSourceNameInTarget([
        {
          source: "【Alice】Hello",
          target: ["【Bob】你好", "【Charlie】您好"],
          metadata: null,
        },
      ]);

      expect(result[0]!.target).toEqual(["【Alice】你好", "【Alice】您好"]);
    });
  });

  describe("nd_with_meta handler", () => {
    test("parses source and target lines with default regex", () => {
      const handler = new NdWithMetaFileHandler();
      const content =
        "▷000000◁いつも憂鬱な月曜の朝が\n" +
        "▶000000◀\n" +
        "\n" +
        "▷000001◁【宗太】（どんな顔して）\n" +
        "▶000001◀【宗太】\n";

      const parsed = handler.parseTranslationDocument(content);
      expect(parsed.units).toHaveLength(2);
      expect(parsed.units[0]!).toEqual({
        source: "いつも憂鬱な月曜の朝が",
        target: [""],
        metadata: { source: "▷000000◁", target: "▶000000◀" },
      });
      expect(parsed.units[1]!).toEqual({
        source: "【宗太】（どんな顔して）",
        target: ["【宗太】"],
        metadata: { source: "▷000001◁", target: "▶000001◀" },
      });
    });

    test("round-trips parse and format preserving structure", () => {
      const handler = new NdWithMetaFileHandler();
      const input =
        "▷000000◁いつも憂鬱な月曜の朝が\n" +
        "▶000000◀\n" +
        "\n" +
        "▷000001◁【宗太】（どんな顔して）\n" +
        "▶000001◀【宗太】";

      const parsed = handler.parseTranslationDocument(input);
      const output = handler.formatTranslationUnits(parsed.units);
      expect(output).toBe(input);
    });

    test("supports custom regex patterns", () => {
      const handler = new NdWithMetaFileHandler();
      handler.applyParams({
        sourceMetaRegex: "@\\d+%",
        targetMetaRegex: "#\\d+&",
      });
      const content =
        "@000000%hello\n" +
        "#000000&world\n";

      const parsed = handler.parseTranslationDocument(content);
      expect(parsed.units).toHaveLength(1);
      expect(parsed.units[0]!.source).toBe("hello");
      expect(parsed.units[0]!.target).toEqual(["world"]);
      expect(parsed.units[0]!.metadata).toEqual({
        source: "@000000%",
        target: "#000000&",
      });
    });

    test("writes and reads files correctly", async () => {
      const dir = await mkdtemp(join(tmpdir(), "soloyakusha-ndmeta-"));
      cleanupTargets.push(dir);

      const filePath = join(dir, "dialog.nd");
      const handler = new NdWithMetaFileHandler();
      await handler.writeTranslationUnits(filePath, [
        {
          source: "こんにちは",
          target: ["你好"],
          metadata: { source: "▷000001◁", target: "▶000001◀" },
        },
      ]);

      const units = await handler.readTranslationUnits(filePath);
      expect(units).toHaveLength(1);
      expect(units[0]!.source).toBe("こんにちは");
      expect(units[0]!.target).toEqual(["你好"]);
    });

    test("handles source-only entries (no target)", () => {
      const handler = new NdWithMetaFileHandler();
      const content =
        "▷000001◁hello\n";

      const parsed = handler.parseTranslationDocument(content);
      expect(parsed.units).toHaveLength(1);
      expect(parsed.units[0]!.source).toBe("hello");
      expect(parsed.units[0]!.target).toEqual([]);
      expect(parsed.units[0]!.metadata).toEqual({ source: "▷000001◁" });
    });
  });

  describe("dbl_tp2 handler", () => {
    test("parses standalone R entry without name", () => {
      const handler = new DblTp2FileHandler();
      const content = "☆000000R☆少しだけ素直に\n★000000R★少しだけ素直に\n";

      const parsed = handler.parseTranslationDocument(content);
      expect(parsed.units).toHaveLength(1);
      expect(parsed.units[0]!.source).toBe("少しだけ素直に");
      expect(parsed.units[0]!.target).toEqual(["少しだけ素直に"]);
      expect(parsed.units[0]!.metadata).toEqual({ source: "☆000000R☆", target: "★000000R★" });
    });

    test("merges N entry with following T entry", () => {
      const handler = new DblTp2FileHandler();
      const content =
        "☆000001N☆{fn}\n" +
        "★000001N☆{fn}\n" +
        "\n" +
        "☆000002T☆「んんぅ……ふぁ……」\\r\\n\n" +
        "★000002T☆「んんぅ……ふぁ……」\\r\\n\n";

      const parsed = handler.parseTranslationDocument(content);
      expect(parsed.units).toHaveLength(1);
      expect(parsed.units[0]!.source).toBe("【{fn}】「んんぅ……ふぁ……」\\r\\n");
      expect(parsed.units[0]!.target).toEqual(["【{fn}】「んんぅ……ふぁ……」\\r\\n"]);
      expect(parsed.units[0]!.metadata).toEqual({
        source: "☆000002T☆",
        target: "★000002T☆",
        nameSource: "☆000001N☆",
        nameTarget: "★000001N☆",
      });
    });

    test("does not merge name with non-consecutive T entry", () => {
      const handler = new DblTp2FileHandler();
      const content =
        "☆000001N☆{fn}\n" +
        "★000001N☆{fn}\n" +
        "\n" +
        "☆000002T☆text1\\r\\n\n" +
        "★000002T☆text1\\r\\n\n" +
        "\n" +
        "☆000003T☆text2\\r\\n\n" +
        "★000003T☆text2\\r\\n\n";

      const parsed = handler.parseTranslationDocument(content);
      expect(parsed.units).toHaveLength(2);
      expect(parsed.units[0]!.source).toBe("【{fn}】text1\\r\\n");
      expect(parsed.units[1]!.source).toBe("text2\\r\\n");
    });

    test("handles multiple name entries in sequence", () => {
      const handler = new DblTp2FileHandler();
      const content =
        "☆000001N☆Alice\n" +
        "★000001N☆アリス\n" +
        "\n" +
        "☆000002T☆Hello\n" +
        "★000002T☆こんにちは\n" +
        "\n" +
        "☆000003N☆Bob\n" +
        "★000003N☆ボブ\n" +
        "\n" +
        "☆000004T☆Goodbye\n" +
        "★000004T☆さようなら\n";

      const parsed = handler.parseTranslationDocument(content);
      expect(parsed.units).toHaveLength(2);
      expect(parsed.units[0]!.source).toBe("【Alice】Hello");
      expect(parsed.units[1]!.source).toBe("【Bob】Goodbye");
    });

    test("round-trips parse and format preserving structure", () => {
      const handler = new DblTp2FileHandler();
      const input =
        "☆000000R☆タイトル\n" +
        "★000000R★タイトル\n" +
        "\n" +
        "☆000001N☆Alice\n" +
        "★000001N☆アリス\n" +
        "\n" +
        "☆000002T☆Hello\\r\\n\n" +
        "★000002T☆こんにちは\\r\\n";

      const parsed = handler.parseTranslationDocument(input);
      const output = handler.formatTranslationUnits(parsed.units);
      expect(output).toBe(input);
    });

    test("supports custom regex patterns", () => {
      const handler = new DblTp2FileHandler();
      handler.applyParams({
        sourceMetaRegex: "@\\d+\\w@",
        targetMetaRegex: "#\\d+\\w#",
        nameMetaRegex: "\\d+N",
      });
      const content =
        "@000001N@Alice\n" +
        "#000001N#Alice\n" +
        "\n" +
        "@000002T@Hello\n" +
        "#000002T#こんにちは\n";

      const parsed = handler.parseTranslationDocument(content);
      expect(parsed.units).toHaveLength(1);
      expect(parsed.units[0]!.source).toBe("【Alice】Hello");
      expect(parsed.units[0]!.target).toEqual(["【Alice】こんにちは"]);
    });

    test("writes and reads files correctly", async () => {
      const dir = await mkdtemp(join(tmpdir(), "soloyakusha-dbltp2-"));
      cleanupTargets.push(dir);

      const filePath = join(dir, "dialog.txt");
      const handler = new DblTp2FileHandler();
      await handler.writeTranslationUnits(filePath, [
        {
          source: "【Alice】Hello\\r\\n",
          target: ["【Alice】こんにちは\\r\\n"],
          metadata: { source: "☆000001T☆", target: "★000001T☆", nameSource: "☆000000N☆", nameTarget: "★000000N☆" },
        },
      ]);

      const units = await handler.readTranslationUnits(filePath);
      expect(units).toHaveLength(1);
      expect(units[0]!.source).toBe("【Alice】Hello\\r\\n");
      expect(units[0]!.target).toEqual(["【Alice】こんにちは\\r\\n"]);
    });

    test("keeps source name on export when keepSourceName is true", () => {
      const handler = new DblTp2FileHandler();
      handler.applyParams({ keepSourceName: true });

      const result = handler.formatTranslationUnits([
        {
          source: "【Alice】Hello",
          target: ["【アリス】こんにちは"],
          metadata: {
            source: "☆000001T☆",
            target: "★000001T☆",
            nameSource: "☆000000N☆",
            nameTarget: "★000000N☆",
          },
        },
      ]);

      const lines = result.split("\n");
      expect(lines[0]).toBe("☆000000N☆Alice");
      expect(lines[1]).toBe("★000000N☆Alice");
    });

    test("keeps target name on export when keepSourceName is false", () => {
      const handler = new DblTp2FileHandler();
      handler.applyParams({ keepSourceName: false });

      const result = handler.formatTranslationUnits([
        {
          source: "【Alice】Hello",
          target: ["【アリス】こんにちは"],
          metadata: {
            source: "☆000001T☆",
            target: "★000001T☆",
            nameSource: "☆000000N☆",
            nameTarget: "★000000N☆",
          },
        },
      ]);

      const lines = result.split("\n");
      expect(lines[0]).toBe("☆000000N☆Alice");
      expect(lines[1]).toBe("★000000N☆アリス");
    });

    test("handles standalone message entry without name", () => {
      const handler = new DblTp2FileHandler();
      const content = "☆000001T☆plain text\n★000001T☆訳文\n";

      const parsed = handler.parseTranslationDocument(content);
      expect(parsed.units).toHaveLength(1);
      expect(parsed.units[0]!.source).toBe("plain text");
      expect(parsed.units[0]!.target).toEqual(["訳文"]);
    });

    test("retrieves handler through factory", () => {
      const handler = TranslationFileHandlerFactory.getHandler("dbl_tp2");
      expect(handler).toBeInstanceOf(DblTp2FileHandler);
      expect(handler.formatName).toBe("dbl_tp2");
    });

    test("handles source-only entries (no target)", () => {
      const handler = new DblTp2FileHandler();
      const content = "☆000001T☆only source\n";

      const parsed = handler.parseTranslationDocument(content);
      expect(parsed.units).toHaveLength(1);
      expect(parsed.units[0]!.source).toBe("only source");
      expect(parsed.units[0]!.target).toEqual([]);
    });

    test("assigns imported metadata on export", () => {
      const handler = new DblTp2FileHandler();
      const input =
        "☆000001N☆Alice\n" +
        "★000001N☆Alice\n" +
        "\n" +
        "☆000002T☆Hello\\r\\n\n" +
        "★000002T☆World\\r\\n";

      const parsed = handler.parseTranslationDocument(input);
      const output = handler.formatTranslationUnits(parsed.units);
      expect(output).toBe(input);
    });
  });
});
