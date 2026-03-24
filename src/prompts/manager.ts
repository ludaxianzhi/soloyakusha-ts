import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { createPromptTemplate } from "./templates.ts";
import type {
  PromptCatalogDocument,
  PromptDefinition,
  PromptRenderVariables,
  RenderedPrompt,
} from "./types.ts";

type CompiledPromptDefinition = {
  system: ReturnType<typeof createPromptTemplate>;
  user: ReturnType<typeof createPromptTemplate>;
};

export class PromptManager {
  private readonly prompts = new Map<string, CompiledPromptDefinition>();

  private constructor(private readonly sourceLabel: string) {}

  static async fromYamlFile(filePath: string): Promise<PromptManager> {
    const yamlText = await readFile(filePath, "utf8");
    return PromptManager.fromYamlText(yamlText, filePath);
  }

  static fromYamlText(yamlText: string, sourceLabel = "<memory>"): PromptManager {
    const parsed = parseYaml(yamlText);
    return PromptManager.fromDocument(parsed, sourceLabel);
  }

  static fromDocument(document: unknown, sourceLabel = "<memory>"): PromptManager {
    const catalog = validatePromptCatalogDocument(document, sourceLabel);
    const manager = new PromptManager(sourceLabel);

    for (const [promptId, definition] of Object.entries(catalog.prompts)) {
      manager.prompts.set(promptId, {
        system: createPromptTemplate(definition.system),
        user: createPromptTemplate(definition.user),
      });
    }

    return manager;
  }

  getPromptIds(): string[] {
    return [...this.prompts.keys()];
  }

  renderPrompt(
    promptId: string,
    variables: PromptRenderVariables = {},
  ): RenderedPrompt {
    const definition = this.prompts.get(promptId);
    if (!definition) {
      throw new Error(`提示词不存在: ${promptId} (${this.sourceLabel})`);
    }

    return {
      promptId,
      systemPrompt: definition.system.render(variables),
      userPrompt: definition.user.render(variables),
    };
  }
}

const DEFAULT_PROMPT_FILE_PATH = fileURLToPath(
  new URL("./resources/default-prompts.yaml", import.meta.url),
);

let defaultPromptManagerPromise: Promise<PromptManager> | undefined;

export function getDefaultPromptFilePath(): string {
  return DEFAULT_PROMPT_FILE_PATH;
}

export function getDefaultPromptManager(): Promise<PromptManager> {
  defaultPromptManagerPromise ??= PromptManager.fromYamlFile(DEFAULT_PROMPT_FILE_PATH);
  return defaultPromptManagerPromise;
}

function validatePromptCatalogDocument(
  document: unknown,
  sourceLabel: string,
): PromptCatalogDocument {
  if (!isRecord(document)) {
    throw new Error(`提示词 YAML 顶层必须是对象: ${sourceLabel}`);
  }

  const version = document.version;
  if (version !== undefined && version !== 1) {
    throw new Error(`提示词 YAML 版本不受支持: ${String(version)} (${sourceLabel})`);
  }

  const prompts = document.prompts;
  if (!isRecord(prompts)) {
    throw new Error(`提示词 YAML 必须包含 prompts 对象: ${sourceLabel}`);
  }

  const normalizedPrompts: Record<string, PromptDefinition> = {};
  for (const [promptId, value] of Object.entries(prompts)) {
    normalizedPrompts[promptId] = validatePromptDefinition(value, promptId, sourceLabel);
  }

  return {
    version: version === undefined ? 1 : version,
    prompts: normalizedPrompts,
  };
}

function validatePromptDefinition(
  value: unknown,
  promptId: string,
  sourceLabel: string,
): PromptDefinition {
  if (!isRecord(value)) {
    throw new Error(`提示词定义必须是对象: ${promptId} (${sourceLabel})`);
  }

  return {
    system: validatePromptMessageTemplateDefinition(
      value.system,
      `${promptId}.system`,
      sourceLabel,
    ),
    user: validatePromptMessageTemplateDefinition(
      value.user,
      `${promptId}.user`,
      sourceLabel,
    ),
  };
}

function validatePromptMessageTemplateDefinition(
  value: unknown,
  fieldLabel: string,
  sourceLabel: string,
) {
  if (!isRecord(value)) {
    throw new Error(`提示词模板定义必须是对象: ${fieldLabel} (${sourceLabel})`);
  }

  if (
    value.type !== "static" &&
    value.type !== "interpolate" &&
    value.type !== "liquid"
  ) {
    throw new Error(`提示词模板类型无效: ${fieldLabel} (${sourceLabel})`);
  }

  if (typeof value.template !== "string") {
    throw new Error(`提示词模板内容必须是字符串: ${fieldLabel} (${sourceLabel})`);
  }

  return {
    type: value.type,
    template: value.template,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}