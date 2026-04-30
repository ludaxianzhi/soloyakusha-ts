import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { GlobalConfigManager } from "../config/manager.ts";
import type {
  PersistedStyleLibraryConfig,
  StyleLibrarySourceSummary,
} from "../config/types.ts";
import { TranslationFileHandlerFactory } from "../file-handlers/factory.ts";
import type { EmbeddingClient } from "../llm/base.ts";
import { LlmClientProvider } from "../llm/provider.ts";
import type { JsonObject, LlmClientConfig } from "../llm/types.ts";
import { stableStringify } from "../llm/utils.ts";
import { GLOBAL_EMBEDDING_CLIENT_NAME } from "../project/config.ts";
import type { TranslationUnit } from "../project/types.ts";
import { VectorStoreClientProvider } from "../vector/provider.ts";
import { VectorRetriever } from "../vector/retriever.ts";
import type { VectorCollectionInfo } from "../vector/types.ts";
import type { VectorStoreClient } from "../vector/base.ts";
import { extractArchiveToDirectory } from "../webui/services/archive-extractor.ts";
import type {
  CreateStyleLibraryInput,
  DeleteStyleLibraryResult,
  ImportStyleLibraryInput,
  StyleLibraryCatalog,
  StyleLibraryImportResult,
  StyleLibraryQueryOptions,
  StyleLibraryQueryChunkResult,
  StyleLibraryQueryResult,
  StyleLibrarySummary,
} from "./types.ts";
import {
  STYLE_LIBRARY_COLLECTION_PREFIX,
  STYLE_LIBRARY_RESOURCE_TYPE,
} from "./types.ts";

type StyleLibraryServiceOptions = {
  manager?: GlobalConfigManager;
  embeddingClientResolver?: (config: LlmClientConfig) => Promise<EmbeddingClient> | EmbeddingClient;
  vectorClientResolver?: (storeName: string, clientConfig: { provider: string } & JsonObject) => Promise<VectorStoreClient> | VectorStoreClient;
  now?: () => Date;
  tempRootDir?: string;
};

type ImportedSourceFile = {
  relativePath: string;
  lines: string[];
};

type ChunkedText = {
  text: string;
  charCount: number;
};

type SourceChunk = ChunkedText & {
  sourceFile: string;
  sourceFileIndex: number;
  chunkIndex: number;
};

type DiscoveredCollection = {
  vectorStoreName: string;
  collection: VectorCollectionInfo;
  styleLibraryName?: string;
  targetLanguage?: string;
  chunkLength?: number;
  embeddingFingerprint?: string;
  managedByApp: boolean;
  metadata?: JsonObject;
};

const SUPPORTED_ARCHIVE_EXTENSIONS = new Set([".zip"]);
const SUPPORTED_SINGLE_FILE_EXTENSIONS = new Set(["", ".txt", ".text", ".m3t", ".json"]);

export class StyleLibraryService {
  private readonly manager: GlobalConfigManager;
  private readonly now: () => Date;
  private readonly tempRootDir: string;
  private readonly embeddingClientResolver?: StyleLibraryServiceOptions["embeddingClientResolver"];
  private readonly vectorClientResolver?: StyleLibraryServiceOptions["vectorClientResolver"];

  constructor(options: StyleLibraryServiceOptions = {}) {
    this.manager = options.manager ?? new GlobalConfigManager();
    this.now = options.now ?? (() => new Date());
    this.tempRootDir = options.tempRootDir ?? tmpdir();
    this.embeddingClientResolver = options.embeddingClientResolver;
    this.vectorClientResolver = options.vectorClientResolver;
  }

