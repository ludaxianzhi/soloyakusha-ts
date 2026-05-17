import type { StyleLibrarySourceSummary } from "../config/types.ts";
import type { VectorSearchResult } from "../vector/types.ts";

export const STYLE_LIBRARY_RESOURCE_TYPE = "style-library";
export const STYLE_LIBRARY_COLLECTION_PREFIX = "stylelib__";

export type StyleLibraryEmbeddingState = "compatible" | "invalid" | "unknown";

export type StyleLibrarySummary = {
  name: string;
  displayName?: string;
  targetLanguage?: string;
  chunkLength?: number;
  embeddingFingerprint?: string;
  /** 绑定的嵌入预设名称。 */
  embeddingProfileName?: string;
  embeddingState: StyleLibraryEmbeddingState;
  invalidationReason?: string;
  managedByApp: boolean;
  sourceSummary?: StyleLibrarySourceSummary;
};

export type StyleLibraryCatalog = {
  libraries: StyleLibrarySummary[];
};

export type CreateStyleLibraryInput = {
  displayName?: string;
  targetLanguage: string;
  chunkLength: number;
  /** 绑定的嵌入预设名称。默认使用第一个可用的嵌入预设。 */
  embeddingProfileName?: string;
  managedByApp?: boolean;
};

export type ImportStyleLibraryInput = {
  fileName: string;
  content: Uint8Array | ArrayBuffer;
  formatName?: string;
};

export type StyleLibraryImportResult = {
  libraryName: string;
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
  chunks: StyleLibraryQueryChunkResult[];
  matches: StyleLibraryChunkMatch[];
};

export type StyleLibraryQueryOptions = {
  topKPerChunk?: number | "source-ratio";
};

export type DeleteStyleLibraryResult = {
  success: boolean;
};