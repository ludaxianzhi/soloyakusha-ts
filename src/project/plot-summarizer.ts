/**
 * 提供基于 LLM 的情节总结功能，对多个文本块批量总结并持久化结果。
 *
 * 主要特性：
 * - 使用原文（源语言）进行总结
 * - 每批次合并多个文本块（默认 5 个），不跨章节边界
 * - 多个文本块共享同一条总结条目
 * - 格式化（JSON Schema）约束输出
 * - 总结结果保存在独立文件，不混入翻译文件
 * - 每次总结时将最近 N 条历史总结作为上下文（默认 20 条）
 * - 支持 StoryTopology 拓扑感知：仅使用前序章节的总结作为上下文
 *
 * @module project/plot-summarizer
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { buildJsonSchemaChatRequestOptions, mergeChatRequestOptions } from "../llm/chat-request.ts";
import type { ChatClient } from "../llm/base.ts";
import type { ChatRequestOptions, JsonObject } from "../llm/types.ts";
import { getDefaultPromptManager } from "../prompts/index.ts";
import type { PromptManager } from "../prompts/index.ts";
import { NOOP_LOGGER, type Logger } from "./logger.ts";
import type { TranslationDocumentManager } from "./translation-document-manager.ts";
import type { TranslationProcessorClientResolver } from "./translation-processor.ts";
import type { StoryTopology } from "./story-topology.ts";

// ===== 常量 =====

const PLOT_SUMMARY_PROMPT_ID = "project.plotSummary";
const PLOT_SUMMARY_PROMPT_NAME = "plot_summary_result";
const PLOT_SUMMARY_SCHEMA_VERSION = 1 as const;
const DEFAULT_FRAGMENTS_PER_BATCH = 5;
const DEFAULT_MAX_CONTEXT_SUMMARIES = 20;

// ===== 类型定义 =====

/**
 * 单条情节总结的结构化内容。
 *
 * 所有字段均使用原文语言填写。
 */
export type PlotSummaryContent = {
  /** 本段落的主要情节事件 */
  mainEvents: string;
  /** 涉及的关键人物 */
  keyCharacters: string;
  /** 主要场景和背景描述 */
  setting: string;
  /** 其他值得关注的细节、伏笔或情节转折；无则为空字符串 */
  notes: string;
};

/**
 * 单条情节总结条目，覆盖同一章节内连续的多个文本块。
 */
export type PlotSummaryEntry = {
  /** 所属章节 ID */
  chapterId: number;
  /** 起始文本块索引（含） */
  startFragmentIndex: number;
  /** 结束文本块索引（不含） */
  endFragmentIndex: number;
  /** 结构化总结内容 */
  summary: PlotSummaryContent;
  /** 创建时间（ISO 8601） */
  createdAt: string;
};

/**
 * 情节总结持久化文件的顶层结构。
 */
export type PlotSummaryDocument = {
  schemaVersion: typeof PLOT_SUMMARY_SCHEMA_VERSION;
  entries: PlotSummaryEntry[];
};

/**
 * PlotSummarizer 的构造选项。
 */
export type PlotSummarizerOptions = {
  /**
   * 每批次合并的文本块数量。
   * @default 5
   */
  fragmentsPerBatch?: number;
  /**
   * 作为上下文传递给 LLM 的最近总结条数上限。
   * @default 20
   */
  maxContextSummaries?: number;
  /** 默认的 LLM 请求选项 */
  requestOptions?: ChatRequestOptions;
  /** 日志记录器 */
  logger?: Logger;
  /** 提示词管理器（不传则使用内置默认 prompt） */
  promptManager?: PromptManager;
  /**
   * 多分线剧情拓扑。
   * 提供后，总结上下文仅包含当前章节在拓扑中的前序章节的总结。
   * 不提供时，上下文使用全部已有总结（兼容无拓扑场景）。
   */
  topology?: StoryTopology;
};

// ===== 主类 =====

