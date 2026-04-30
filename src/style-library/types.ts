import type { JsonObject } from "../llm/types.ts";
import type {
  PersistedStyleLibraryConfig,
  StyleLibrarySourceSummary,
} from "../config/types.ts";
import type { VectorSearchResult } from "../vector/types.ts";

export const STYLE_LIBRARY_RESOURCE_TYPE = "style-library";
export const STYLE_LIBRARY_COLLECTION_PREFIX = "stylelib__";

export type StyleLibraryEmbeddingState = "compatible" | "invalid" | "unknown";

export type StyleLibrarySummary = {
  name: string;
  displayName?: string;
  vectorStoreName: string;
  collectionName: string;
  targetLanguage?: string;
  chunkLength?: number;
  embeddingFingerprint?: string;
  embeddingState: StyleLibraryEmbeddingState;
  invalidationReason?: string;
  source: "registered" | "discovered";
  discoveryMode: PersistedStyleLibraryConfig["discoveryMode"];
  managedByApp: boolean;
  existsInVectorStore: boolean;
  metadata?: JsonObject;
  sourceSummary?: StyleLibrarySourceSummary;
};

export type StyleLibraryCatalog = {
  libraries: StyleLibrarySummary[];
  discoveryErrors: Record<string, string>;
};

export type CreateStyleLibraryInput = {
  displayName?: string;
  vectorStoreName: string;
  collectionName?: string;
  targetLanguage: string;
  chunkLength: number;
  managedByApp?: boolean;
  metadata?: JsonObject;
};

export type ImportStyleLibraryInput = {
  fileName: string;
  content: Uint8Array | ArrayBuffer;
  formatName?: string;
};

export type StyleLibraryImportResult = {
  libraryName: string;
  collectionName: string;
  importedFiles: string[];
  skippedFiles: string[];
  chunkCount: number;
  characterCount: number;
};

export type StyleLibraryChunkMatch = VectorSearchResult & {
  chunkIndex: number;
  queryText: string;
};

export type StyleLibraryQueryChunkResult = {
  chunkIndex: number;
  text: string;
  charCount: number;
  matches: StyleLibraryChunkMatch[];
};

export type StyleLibraryQueryResult = {
  libraryName: string;
  collectionName: string;
  chunks: StyleLibraryQueryChunkResult[];
  matches: StyleLibraryChunkMatch[];
};

export type StyleLibraryQueryOptions = {
  topKPerChunk?: number | "source-ratio";
};

export type DeleteStyleLibraryResult = {
  removedRegistry: boolean;
  removedCollection: boolean;
};