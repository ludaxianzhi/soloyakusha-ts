import { fileURLToPath } from "node:url";
import { PromptManager } from "../prompts/index.ts";

const CONSISTENCY_PROMPT_FILE_PATH = fileURLToPath(
  new URL("../prompts/resources/consistency-prompts.yaml", import.meta.url),
);

let consistencyPromptManagerPromise: Promise<PromptManager> | undefined;

export function getConsistencyPromptFilePath(): string {
  return CONSISTENCY_PROMPT_FILE_PATH;
}

export function getConsistencyPromptManager(): Promise<PromptManager> {
  consistencyPromptManagerPromise ??= PromptManager.fromYamlFile(
    CONSISTENCY_PROMPT_FILE_PATH,
  );
  return consistencyPromptManagerPromise;
}
