import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranslationFileHandlerFactory } from "./factory.ts";
import { GaltranslJsonFileHandler } from "./galtransl-json-file-handler.ts";
import { NatureDialogKeepNameFileHandler } from "./nature-dialog-file-handler.ts";
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
  test("reads and writes galtransl json format", async () => {
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

    const handler = new GaltranslJsonFileHandler();
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

  test("keeps source names in nature dialog keepname format", async () => {
    const handler = new NatureDialogKeepNameFileHandler();
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
        ".json": "galtransl_json",
      }),
    });

    await manager.loadChapters([{ chapterId: 1, filePath: sourcePath }]);
    expect(manager.getSourceText(1, 0)).toBe("【Alice】你好");

    await manager.updateTranslation(1, 0, "【Alice】Hello");
    const exportPath = join(workspaceDir, "export.json");
    await manager.exportChapter(
      1,
      exportPath,
      TranslationFileHandlerFactory.getHandler("galtransl_json"),
    );

    const exported = JSON.parse(await readFile(exportPath, "utf8")) as Array<Record<string, string>>;
    expect(exported[0]).toEqual({ name: "Alice", message: "Hello" });
  });
});