/**
 * 基于 LLM 的情节总结器。
 *
 * 典型用法：
 * ```typescript
 * const summarizer = new PlotSummarizer(chatClient, documentManager, "Data/plot-summaries.json");
 * await summarizer.loadSummaries();
 * await summarizer.summarizeAll();
 * ```
 */
export class PlotSummarizer {
  private readonly fragmentsPerBatch: number;
  private readonly maxContextSummaries: number;
  private readonly requestOptions?: ChatRequestOptions;
  private readonly logger: Logger;
  private readonly promptManagerPromise: Promise<PromptManager>;
  private readonly topology?: StoryTopology;
  private entries: PlotSummaryEntry[] = [];

  constructor(
    private readonly clientResolver: TranslationProcessorClientResolver,
    private readonly documentManager: TranslationDocumentManager,
    readonly outputPath: string,
    options: PlotSummarizerOptions = {},
  ) {
    this.fragmentsPerBatch = options.fragmentsPerBatch ?? DEFAULT_FRAGMENTS_PER_BATCH;
    this.maxContextSummaries = options.maxContextSummaries ?? DEFAULT_MAX_CONTEXT_SUMMARIES;
    this.requestOptions = options.requestOptions;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.promptManagerPromise = Promise.resolve(
      options.promptManager ?? getDefaultPromptManager(),
    );
    this.topology = options.topology;
  }

  // ===== 数据访问 =====

  /**
   * 返回当前内存中的所有总结条目（浅拷贝）。
   */
  getSummaries(): PlotSummaryEntry[] {
    return [...this.entries];
  }

  /**
   * 根据文本块位置获取前序情节总结。
   *
   * 当提供了 StoryTopology 时，仅返回拓扑中当前章节前序章节的总结，
   * 以及同一章节中位于 fragmentIndex 之前的总结条目。
   *
   * 未提供 StoryTopology 时，返回除同一章节中当前及之后片段外的所有总结。
   *
   * @param chapterId - 当前章节 ID
   * @param fragmentIndex - 当前文本块索引（可选，不传则只按章节粒度过滤）
   */
  getSummariesForPosition(chapterId: number, fragmentIndex?: number): PlotSummaryEntry[] {
    return this.filterPredecessorEntries(chapterId, fragmentIndex);
  }

  // ===== 持久化 =====

  /**
   * 从文件加载已有的总结结果。若文件不存在则初始化为空列表。
   */
  async loadSummaries(): Promise<void> {
    try {
      const content = await readFile(this.outputPath, "utf8");
      const doc = JSON.parse(content) as PlotSummaryDocument;
      if (doc.schemaVersion === PLOT_SUMMARY_SCHEMA_VERSION && Array.isArray(doc.entries)) {
        this.entries = doc.entries;
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        this.entries = [];
        return;
      }
      throw error;
    }
  }

  /**
   * 将当前总结结果持久化到输出文件。
   */
  async saveSummaries(): Promise<void> {
    await mkdir(dirname(this.outputPath), { recursive: true });
    const doc: PlotSummaryDocument = {
      schemaVersion: PLOT_SUMMARY_SCHEMA_VERSION,
      entries: this.entries,
    };
    await writeFile(this.outputPath, JSON.stringify(doc, null, 2), "utf8");
  }

  // ===== 总结入口 =====

  /**
   * 对所有章节按批次进行情节总结。
   *
   * 章节之间互不干扰，批次不跨章节边界。
   */
  async summarizeAll(options?: { requestOptions?: ChatRequestOptions }): Promise<void> {
    const chapters = this.documentManager.getAllChapters();
    for (const chapter of chapters) {
      await this.summarizeChapter(chapter.id, options);
    }
  }