  async listLibraries(): Promise<StyleLibraryCatalog> {
    const registered = (await this.manager.getStyleLibraryConfig())?.libraries ?? {};
    const discoveryErrors: Record<string, string> = {};
    const currentEmbeddingState = await this.resolveCurrentEmbeddingState();
    const discoveredByKey = new Map<string, DiscoveredCollection>();

    for (const storeName of await this.manager.listVectorStoreNames()) {
      try {
        const collections = await this.listStoreCollections(storeName);
        for (const collection of collections) {
          if (!isStyleLibraryCollection(collection)) {
            continue;
          }

          const parsed = parseDiscoveredCollection(storeName, collection);
          discoveredByKey.set(buildLibraryLocationKey(storeName, collection.name), parsed);
        }
      } catch (error) {
        discoveryErrors[storeName] = error instanceof Error ? error.message : String(error);
      }
    }

    const libraries: StyleLibrarySummary[] = [];
    for (const [name, config] of Object.entries(registered)) {
      const key = buildLibraryLocationKey(config.vectorStoreName, config.collectionName);
      const discovered = discoveredByKey.get(key);
      discoveredByKey.delete(key);
      const compatibility = evaluateEmbeddingCompatibility(
        config.embeddingFingerprint,
        currentEmbeddingState.fingerprint,
        currentEmbeddingState.available,
      );
      libraries.push({
        name,
        displayName: config.displayName,
        vectorStoreName: config.vectorStoreName,
        collectionName: config.collectionName,
        targetLanguage: config.targetLanguage,
        chunkLength: config.chunkLength,
        embeddingFingerprint: config.embeddingFingerprint,
        embeddingState: compatibility.state,
        invalidationReason: compatibility.reason,
        source: "registered",
        discoveryMode: config.discoveryMode,
        managedByApp: config.managedByApp,
        existsInVectorStore: discovered !== undefined,
        metadata: config.metadata ?? discovered?.metadata,
        sourceSummary: config.sourceSummary,
      });
    }

    for (const discovered of discoveredByKey.values()) {
      const compatibility = evaluateEmbeddingCompatibility(
        discovered.embeddingFingerprint,
        currentEmbeddingState.fingerprint,
        currentEmbeddingState.available,
      );
      libraries.push({
        name: discovered.styleLibraryName ?? discovered.collection.name,
        displayName: undefined,
        vectorStoreName: discovered.vectorStoreName,
        collectionName: discovered.collection.name,
        targetLanguage: discovered.targetLanguage,
        chunkLength: discovered.chunkLength,
        embeddingFingerprint: discovered.embeddingFingerprint,
        embeddingState: compatibility.state,
        invalidationReason: compatibility.reason,
        source: "discovered",
        discoveryMode: "discovered",
        managedByApp: discovered.managedByApp,
        existsInVectorStore: true,
        metadata: discovered.metadata,
        sourceSummary: undefined,
      });
    }

    libraries.sort((left, right) => left.name.localeCompare(right.name));
    return {
      libraries,
      discoveryErrors,
    };
  }

  async createLibrary(
    libraryName: string,
    input: CreateStyleLibraryInput,
  ): Promise<StyleLibrarySummary> {
    const embeddingConfig = await this.manager.getResolvedEmbeddingConfig();
    const embeddingFingerprint = buildStyleLibraryEmbeddingFingerprint(embeddingConfig);
    const collectionName = normalizeCollectionName(
      input.collectionName ?? buildManagedStyleLibraryCollectionName(libraryName),
    );
    const timestamp = this.now().toISOString();
    const persisted: PersistedStyleLibraryConfig = {
      displayName: input.displayName?.trim() || undefined,
      vectorStoreName: input.vectorStoreName,
      collectionName,
      targetLanguage: input.targetLanguage,
      chunkLength: input.chunkLength,
      embeddingFingerprint,
      discoveryMode: "managed",
      managedByApp: input.managedByApp ?? true,
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: input.metadata ? { ...input.metadata } : undefined,
      sourceSummary: undefined,
    };

    await this.withEmbeddingClient(async (embeddingClient) => {
      const dimension = await measureEmbeddingDimension(embeddingClient);
      await this.withVectorStoreClient(persisted.vectorStoreName, async (vectorClient) => {
        await vectorClient.ensureCollection({
          name: persisted.collectionName,
          dimension,
          distance: "cosine",
          metadata: buildCollectionMetadata(libraryName, persisted),
        });
      });
    });

    await this.manager.setStyleLibrary(libraryName, persisted);
    return {
      name: libraryName,
      displayName: persisted.displayName,
      vectorStoreName: persisted.vectorStoreName,
      collectionName: persisted.collectionName,
      targetLanguage: persisted.targetLanguage,
      chunkLength: persisted.chunkLength,
      embeddingFingerprint: persisted.embeddingFingerprint,
      embeddingState: "compatible",
      source: "registered",
      discoveryMode: persisted.discoveryMode,
      managedByApp: persisted.managedByApp,
      existsInVectorStore: true,
      metadata: persisted.metadata,
      sourceSummary: persisted.sourceSummary,
    };
  }

