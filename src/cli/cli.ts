#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Logger, LoggerMetadata } from "../project/logger.ts";
import { generateTrainingDataset } from "./dataset-generator.ts";

type ParsedArgs = {
  command?: string;
  options: Record<string, string[]>;
};

class StderrLogger implements Logger {
  debug(message: string, metadata?: LoggerMetadata): void {
    this.write("DEBUG", message, metadata);
  }

  info(message: string, metadata?: LoggerMetadata): void {
    this.write("INFO", message, metadata);
  }

  warn(message: string, metadata?: LoggerMetadata): void {
    this.write("WARN", message, metadata);
  }

  error(message: string, metadata?: LoggerMetadata): void {
    this.write("ERROR", message, metadata);
  }

  private write(level: string, message: string, metadata?: LoggerMetadata): void {
    const suffix =
      metadata && Object.keys(metadata).length > 0 ? ` ${JSON.stringify(metadata)}` : "";
    process.stderr.write(`[${level}] ${message}${suffix}\n`);
  }
}

const logger = new StderrLogger();

try {
  await main(process.argv.slice(2));
} catch (error) {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (!parsed.command || parsed.command === "--help" || hasOption(parsed, "help")) {
    printUsage();
    return;
  }

  if (parsed.command !== "build-dataset") {
    throw new Error(`不支持的命令: ${parsed.command}`);
  }

  const inputPath = requireSingleOption(parsed, "input");
  const dictionaryModel = readOptionalOption(parsed, "dictionary-model", "glossary-model");
  const outlineModel = readOptionalOption(parsed, "outline-model", "summary-model");
  if (!dictionaryModel) {
    throw new Error("缺少必填参数 --dictionary-model");
  }
  if (!outlineModel) {
    throw new Error("缺少必填参数 --outline-model");
  }

  const dataset = await generateTrainingDataset(
    {
      inputPath,
      format: readOptionalOption(parsed, "format"),
      dictionaryModel,
      outlineModel,
      maxSplitLength: parseOptionalInteger(
        readOptionalOption(parsed, "max-split-length", "max-chars-per-fragment"),
      ),
      requirements: parsed.options.requirement ?? [],
    },
    {
      logger,
    },
  );

  const outputPath = readOptionalOption(parsed, "output");
  const jsonText = `${JSON.stringify(dataset, null, 2)}\n`;
  if (outputPath) {
    const resolvedOutput = resolve(outputPath);
    await mkdir(dirname(resolvedOutput), { recursive: true });
    await writeFile(resolvedOutput, jsonText, "utf8");
    logger.info("已写出训练数据集", {
      outputPath: resolvedOutput,
      entryCount: dataset.length,
    });
    return;
  }

  process.stdout.write(jsonText);
}

function printUsage(): void {
  const usage = [
    "用法:",
    "  bun run src/cli/cli.ts build-dataset --input <path> --dictionary-model <name> --outline-model <name> [--format <format>] [--output <path>] [--max-split-length <n>]",
    "",
    "说明:",
    "  --input                   指定已翻译文本文件或目录",
    "  --dictionary-model        指定用于术语提取/术语补全的已注册 LLM 名称",
    "  --outline-model           指定用于情节大纲总结的已注册 LLM 名称",
    "  --format                  显式指定文件处理格式；处理 .txt 时建议必填",
    "  --output                  可选，指定输出 JSON 文件路径；未指定时输出到 stdout",
    "  --max-split-length        可选，指定随机切分器的最大切分长度（默认 2000）",
    "  --max-chars-per-fragment  兼容旧参数，等价于 --max-split-length",
    "  --requirement             可重复传入，用于补充当前数据集构造要求",
  ].join("\n");
  process.stdout.write(`${usage}\n`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const options: Record<string, string[]> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith("--")) {
      throw new Error(`不支持的位置参数: ${token}`);
    }

    const optionName = token.slice(2);
    if (optionName.length === 0) {
      throw new Error("检测到空参数名");
    }

    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options[optionName] = ["true"];
      continue;
    }

    options[optionName] ??= [];
    options[optionName]!.push(next);
    index += 1;
  }

  return { command, options };
}

function hasOption(parsed: ParsedArgs, ...names: string[]): boolean {
  return names.some((name) => parsed.options[name] !== undefined);
}

function requireSingleOption(parsed: ParsedArgs, ...names: string[]): string {
  const value = readOptionalOption(parsed, ...names);
  if (!value) {
    throw new Error(`缺少必填参数 --${names[0]}`);
  }
  return value;
}

function readOptionalOption(parsed: ParsedArgs, ...names: string[]): string | undefined {
  for (const name of names) {
    const values = parsed.options[name];
    if (!values || values.length === 0) {
      continue;
    }
    if (values.length > 1) {
      throw new Error(`参数 --${name} 只能传一次`);
    }
    return values[0];
  }

  return undefined;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`参数必须是正整数: ${value}`);
  }

  return parsed;
}
