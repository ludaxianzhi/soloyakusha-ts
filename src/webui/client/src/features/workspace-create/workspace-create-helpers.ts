import type { ApiError } from '../../app/api.ts';
import { DEFAULT_ARCHIVE_IMPORT_PATTERN } from '../../app/ui-helpers.ts';

export interface WorkspaceCreateFormValues {
  projectName?: string;
  pipelineStrategy?: 'default' | 'context-network';
  importFormat?: string;
  importPattern?: string;
  textSplitMaxChars?: number;
  batchFragmentCount?: number;
  translatorName?: string;
  manifestJson?: string;
}

export interface WorkspaceCreateManifestState {
  hasValue: boolean;
  isValid: boolean;
  error?: string;
  overrideKeys: string[];
}

export type WorkspaceTranslationImportMode = 'source-only' | 'with-translation';

export type WorkspaceTranslationChoiceError = {
  code: 'translation-choice-required';
  translatedFileCount?: number;
  translatedUnitCount?: number;
  error?: string;
};

export const WORKSPACE_CREATE_INITIAL_VALUES: WorkspaceCreateFormValues = {
  projectName: '新建项目',
  pipelineStrategy: 'default',
  importPattern: DEFAULT_ARCHIVE_IMPORT_PATTERN,
  textSplitMaxChars: 800,
  batchFragmentCount: 3,
};

export const WORKSPACE_MANIFEST_EXAMPLE = `{
  "projectName": "某轻小说项目",
  "pipelineStrategy": "default",
  "translatorName": "ja-zhCN-default",
  "importFormat": "naturedialog",
  "importPattern": "scenario/**/*.txt",
  "textSplitMaxChars": 800,
  "batchFragmentCount": 3,
  "translationImportMode": "source-only"
}`;

const MANIFEST_OVERRIDE_KEYS = [
  'projectName',
  'pipelineStrategy',
  'chapterPaths',
  'branches',
  'glossaryPath',
  'importFormat',
  'importPattern',
  'textSplitMaxChars',
  'batchFragmentCount',
  'translationImportMode',
  'translatorName',
] as const;

export function analyzeManifestJson(value: unknown): WorkspaceCreateManifestState {
  const text = String(value ?? '').trim();
  if (!text) {
    return {
      hasValue: false,
      isValid: true,
      overrideKeys: [],
    };
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        hasValue: true,
        isValid: false,
        error: 'Manifest JSON 必须是对象',
        overrideKeys: [],
      };
    }
    const overrideKeys = MANIFEST_OVERRIDE_KEYS.filter((key) => key in parsed);
    return {
      hasValue: true,
      isValid: true,
      overrideKeys,
    };
  } catch (error) {
    return {
      hasValue: true,
      isValid: false,
      error: error instanceof Error ? error.message : 'Manifest JSON 解析失败',
      overrideKeys: [],
    };
  }
}

export function validateManifestJson(value: unknown): Promise<void> {
  const manifestState = analyzeManifestJson(value);
  return manifestState.isValid
    ? Promise.resolve()
    : Promise.reject(new Error(manifestState.error ?? 'Manifest JSON 无效'));
}

export function getWorkspaceTranslationChoiceError(
  error: unknown,
): WorkspaceTranslationChoiceError | null {
  if (!isApiError(error)) {
    return null;
  }
  if (
    typeof error.data !== 'object' ||
    error.data === null ||
    (error.data as { code?: unknown }).code !== 'translation-choice-required'
  ) {
    return null;
  }
  return error.data as WorkspaceTranslationChoiceError;
}

function isApiError(error: unknown): error is ApiError {
  return error instanceof Error && error.name === 'ApiError' && 'status' in error;
}
