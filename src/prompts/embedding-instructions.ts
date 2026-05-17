/**
 * 嵌入指令资源加载模块，提供各任务类型的嵌入指令文本。
 *
 * 指令文本硬编码在 {@link ./resources/embedding-instructions.yaml} 中，
 * 运行时通过本模块按 taskType 查询。
 *
 * @module prompts/embedding-instructions
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const EMBEDDING_INSTRUCTIONS_FILE_PATH = fileURLToPath(
  new URL("./resources/embedding-instructions.yaml", import.meta.url),
);

const embeddedInstructionTexts = new Map<string, string>();

/**
 * 注册嵌入的指令 YAML 文本，供独立构建（无文件系统）使用。
 */
export function registerEmbeddedInstructionText(yamlText: string): void {
  const parsed = parseYaml(yamlText);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("嵌入指令 YAML 解析结果必须是对象");
  }

  for (const [taskType, instruction] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof instruction === "string") {
      embeddedInstructionTexts.set(taskType, instruction);
    }
  }
}

/**
 * 获取嵌入指令文件路径，供 build-webui 脚本注册嵌入文本。
 */
export function getEmbeddingInstructionFilePath(): string {
  return EMBEDDING_INSTRUCTIONS_FILE_PATH;
}

let loadedInstructions: Record<string, string> | undefined;

/**
 * 获取指定任务类型的嵌入指令文本。
 * 优先从嵌入式注册获取，其次从 YAML 文件加载（仅加载一次并缓存）。
 */
export async function getEmbeddingInstruction(taskType: string): Promise<string> {
  const cached = resolveCachedInstruction(taskType);
  if (cached !== undefined) {
    return cached;
  }

  const instructions = await loadInstructions();
  const instruction = instructions[taskType];
  if (!instruction) {
    throw new Error(`未找到嵌入指令: ${taskType}`);
  }

  return instruction;
}

function resolveCachedInstruction(taskType: string): string | undefined {
  if (embeddedInstructionTexts.size > 0) {
    return embeddedInstructionTexts.get(taskType);
  }

  if (loadedInstructions) {
    return loadedInstructions[taskType];
  }

  return undefined;
}

async function loadInstructions(): Promise<Record<string, string>> {
  if (loadedInstructions) {
    return loadedInstructions;
  }

  const yamlText = await readFile(EMBEDDING_INSTRUCTIONS_FILE_PATH, "utf8");
  const parsed = parseYaml(yamlText);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("嵌入指令 YAML 解析结果必须是对象");
  }

  loadedInstructions = Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  return loadedInstructions;
}