  /**
   * 对指定章节按批次进行情节总结。
   *
   * 每批次包含最多 {@link PlotSummarizerOptions.fragmentsPerBatch} 个文本块，
   * 当章节末尾剩余文本块不足一批时，只处理剩余部分。
   *
   * @returns 本次生成的所有总结条目
   */
  async summarizeChapter(
    chapterId: number,
    options?: { requestOptions?: ChatRequestOptions },
  ): Promise<PlotSummaryEntry[]> {
    const chapter = this.documentManager.getChapterById(chapterId);
    if (!chapter) {
      throw new Error(`章节不存在: ${chapterId}`);
    }

    const totalFragments = chapter.fragments.length;
    const results: PlotSummaryEntry[] = [];

    let fragmentIndex = 0;
    while (fragmentIndex < totalFragments) {
      const remaining = totalFragments - fragmentIndex;
      const count = Math.min(this.fragmentsPerBatch, remaining);
      const entry = await this.summarizeFragments(chapterId, fragmentIndex, count, options);
      results.push(entry);
      fragmentIndex += count;
    }

    return results;
  }

  /**
   * 对指定章节中连续的 `count` 个文本块进行情节总结。
   *
   * 多个文本块合并为单一 LLM 请求，共享同一条总结条目。
   * 使用已有总结的最近 {@link PlotSummarizerOptions.maxContextSummaries} 条作为上下文。
   *
   * @param chapterId - 章节 ID
   * @param startFragmentIndex - 起始文本块索引（含）
   * @param count - 本批次的文本块数量（实际处理量不超过章节剩余文本块数）
   * @returns 生成的总结条目
   */
  async summarizeFragments(
    chapterId: number,
    startFragmentIndex: number,
    count: number,
    options?: { requestOptions?: ChatRequestOptions },
  ): Promise<PlotSummaryEntry> {
    const chapter = this.documentManager.getChapterById(chapterId);
    if (!chapter) {
      throw new Error(`章节不存在: ${chapterId}`);
    }

    const endFragmentIndex = Math.min(startFragmentIndex + count, chapter.fragments.length);
    const actualCount = endFragmentIndex - startFragmentIndex;
    if (actualCount <= 0) {
      throw new Error(
        `无效的片段范围: chapterId=${chapterId}, startFragmentIndex=${startFragmentIndex}, count=${count}`,
      );
    }

    // 收集批次内所有文本块的源语言文本
    const sourceBlocks: string[] = [];
    for (let i = startFragmentIndex; i < endFragmentIndex; i++) {
      sourceBlocks.push(this.documentManager.getSourceText(chapterId, i));
    }

    // 筛选前序总结作为上下文（拓扑感知或全量回退）
    const contextSummaries = this.buildContextSummaries(chapterId, startFragmentIndex);

    this.logger.info?.("开始情节总结", {
      chapterId,
      startFragmentIndex,
      endFragmentIndex,
      sourceBlockCount: sourceBlocks.length,
      contextSummaryCount: contextSummaries.length,
    });

    const responseSchema = buildPlotSummaryResponseSchema();
    const promptManager = await this.promptManagerPromise;
    const renderedPrompt = promptManager.renderPrompt(PLOT_SUMMARY_PROMPT_ID, {
      sourceBlocks,
      contextSummaries,
      responseSchemaJson: JSON.stringify(responseSchema, null, 2),
    });

    const chatClient = this.resolveChatClient();
    const responseText = await chatClient.singleTurnRequest(
      renderedPrompt.userPrompt,
      buildJsonSchemaChatRequestOptions(
        mergeChatRequestOptions(this.requestOptions, options?.requestOptions),
        {
          name: PLOT_SUMMARY_PROMPT_NAME,
          systemPrompt: renderedPrompt.systemPrompt,
          responseSchema,
        },
      ),
    );

    const summaryContent = parsePlotSummaryResponse(responseText);
    const entry: PlotSummaryEntry = {
      chapterId,
      startFragmentIndex,
      endFragmentIndex,
      summary: summaryContent,
      createdAt: new Date().toISOString(),
    };

    this.entries.push(entry);
    await this.saveSummaries();

    this.logger.info?.("情节总结完成", {
      chapterId,
      startFragmentIndex,
      endFragmentIndex,
    });

    return entry;
  }

  // ===== 私有工具 =====

