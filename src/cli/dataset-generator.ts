import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { GlobalConfigManager } from "../config/manager.ts";
import type { TranslationFileHandler } from "../file-handlers/base.ts";
import { TranslationFileHandlerFactory } from "../file-handlers/factory.ts";
import { FullTextGlossaryScanner, Glossary, GlossaryUpdaterFactory } from "../glossary/index.ts";
import { createProviderFromConfigs, LlmClientProvider } from "../llm/provider.ts";
import type { LlmClientConfig } from "../llm/types.ts";
import { TranslationContextView } from "../project/context-view.ts";
import { resolveTranslationDependencyMode } from "../project/default-translation-pipeline.ts";
import type { Logger } from "../project/logger.ts";
import { NOOP_LOGGER } from "../project/logger.ts";
import type { OrderedFragmentSnapshot } from "../project/pipeline.ts";
import type {
  GlossaryExtractorConfig,
  GlossaryUpdaterConfig,
  PlotSummaryConfig,
} from "../project/config.ts";
import {
  PlotSummarizer,
  type PlotSummaryEntry,
} from "../project/plot-summarizer.ts";
import { PromptManager } from "../project/prompt-manager.ts";
import { RandomTextSplitter } from "../project/random-text-splitter.ts";
import { TranslationDocumentManager } from "../project/translation-document-manager.ts";
import { renderSimpleTranslationPrompt } from "../project/translation-prompt-context.ts";
import type {
  Chapter,
  FragmentEntry,
  FragmentPipelineStepState,
} from "../project/types.ts";

type DatasetConfigManager = Pick<
  GlobalConfigManager,
  | "listLlmProfileNames"
  | "getResolvedLlmProfile"
  | "getGlossaryExtractorConfig"
  | "getGlossaryUpdaterConfig"
  | "getPlotSummaryConfig"
>;

type DatasetLlmProvider = LlmClientProvider;

export type TrainingDatasetEntry = {
  SystemPrompt: string;
  UserPrompt: string;
  Answer: string;
};

export type GenerateTrainingDatasetOptions = {
  inputPattern: string;
  format?: string;
  dictionaryModels: ReadonlyArray<string>;
  outlineModels: ReadonlyArray<string>;
  maxSplitLength?: number;
};

export type GenerateTrainingDatasetDependencies = {
  configManager?: DatasetConfigManager;
  createProvider?: (configs: Record<string, LlmClientConfig>) => DatasetLlmProvider;
  logger?: Logger;
  promptManager?: PromptManager;
  tempRootDir?: string;
};

const TRANSLATION_STEP_ID = "translation";
const DEFAULT_GLOSSARY_UPDATE_FRAGMENTS_PER_BATCH = 5;
const DEFAULT_MAX_PLOT_SUMMARY_ENTRIES = 20;