  async importLibrary(
    libraryName: string,
    input: ImportStyleLibraryInput,
  ): Promise<StyleLibraryImportResult> {
    const config = await this.manager.getRequiredStyleLibrary(libraryName);
    await this.assertLibraryCompatible(config);

    const tempDir = await mkdtemp(join(this.tempRootDir, "soloyakusha-style-library-"));
    try {
      const files = await this.materializeImportFiles(tempDir, input);
      const parsedFiles = await this.parseImportedFiles(files, input.formatName);
      const chunks = buildSourceChunks(parsedFiles, config.chunkLength);
      if (chunks.length === 0) {
        throw new Error("未从上传内容中提取到可导入的样式文本");
      }

      const characterCount = chunks.reduce((total, chunk) => total + chunk.charCount, 0);

      await this.withEmbeddingClient(async (embeddingClient) => {
        const dimension = await measureEmbeddingDimension(embeddingClient);
        await this.withVectorStoreClient(config.vectorStoreName, async (vectorClient) => {
          const retriever = new VectorRetriever(vectorClient, embeddingClient, {
            defaultCollectionName: config.collectionName,
          });
          await retriever.ensureCollection({
            name: config.collectionName,
            dimension,
            distance: "cosine",
            metadata: buildCollectionMetadata(libraryName, config),
          });
          await retriever.delete({
            filter: {
              resourceType: STYLE_LIBRARY_RESOURCE_TYPE,
              styleLibraryName: libraryName,
            },
          });
          await retriever.upsertTexts({
            records: chunks.map((chunk) => ({
              id: buildChunkId(libraryName, chunk.sourceFile, chunk.chunkIndex),
              text: chunk.text,
              document: chunk.text,
              payload: {
                resourceType: STYLE_LIBRARY_RESOURCE_TYPE,
                styleLibraryName: libraryName,
                sourceFile: chunk.sourceFile,
                sourceFileIndex: chunk.sourceFileIndex,
                chunkIndex: chunk.chunkIndex,
                charCount: chunk.charCount,
              },
            })),
          });
        });
      });

      const sourceSummary: StyleLibrarySourceSummary = {
        fileCount: parsedFiles.length,
        chunkCount: chunks.length,
        characterCount,
      };
      await this.manager.setStyleLibrary(libraryName, {
        ...config,
        updatedAt: this.now().toISOString(),
        sourceSummary,
      });

      return {
        libraryName,
        collectionName: config.collectionName,
        importedFiles: parsedFiles.map((file) => file.relativePath),
        skippedFiles: files
          .map((file) => file.relativePath)
          .filter((relativePath) => !parsedFiles.some((file) => file.relativePath === relativePath)),
        chunkCount: chunks.length,
        characterCount,
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async queryLibrary(
    libraryName: string,
    text: string,
    options: StyleLibraryQueryOptions = {},
  ): Promise<StyleLibraryQueryResult> {
    const config = await this.manager.getRequiredStyleLibrary(libraryName);
    await this.assertLibraryCompatible(config);
    const chunks = splitTextIntoChunks(text, config.chunkLength);
    if (chunks.length === 0) {
      return {
        libraryName,
        collectionName: config.collectionName,
        chunks: [],
        matches: [],
      };
    }

    return await this.withEmbeddingClient(async (embeddingClient) => {
      return await this.withVectorStoreClient(config.vectorStoreName, async (vectorClient) => {
        const retriever = new VectorRetriever(vectorClient, embeddingClient, {
          defaultCollectionName: config.collectionName,
        });
        const topKPerChunk =
          options.topKPerChunk === "source-ratio"
            ? Math.max(1, chunks.length)
            : Math.max(1, Math.floor(options.topKPerChunk ?? 1));
        const chunkResults: StyleLibraryQueryChunkResult[] = [];
        for (const [chunkIndex, chunk] of chunks.entries()) {
          const matches = (await retriever.searchText({
            text: chunk.text,
            topK: topKPerChunk,
            filter: {
              resourceType: STYLE_LIBRARY_RESOURCE_TYPE,
              styleLibraryName: libraryName,
            },
          })).map((match) => ({
            ...match,
            chunkIndex,
            queryText: chunk.text,
          }));
          chunkResults.push({
            chunkIndex,
            text: chunk.text,
            charCount: chunk.charCount,
            matches,
          });
        }

        return {
          libraryName,
          collectionName: config.collectionName,
          chunks: chunkResults,
          matches: chunkResults.flatMap((chunk) => chunk.matches),
        };
      });
    });
  }

  async deleteLibrary(
    selector:
      | { libraryName: string; deleteCollection?: boolean }
      | { vectorStoreName: string; collectionName: string; deleteCollection?: boolean },
  ): Promise<DeleteStyleLibraryResult> {
    if ("libraryName" in selector) {
      const config = await this.manager.getStyleLibrary(selector.libraryName);
      const removedRegistry = await this.manager.removeStyleLibrary(selector.libraryName);
      let removedCollection = false;
      if (config && selector.deleteCollection !== false) {
        removedCollection = await this.deleteCollection(config.vectorStoreName, config.collectionName);
      }
      return {
        removedRegistry,
        removedCollection,
      };
    }

    return {
      removedRegistry: false,
      removedCollection:
        selector.deleteCollection === false
          ? false
          : await this.deleteCollection(selector.vectorStoreName, selector.collectionName),
    };
  }

  private async deleteCollection(
    vectorStoreName: string,
    collectionName: string,
  ): Promise<boolean> {
    try {
      await this.withVectorStoreClient(vectorStoreName, async (vectorClient) => {
        await vectorClient.deleteCollection({ collectionName });
      });
      return true;
    } catch {
      return false;
    }
  }

  private async materializeImportFiles(
    tempDir: string,
    input: ImportStyleLibraryInput,
  ): Promise<Array<{ relativePath: string; absolutePath: string }>> {
    const extension = extname(input.fileName).toLowerCase();
    if (SUPPORTED_ARCHIVE_EXTENSIONS.has(extension)) {
      const relativePaths = await extractArchiveToDirectory(
        tempDir,
        toArrayBuffer(input.content),
        { archiveFileName: input.fileName },
      );
      return relativePaths.map((relativePath) => ({
        relativePath,
        absolutePath: join(tempDir, ...relativePath.split("/")),
      }));
    }

    if (!SUPPORTED_SINGLE_FILE_EXTENSIONS.has(extension)) {
      throw new Error(`不支持的样式库导入文件类型: ${input.fileName}`);
    }

    const targetPath = join(tempDir, sanitizeFileName(input.fileName || "upload.txt"));
    await mkdir(join(targetPath, ".."), { recursive: true }).catch(() => undefined);
    await Bun.write(targetPath, input.content);
    return [
      {
        relativePath: sanitizeFileName(input.fileName || "upload.txt"),
        absolutePath: targetPath,
      },
    ];
  }

  private async parseImportedFiles(
    files: Array<{ relativePath: string; absolutePath: string }>,
    explicitFormatName?: string,
  ): Promise<ImportedSourceFile[]> {
    const parsed: ImportedSourceFile[] = [];

    for (const file of files) {
      if (!isPotentialSourceFile(file.relativePath, explicitFormatName)) {
        continue;
      }

      const content = await Bun.file(file.absolutePath).text();
      const lines = extractStyleLinesFromContent(file.relativePath, content, explicitFormatName);
      if (lines.length === 0) {
        continue;
      }

      parsed.push({
        relativePath: file.relativePath,
        lines,
      });
    }

    return parsed;
  }

  private async listStoreCollections(storeName: string): Promise<VectorCollectionInfo[]> {
    return await this.withVectorStoreClient(storeName, (vectorClient) => vectorClient.listCollections());
  }

  private async assertLibraryCompatible(config: PersistedStyleLibraryConfig): Promise<void> {
    const current = await this.resolveCurrentEmbeddingState();
    const compatibility = evaluateEmbeddingCompatibility(
      config.embeddingFingerprint,
      current.fingerprint,
      current.available,
    );
    if (compatibility.state === "invalid") {
      throw new Error(compatibility.reason ?? "样式库已失效");
    }
  }

  private async resolveCurrentEmbeddingState(): Promise<{
    available: boolean;
    fingerprint?: string;
  }> {
    const embedding = await this.manager.getEmbeddingConfig();
    if (!embedding) {
      return { available: false };
    }

    return {
      available: true,
      fingerprint: buildStyleLibraryEmbeddingFingerprint(
        await this.manager.getResolvedEmbeddingConfig(),
      ),
    };
  }

  private async withEmbeddingClient<T>(
    operation: (client: EmbeddingClient) => Promise<T>,
  ): Promise<T> {
    const config = await this.manager.getResolvedEmbeddingConfig();
    if (this.embeddingClientResolver) {
      return await operation(await this.embeddingClientResolver(config));
    }

    const provider = new LlmClientProvider();
    provider.register(GLOBAL_EMBEDDING_CLIENT_NAME, config);
    try {
      return await operation(provider.getEmbeddingClient(GLOBAL_EMBEDDING_CLIENT_NAME));
    } finally {
      await provider.closeAll();
    }
  }

  private async withVectorStoreClient<T>(
    storeName: string,
    operation: (client: VectorStoreClient) => Promise<T>,
  ): Promise<T> {
    const config = await this.manager.getResolvedVectorStoreConfig(storeName);
    if (this.vectorClientResolver) {
      return await operation(await this.vectorClientResolver(storeName, config as unknown as { provider: string } & JsonObject));
    }

    const provider = new VectorStoreClientProvider();
    provider.register(storeName, config);
    try {
      return await operation(provider.getClient(storeName));
    } finally {
      await provider.closeAll();
    }
  }
}

export function buildStyleLibraryEmbeddingFingerprint(config: LlmClientConfig): string {
  const fingerprintSource = {
    provider: config.provider,
    modelName: config.modelName,
    endpoint: config.endpoint,
    modelType: config.modelType,
    pca: config.pca
      ? {
          enabled: config.pca.enabled === true,
          weightsFilePath: config.pca.weightsFilePath,
        }
      : undefined,
  };
  const hash = createHash("sha256")
    .update(stableStringify(fingerprintSource))
    .digest("hex")
    .slice(0, 16);
  return `${config.provider}:${config.modelName}:${hash}`;
}

export function buildManagedStyleLibraryCollectionName(libraryName: string): string {
  const normalized = libraryName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${STYLE_LIBRARY_COLLECTION_PREFIX}${normalized || "library"}`;
}

export function splitTextIntoChunks(text: string, chunkLength: number): ChunkedText[] {
  const normalizedLines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((line) => splitOversizedLine(line.trim(), chunkLength))
    .filter((line) => line.length > 0);

  const chunks: ChunkedText[] = [];
  let currentLines: string[] = [];
  let currentLength = 0;

  for (const line of normalizedLines) {
    const nextLength = currentLength === 0 ? line.length : currentLength + 1 + line.length;
    if (currentLines.length > 0 && nextLength > chunkLength) {
      const textChunk = currentLines.join("\n");
      chunks.push({ text: textChunk, charCount: textChunk.length });
      currentLines = [line];
      currentLength = line.length;
      continue;
    }

    currentLines.push(line);
    currentLength = nextLength;
  }

  if (currentLines.length > 0) {
    const textChunk = currentLines.join("\n");
    chunks.push({ text: textChunk, charCount: textChunk.length });
  }

  return chunks;
}

function buildCollectionMetadata(
  libraryName: string,
  config: PersistedStyleLibraryConfig,
): JsonObject {
  return {
    resourceType: STYLE_LIBRARY_RESOURCE_TYPE,
    styleLibraryName: libraryName,
    targetLanguage: config.targetLanguage,
    chunkLength: config.chunkLength,
    embeddingFingerprint: config.embeddingFingerprint,
    managedByApp: config.managedByApp,
    discoveryMode: config.discoveryMode,
    ...(config.metadata ?? {}),
  };
}

function parseDiscoveredCollection(
  vectorStoreName: string,
  collection: VectorCollectionInfo,
): DiscoveredCollection {
  const metadata = collection.metadata;
  return {
    vectorStoreName,
    collection,
    styleLibraryName:
      readStringField(metadata, "styleLibraryName") ??
      deriveLibraryNameFromCollection(collection.name),
    targetLanguage: readStringField(metadata, "targetLanguage"),
    chunkLength: readNumberField(metadata, "chunkLength"),
    embeddingFingerprint: readStringField(metadata, "embeddingFingerprint"),
    managedByApp: readBooleanField(metadata, "managedByApp") ?? false,
    metadata,
  };
}

function buildLibraryLocationKey(vectorStoreName: string, collectionName: string): string {
  return `${vectorStoreName}::${collectionName}`;
}

function isStyleLibraryCollection(collection: VectorCollectionInfo): boolean {
  return (
    readStringField(collection.metadata, "resourceType") === STYLE_LIBRARY_RESOURCE_TYPE ||
    collection.name.startsWith(STYLE_LIBRARY_COLLECTION_PREFIX)
  );
}

function deriveLibraryNameFromCollection(collectionName: string): string {
  return collectionName.startsWith(STYLE_LIBRARY_COLLECTION_PREFIX)
    ? collectionName.slice(STYLE_LIBRARY_COLLECTION_PREFIX.length)
    : collectionName;
}

function evaluateEmbeddingCompatibility(
  libraryFingerprint: string | undefined,
  currentFingerprint: string | undefined,
  currentAvailable: boolean,
): { state: StyleLibrarySummary["embeddingState"]; reason?: string } {
  if (!libraryFingerprint) {
    return {
      state: "unknown",
      reason: "样式库缺少嵌入绑定信息",
    };
  }

  if (!currentAvailable || !currentFingerprint) {
    return {
      state: "invalid",
      reason: "当前未配置全局嵌入模型，样式库不可用",
    };
  }

  if (libraryFingerprint !== currentFingerprint) {
    return {
      state: "invalid",
      reason: "样式库绑定的嵌入模型与当前全局嵌入模型不一致",
    };
  }

  return { state: "compatible" };
}

async function measureEmbeddingDimension(client: EmbeddingClient): Promise<number> {
  const vector = await client.getEmbedding("style-library-dimension-probe");
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error("无法解析嵌入向量维度");
  }

  return vector.length;
}

function buildSourceChunks(files: ImportedSourceFile[], chunkLength: number): SourceChunk[] {
  const chunks: SourceChunk[] = [];

  files.forEach((file, sourceFileIndex) => {
    const textChunks = splitTextIntoChunks(file.lines.join("\n"), chunkLength);
    textChunks.forEach((chunk, chunkIndex) => {
      chunks.push({
        sourceFile: file.relativePath,
        sourceFileIndex,
        chunkIndex,
        text: chunk.text,
        charCount: chunk.charCount,
      });
    });
  });

  return chunks;
}

function buildChunkId(libraryName: string, sourceFile: string, chunkIndex: number): string {
  return `${libraryName}:${sourceFile}:${chunkIndex}`;
}

function extractStyleLinesFromContent(
  relativePath: string,
  content: string,
  explicitFormatName?: string,
): string[] {
  const candidateFormats = explicitFormatName
    ? [explicitFormatName]
    : inferCandidateFormats(relativePath);

  let lastError: unknown;
  for (const formatName of candidateFormats) {
    try {
      const handler = TranslationFileHandlerFactory.getHandler(formatName);
      const units = handler.parseTranslationDocument(content).units;
      const lines = extractStyleLinesFromUnits(units);
      if (lines.length > 0) {
        return lines;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError && explicitFormatName) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return [];
}

function extractStyleLinesFromUnits(units: TranslationUnit[]): string[] {
  const lines: string[] = [];
  for (const unit of units) {
    const preferred =
      [...unit.target]
        .reverse()
        .map((text) => text.trim())
        .find((text) => text.length > 0) ??
      unit.source.trim();
    if (!preferred) {
      continue;
    }

    for (const line of preferred.replace(/\r\n/g, "\n").split("\n")) {
      const trimmed = line.trim();
      if (trimmed) {
        lines.push(trimmed);
      }
    }
  }

  return lines;
}

function inferCandidateFormats(relativePath: string): string[] {
  const extension = extname(relativePath).toLowerCase();
  switch (extension) {
    case ".m3t":
      return ["m3t"];
    case ".json":
      return ["galtransl_json"];
    default:
      return ["naturedialog_keepname", "naturedialog", "m3t", "plain_text"];
  }
}

function isPotentialSourceFile(relativePath: string, explicitFormatName?: string): boolean {
  if (explicitFormatName) {
    return true;
  }

  return SUPPORTED_SINGLE_FILE_EXTENSIONS.has(extname(relativePath).toLowerCase());
}

function splitOversizedLine(line: string, chunkLength: number): string[] {
  if (!line) {
    return [];
  }

  if (line.length <= chunkLength) {
    return [line];
  }

  const parts: string[] = [];
  for (let index = 0; index < line.length; index += chunkLength) {
    parts.push(line.slice(index, index + chunkLength));
  }
  return parts;
}

function normalizeCollectionName(collectionName: string): string {
  const trimmed = collectionName.trim();
  if (!trimmed) {
    throw new Error("collectionName 不能为空字符串");
  }

  return trimmed;
}

function sanitizeFileName(fileName: string): string {
  const normalized = fileName.trim().replace(/[/\\:*?"<>|]+/g, "-");
  return normalized.length > 0 ? normalized : "upload.txt";
}

function toArrayBuffer(content: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (content instanceof ArrayBuffer) {
    return content.slice(0);
  }

  return Uint8Array.from(content).buffer;
}

function readStringField(metadata: JsonObject | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readNumberField(metadata: JsonObject | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBooleanField(metadata: JsonObject | undefined, key: string): boolean | undefined {
  const value = metadata?.[key];
  return typeof value === "boolean" ? value : undefined;
}