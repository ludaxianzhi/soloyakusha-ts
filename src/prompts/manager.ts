/**
 * 负责加载、校验并渲染提示词目录中的 system/user 模板。
 *
 * 本模块将 YAML/对象格式的提示词定义编译为可复用的模板实例，
 * 以便上层流程按 promptId 获取最终的 systemPrompt 与 userPrompt。
 *
 * @module prompts/manager
 */
import { readFile } from "node:fs/promises";
import { normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { createPromptTemplate } from "./templates.ts";
import type {
  PromptCatalogDocument,
  PromptDefinition,
  PromptMessageTemplateDefinition,
  PromptRenderVariables,
  RenderedPrompt,
} from "./types.ts";

type CompiledPromptDefinition = {
  system: ReturnType<typeof createPromptTemplate>;
  user: ReturnType<typeof createPromptTemplate>;
};

const embeddedPromptCatalogs = new Map<string, string>();

/**
 * 提示词管理器，负责从文档加载 prompt 定义并按需渲染 system/user 内容。
 *
 * 典型流程：
 * - 从 YAML 文件、YAML 文本或已解析文档创建实例
 * - 校验 prompt 目录结构与模板定义
 * - 根据 promptId 和变量集渲染最终提示词
 */
export class PromptManager {
  private readonly prompts = new Map<string, CompiledPromptDefinition>();

  private constructor(private readonly sourceLabel: string) {}

  static async fromYamlFile(filePath: string): Promise<PromptManager> {
    const yamlText = await readPromptCatalogText(filePath);
    return PromptManager.fromYamlText(yamlText, filePath);
  }

  static async fromYamlFiles(filePaths: ReadonlyArray<string>): Promise<PromptManager> {
    const documents = await Promise.all(
      filePaths.map(async (filePath) => ({
        filePath,
        yamlText: await readPromptCatalogText(filePath),
      })),
    );

    return PromptManager.fromCatalogs(
      documents.map((document) => ({
        sourceLabel: document.filePath,
        document: parseYaml(document.yamlText),
      })),
      filePaths.join(", "),
    );
  }

  static fromYamlText(yamlText: string, sourceLabel = "<memory>"): PromptManager {
    const parsed = parseYaml(yamlText);
    return PromptManager.fromDocument(parsed, sourceLabel);
  }

  static fromDocument(document: unknown, sourceLabel = "<memory>"): PromptManager {
    return PromptManager.fromCatalogs([{ sourceLabel, document }], sourceLabel);
  }

  static fromCatalogs(
    catalogs: ReadonlyArray<{ sourceLabel: string; document: unknown }>,
    sourceLabel = "<memory>",
  ): PromptManager {
    const manager = new PromptManager(sourceLabel);

    for (const catalogInput of catalogs) {
      const catalog = validatePromptCatalogDocument(
        catalogInput.document,
        catalogInput.sourceLabel,
      );

      for (const [promptId, definition] of Object.entries(catalog.prompts)) {
        manager.prompts.set(promptId, {
          system: createPromptTemplate(definition.system),
          user: createPromptTemplate(definition.user),
        });
      }
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
const DEFAULT_PROMPT_FILE_PATHS = [
  DEFAULT_PROMPT_FILE_PATH,
  fileURLToPath(new URL("./resources/project-translation-prompts.yaml", import.meta.url)),
  fileURLToPath(new URL("./resources/project-proofread-prompts.yaml", import.meta.url)),
  fileURLToPath(new URL("./resources/project-editor-prompts.yaml", import.meta.url)),
] as const;

let defaultPromptManagerPromise: Promise<PromptManager> | undefined;

/**
 * 获取内置默认提示词文件的绝对路径。
 *
 * 该路径指向随包分发的默认提示词资源，通常供启动时加载兜底配置使用。
 */
export function getDefaultPromptFilePath(): string {
  return DEFAULT_PROMPT_FILE_PATH;
}

/**
 * 异步加载并缓存默认提示词管理器实例。
 *
 * 首次调用时会读取内置 YAML 资源并完成校验，后续调用复用同一个 Promise。
 */
export function getDefaultPromptManager(): Promise<PromptManager> {
  defaultPromptManagerPromise ??= PromptManager.fromYamlFiles(DEFAULT_PROMPT_FILE_PATHS);
  return defaultPromptManagerPromise;
}

export function registerEmbeddedPromptCatalog(filePath: string, yamlText: string): void {
  embeddedPromptCatalogs.set(toPromptCatalogKey(filePath), yamlText);
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
): PromptMessageTemplateDefinition {
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

async function readPromptCatalogText(filePath: string): Promise<string> {
  const embeddedYamlText = embeddedPromptCatalogs.get(toPromptCatalogKey(filePath));
  if (embeddedYamlText !== undefined) {
    return embeddedYamlText;
  }

  return readFile(filePath, "utf8");
}

function toPromptCatalogKey(filePath: string): string {
  const normalizedPath = normalize(filePath);
  return process.platform === "win32"
    ? normalizedPath.toLowerCase()
    : normalizedPath;
}