export async function generateTrainingDataset(
  options: GenerateTrainingDatasetOptions,
  dependencies: GenerateTrainingDatasetDependencies = {},
): Promise<TrainingDatasetEntry[]> {
  const logger = dependencies.logger ?? NOOP_LOGGER;
  const promptManager = dependencies.promptManager ?? new PromptManager();
  const configManager = dependencies.configManager ?? new GlobalConfigManager();
  const files = await collectInputFiles(options.inputPattern);
  if (files.length === 0) {
    throw new Error(`glob 未匹配到任何输入文件: ${options.inputPattern}`);
  }

  logger.info?.("开始构建训练数据集", {
    inputPattern: options.inputPattern,
    fileCount: files.length,
  });

  const handlerByPath = new Map<string, TranslationFileHandler>();
  for (const filePath of files) {
    handlerByPath.set(filePath, resolveInputFileHandler(filePath, options.format));
  }

  const registeredModels = await configManager.listLlmProfileNames();
  assertModelChainConfigured("dictionaryModels", options.dictionaryModels);
  assertModelChainConfigured("outlineModels", options.outlineModels);
  const resolvedProfiles = await resolveRequestedProfiles(
    configManager,
    registeredModels,
    options.dictionaryModels,
    options.outlineModels,
  );
  const provider =
    dependencies.createProvider?.(resolvedProfiles) ?? createProviderFromConfigs(resolvedProfiles);
  const tempDir = await mkdtemp(join(dependencies.tempRootDir ?? tmpdir(), "soloyakusha-dataset-"));
  const maxSplitLength = options.maxSplitLength ?? 2000;

  try {
    const documentManager = new TranslationDocumentManager(tempDir, {
      textSplitter: new RandomTextSplitter(maxSplitLength),
      fileHandlerResolver: (filePath) => handlerByPath.get(resolve(filePath)),
    });
    const chapters = files.map<Chapter>((filePath, index) => ({
      id: index + 1,
      filePath,
    }));

    logger.info?.("加载输入文件并切分文本块", {
      splitMode: "random-left-half-normal",
      maxSplitLength,
    });
    await documentManager.loadChapters(
      chapters.map((chapter) => ({
        chapterId: chapter.id,
        filePath: chapter.filePath,
      })),
    );

    assertTranslatedCorpus(documentManager, chapters);

    const glossaryExtractorConfig = await configManager.getGlossaryExtractorConfig();
    const glossaryUpdaterConfig = await configManager.getGlossaryUpdaterConfig();
    const plotSummaryConfig = await configManager.getPlotSummaryConfig();

    const glossary = await extractGlossary(
      documentManager,
      provider,
      options.dictionaryModels,
      glossaryExtractorConfig,
      logger,
    );
    await updateGlossaryTranslations(
      glossary,
      documentManager,
      chapters,
      provider,
      options.dictionaryModels,
      glossaryUpdaterConfig,
      [],
      logger,
    );

    const plotSummaryEntries = await summarizePlots(
      documentManager,
      provider,
      options.outlineModels,
      plotSummaryConfig,
      tempDir,
      logger,
    );

    const orderedFragments = buildLinearOrderedFragments(documentManager, chapters);
    const dataset = await buildTrainingDatasetEntries({
      documentManager,
      chapters,
      orderedFragments,
      glossary,
      plotSummaryEntries,
      maxPlotSummaryEntries:
        plotSummaryConfig?.maxContextSummaries ?? DEFAULT_MAX_PLOT_SUMMARY_ENTRIES,
      promptManager,
      requirements: [],
      logger,
    });

    logger.info?.("训练数据集构建完成", {
      entryCount: dataset.length,
      fileCount: files.length,
    });
    return dataset;
  } finally {
    await provider.closeAll?.();
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function extractGlossary(
  documentManager: TranslationDocumentManager,
  provider: DatasetLlmProvider,
  modelNames: ReadonlyArray<string>,
  config: GlossaryExtractorConfig | undefined,
  logger: Logger,
): Promise<Glossary> {
  logger.info?.("开始提取术语", buildModelChainMetadata(modelNames));
  const scanner = new FullTextGlossaryScanner(
    provider.getChatClientWithFallback(modelNames, { logger }),
    logger,
  );
  const result = await scanner.scanDocumentManager(documentManager, {
    maxCharsPerBatch: config?.maxCharsPerBatch,
    occurrenceTopK: config?.occurrenceTopK,
    occurrenceTopP: config?.occurrenceTopP,
    requestOptions: config?.requestOptions,
  });
  return result.glossary;
}

async function updateGlossaryTranslations(
  glossary: Glossary,
  documentManager: TranslationDocumentManager,
  chapters: ReadonlyArray<Chapter>,
  provider: DatasetLlmProvider,
  modelNames: ReadonlyArray<string>,
  config: GlossaryUpdaterConfig | undefined,
  requirements: ReadonlyArray<string>,
  logger: Logger,
): Promise<void> {
  logger.info?.("开始补全术语译文", {
    ...buildModelChainMetadata(modelNames),
    glossaryTermCount: glossary.getAllTerms().length,
  });
  const updater = GlossaryUpdaterFactory.createUpdater({
    workflow: config?.workflow,
    clientResolver: provider.getChatClientWithFallback(modelNames, { logger }),
    defaultRequestOptions: config?.requestOptions,
    logger,
    updaterName: "dataset:glossary",
  });
  const orderedFragments = buildLinearOrderedFragments(documentManager, chapters);
  let processedBatches = 0;

  for (
    let batchStart = 0;
    batchStart < orderedFragments.length;
    batchStart += DEFAULT_GLOSSARY_UPDATE_FRAGMENTS_PER_BATCH
  ) {
    const batch = orderedFragments.slice(
      batchStart,
      batchStart + DEFAULT_GLOSSARY_UPDATE_FRAGMENTS_PER_BATCH,
    );
    const untranslatedTerms = collectUntranslatedTermsForFragments(glossary, documentManager, batch);
    if (untranslatedTerms.length === 0) {
      continue;
    }

    await updater.updateGlossary({
      glossary,
      untranslatedTerms,
      translationUnits: buildGlossaryUpdateUnitsForFragments(batch),
      requirements,
    });
    processedBatches += 1;

    if (glossary.getAllTerms().every((term) => term.status === "translated")) {
      break;
    }
  }

  logger.info?.("术语译文补全完成", {
    processedBatchCount: processedBatches,
    glossaryUpdateFragmentsPerBatch: DEFAULT_GLOSSARY_UPDATE_FRAGMENTS_PER_BATCH,
    remainingUntranslatedTermCount: glossary
      .getAllTerms()
      .filter((term) => term.status === "untranslated").length,
  });
}

async function summarizePlots(
  documentManager: TranslationDocumentManager,
  provider: DatasetLlmProvider,
  modelNames: ReadonlyArray<string>,
  config: PlotSummaryConfig | undefined,
  tempDir: string,
  logger: Logger,
): Promise<PlotSummaryEntry[]> {
  logger.info?.("开始生成情节总结", buildModelChainMetadata(modelNames));
  const summarizer = new PlotSummarizer(
    provider.getChatClientWithFallback(modelNames, { logger }),
    documentManager,
    join(tempDir, "Data", "dataset-plot-summaries.json"),
    {
      fragmentsPerBatch: config?.fragmentsPerBatch,
      maxContextSummaries: config?.maxContextSummaries,
      requestOptions: config?.requestOptions,
      logger,
    },
  );
  await summarizer.summarizeAll();
  return summarizer.getSummaries();
}

async function buildTrainingDatasetEntries(options: {
  documentManager: TranslationDocumentManager;
  chapters: Chapter[];
  orderedFragments: OrderedFragmentSnapshot[];
  glossary: Glossary;
  plotSummaryEntries: ReadonlyArray<PlotSummaryEntry>;
  maxPlotSummaryEntries: number;
  promptManager: PromptManager;
  requirements: ReadonlyArray<string>;
  logger: Logger;
}): Promise<TrainingDatasetEntry[]> {
  const dataset: TrainingDatasetEntry[] = [];
  const isStepCompleted = (chapterId: number, fragmentIndex: number, stepId: string): boolean =>
    options.documentManager.getPipelineStepState(chapterId, fragmentIndex, stepId)?.status ===
    "completed";

  for (const [index, snapshot] of options.orderedFragments.entries()) {
    const { chapterId, fragmentIndex, fragment } = snapshot;
    const dependencyMode = resolveTranslationDependencyMode({
      chapterId,
      fragmentIndex,
      stepId: TRANSLATION_STEP_ID,
      orderedFragments: options.orderedFragments,
      documentManager: options.documentManager,
      glossary: options.glossary,
      isStepCompleted,
    });
    const contextView =
      dependencyMode === "previousTranslations" || dependencyMode === "glossaryTerms"
        ? new TranslationContextView(chapterId, fragmentIndex, {
            documentManager: options.documentManager,
            stepId: TRANSLATION_STEP_ID,
            dependencyMode,
            traversalChapters: options.chapters,
            glossary: options.glossary,
            plotSummaryEntries: options.plotSummaryEntries,
            maxPlotSummaryEntries: options.maxPlotSummaryEntries,
          })
        : undefined;

    const renderedPrompt = await renderSimpleTranslationPrompt({
      sourceText: options.documentManager.getSourceText(chapterId, fragmentIndex),
      contextView,
      glossary: options.glossary,
      requirements: options.requirements,
      promptManager: options.promptManager,
    });
    dataset.push({
      SystemPrompt: renderedPrompt.systemPrompt,
      UserPrompt: renderedPrompt.userPrompt,
      Answer: buildAnswerJson(fragment),
    });

    markFragmentCompleted(fragment);
    options.logger.info?.("已生成数据集条目", {
      progress: `${index + 1}/${options.orderedFragments.length}`,
      chapterId,
      fragmentIndex,
    });
  }

  return dataset;
}

function buildAnswerJson(fragment: FragmentEntry): string {
  return JSON.stringify(
    {
      translations: fragment.translation.lines.map((translation, index) => ({
        id: String(index + 1),
        translation,
      })),
    },
    null,
    2,
  );
}

function markFragmentCompleted(fragment: FragmentEntry): void {
  const now = new Date().toISOString();
  const completedState: FragmentPipelineStepState = {
    status: "completed",
    queueSequence: 0,
    attemptCount: 1,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
  fragment.pipelineStates[TRANSLATION_STEP_ID] = completedState;
}

function buildLinearOrderedFragments(
  documentManager: TranslationDocumentManager,
  chapters: ReadonlyArray<Chapter>,
): OrderedFragmentSnapshot[] {
  return chapters.flatMap((chapter) =>
    (documentManager.getChapterById(chapter.id)?.fragments ?? []).map((fragment, fragmentIndex) => ({
      chapterId: chapter.id,
      fragmentIndex,
      fragment,
    })),
  );
}

function collectUntranslatedTermsForFragments(
  glossary: Glossary,
  documentManager: TranslationDocumentManager,
  fragments: ReadonlyArray<OrderedFragmentSnapshot>,
): ReturnType<Glossary["getUntranslatedTermsForText"]> {
  const termMap = new Map<string, ReturnType<Glossary["getUntranslatedTermsForText"]>[number]>();

  for (const { chapterId, fragmentIndex } of fragments) {
    for (const term of glossary.getUntranslatedTermsForText(
      documentManager.getSourceText(chapterId, fragmentIndex),
    )) {
      termMap.set(term.term, term);
    }
  }

  return [...termMap.values()];
}

function buildGlossaryUpdateUnitsForFragments(
  fragments: ReadonlyArray<OrderedFragmentSnapshot>,
): Array<{ id: string; sourceText: string; translatedText: string }> {
  return fragments.flatMap(({ chapterId, fragmentIndex, fragment }) =>
    fragment.source.lines.map((sourceText, lineIndex) => ({
      id: `chapter:${chapterId}:fragment:${fragmentIndex}:unit:${lineIndex + 1}`,
      sourceText,
      translatedText: fragment.translation.lines[lineIndex] ?? "",
    })),
  );
}

function assertTranslatedCorpus(
  documentManager: TranslationDocumentManager,
  chapters: ReadonlyArray<Chapter>,
): void {
  const missing: string[] = [];
  for (const chapter of chapters) {
    for (const [index, unit] of documentManager.getChapterTranslationUnits(chapter.id).entries()) {
      const translation = unit.target.at(-1)?.trim() ?? "";
      if (translation.length === 0) {
        missing.push(`${chapter.filePath}#${index + 1}`);
        if (missing.length >= 10) {
          break;
        }
      }
    }
    if (missing.length >= 10) {
      break;
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `输入中存在未翻译单元，无法构建训练数据集。请先补全译文：${missing.join(", ")}`,
    );
  }
}

async function resolveRequestedProfiles(
  configManager: DatasetConfigManager,
  registeredModels: ReadonlyArray<string>,
  dictionaryModels: ReadonlyArray<string>,
  outlineModels: ReadonlyArray<string>,
): Promise<Record<string, LlmClientConfig>> {
  const profiles: Record<string, LlmClientConfig> = {};
  for (const modelName of new Set([...dictionaryModels, ...outlineModels])) {
    profiles[modelName] = await resolveRequiredProfile(configManager, registeredModels, modelName);
  }
  return profiles;
}

function assertModelChainConfigured(
  optionName: "dictionaryModels" | "outlineModels",
  modelNames: ReadonlyArray<string>,
): void {
  if (modelNames.length > 0) {
    return;
  }

  const cliFlag = optionName === "dictionaryModels" ? "--dictionary-model" : "--outline-model";
  throw new Error(`缺少必填参数 ${cliFlag}`);
}

function buildModelChainMetadata(modelNames: ReadonlyArray<string>): Record<string, unknown> {
  return {
    modelNames: [...modelNames],
    fallbackCount: Math.max(0, modelNames.length - 1),
  };
}

async function resolveRequiredProfile(
  configManager: DatasetConfigManager,
  registeredModels: ReadonlyArray<string>,
  profileName: string,
): Promise<LlmClientConfig> {
  try {
    return await configManager.getResolvedLlmProfile(profileName);
  } catch (error) {
    const listedModels = registeredModels.length > 0 ? registeredModels.join(", ") : "<none>";
    throw new Error(
      `未找到模型配置 '${profileName}'。已注册模型: ${listedModels}${
        error instanceof Error ? `。原始错误: ${error.message}` : ""
      }`,
    );
  }
}

async function collectInputFiles(inputPattern: string): Promise<string[]> {
  const { cwd, pattern } = resolveGlobScanOptions(inputPattern);
  const glob = new Bun.Glob(pattern);
  const files: string[] = [];

  for await (const match of glob.scan({
    cwd,
    onlyFiles: true,
    absolute: true,
  })) {
    files.push(resolve(match));
  }

  return [...new Set(files)].sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function resolveGlobScanOptions(inputPattern: string): { cwd: string; pattern: string } {
  const normalizedAbsolutePattern = toGlobPath(
    isAbsolute(inputPattern) ? inputPattern : resolve(inputPattern),
  );
  const segments = normalizedAbsolutePattern.split("/");
  const firstGlobIndex = segments.findIndex((segment) => /[*?[\]{}]/.test(segment));

  if (firstGlobIndex === -1) {
    const resolvedLiteralPath = resolve(inputPattern);
    return {
      cwd: dirname(resolvedLiteralPath),
      pattern: toGlobPath(basename(resolvedLiteralPath)),
    };
  }

  const baseDir = segments.slice(0, firstGlobIndex).join("/");
  const pattern = segments.slice(firstGlobIndex).join("/");
  return {
    cwd: baseDir.replaceAll("/", sep),
    pattern,
  };
}

function toGlobPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function resolveInputFileHandler(
  filePath: string,
  format?: string,
): TranslationFileHandler {
  if (format) {
    return TranslationFileHandlerFactory.getHandler(format);
  }

  const extension = extname(filePath).toLowerCase();
  if (extension === ".json") {
    return TranslationFileHandlerFactory.getHandler("galtransl_json");
  }
  if (extension === ".m3t") {
    return TranslationFileHandlerFactory.getHandler("m3t");
  }
  if (extension === ".txt") {
    throw new Error(
      `无法根据扩展名自动判断 ${filePath} 的处理格式，请显式传入 --format（可选: plain_text, naturedialog, naturedialog_keepname）。`,
    );
  }

  throw new Error(
    `不支持自动推断文件格式: ${filePath}。请显式传入 --format。`,
  );
}