  /**
   * 构建用于 LLM 上下文的前序总结字符串列表。
   *
   * 先通过拓扑（或全量回退）筛选前序条目，再截取最近 N 条并格式化。
   */
  private buildContextSummaries(chapterId: number, startFragmentIndex: number): string[] {
    const predecessorEntries = this.filterPredecessorEntries(chapterId, startFragmentIndex);
    return predecessorEntries
      .slice(-this.maxContextSummaries)
      .map((entry) => formatSummaryForContext(entry));
  }

  /**
   * 筛选指定位置的前序总结条目。
   *
   * 有拓扑时：仅保留前序章节 + 同章节中更早片段的条目。
   * 无拓扑时：保留其他章节全部条目 + 同章节中更早片段的条目。
   */
  private filterPredecessorEntries(
    chapterId: number,
    fragmentIndex?: number,
  ): PlotSummaryEntry[] {
    if (this.topology) {
      const predecessorChapterIds = new Set(
        this.topology.getPredecessorChapterIds(chapterId),
      );
      return this.entries.filter((entry) => {
        if (predecessorChapterIds.has(entry.chapterId)) {
          return true;
        }
        if (
          entry.chapterId === chapterId &&
          fragmentIndex != null &&
          entry.endFragmentIndex <= fragmentIndex
        ) {
          return true;
        }
        return false;
      });
    }

    // 无拓扑：保留所有其他章节 + 同章节中更早片段
    return this.entries.filter((entry) => {
      if (entry.chapterId !== chapterId) {
        return true;
      }
      if (fragmentIndex != null && entry.endFragmentIndex <= fragmentIndex) {
        return true;
      }
      return false;
    });
  }

  private resolveChatClient(): ChatClient {
    if ("singleTurnRequest" in this.clientResolver) {
      return this.clientResolver;
    }

    return this.clientResolver.provider.getChatClient(this.clientResolver.modelName);
  }
}

// ===== 纯函数工具 =====

/**
 * 构建情节总结响应的 JSON Schema，用于约束 LLM 格式化输出。
 */
function buildPlotSummaryResponseSchema(): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: {
        type: "object",
        additionalProperties: false,
        properties: {
          mainEvents: {
            type: "string",
            description: "本段落的主要情节事件",
          },
          keyCharacters: {
            type: "string",
            description: "涉及的关键人物",
          },
          setting: {
            type: "string",
            description: "主要场景和背景描述",
          },
          notes: {
            type: "string",
            description: "其他值得关注的细节、伏笔或情节转折；如无则为空字符串",
          },
        },
        required: ["mainEvents", "keyCharacters", "setting", "notes"],
      },
    },
    required: ["summary"],
  };
}

/**
 * 将总结条目格式化为可读的上下文字符串，供 LLM 参考。
 */
function formatSummaryForContext(entry: PlotSummaryEntry): string {
  const { summary } = entry;
  const lines = [
    `[章节 ${entry.chapterId} 片段 ${entry.startFragmentIndex}–${entry.endFragmentIndex - 1}]`,
    `事件：${summary.mainEvents}`,
    `人物：${summary.keyCharacters}`,
    `场景：${summary.setting}`,
  ];

  if (summary.notes) {
    lines.push(`注记：${summary.notes}`);
  }

  return lines.join("\n");
}

/**
 * 解析 LLM 返回的情节总结 JSON 文本。
 */
function parsePlotSummaryResponse(responseText: string): PlotSummaryContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error(`情节总结响应不是有效 JSON: ${responseText.slice(0, 200)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error("情节总结响应格式无效：顶层必须是对象");
  }

  const summary = parsed.summary;
  if (!isRecord(summary)) {
    throw new Error("情节总结响应格式无效：缺少 summary 字段");
  }

  return {
    mainEvents: String(summary.mainEvents ?? ""),
    keyCharacters: String(summary.keyCharacters ?? ""),
    setting: String(summary.setting ?? ""),
    notes: String(summary.notes ?? ""),
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
