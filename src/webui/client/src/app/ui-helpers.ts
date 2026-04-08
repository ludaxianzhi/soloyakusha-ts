import YAML from 'yaml';
import type {
  AlignmentRepairConfig,
  GlossaryExtractorConfig,
  GlossaryUpdaterConfig,
  LlmProfileConfig,
  PlotSummaryConfig,
  TranslationProcessorWorkflowFieldMetadata,
  TranslationProcessorWorkflowMetadata,
  TranslatorEntry,
} from './types.ts';

export const IMPORT_FORMAT_OPTIONS = [
  { label: '自动/默认', value: '' },
  { label: '纯文本', value: 'plain_text' },
  { label: 'Nature Dialog', value: 'naturedialog' },
  { label: 'Nature Dialog (保留角色名)', value: 'naturedialog_keepname' },
  { label: 'M3T', value: 'm3t' },
  { label: 'GalTransl JSON', value: 'galtransl_json' },
];

export const DEFAULT_ARCHIVE_IMPORT_PATTERN = '**/*';

const HARD_CODED_LANGUAGE_PAIRS = [
  {
    label: '日语 (ja) -> 简体中文 (zh-CN)',
    value: 'ja->zh-CN',
    source: { label: '日语 (ja)', value: 'ja' },
    target: { label: '简体中文 (zh-CN)', value: 'zh-CN' },
  },
] as const;

export const LANGUAGE_PAIR_OPTIONS = HARD_CODED_LANGUAGE_PAIRS.map((pair) => ({
  label: pair.label,
  value: pair.value,
}));
export const DEFAULT_LANGUAGE_PAIR = HARD_CODED_LANGUAGE_PAIRS[0]?.value ?? 'ja->zh-CN';

export function resolveLanguagePair(pairValue: unknown): {
  srcLang: string;
  tgtLang: string;
} {
  const matchedPair = HARD_CODED_LANGUAGE_PAIRS.find((pair) => pair.value === pairValue);
  return {
    srcLang: matchedPair?.source.value ?? 'ja',
    tgtLang: matchedPair?.target.value ?? 'zh-CN',
  };
}

const LLM_REQUEST_CONFIG_KEY_ALIASES = {
  systemPrompt: ['systemPrompt', 'system_prompt'],
  temperature: ['temperature'],
  topP: ['topP', 'top_p'],
  maxTokens: ['maxTokens', 'max_tokens'],
  extraBody: ['extraBody', 'extra_body'],
} as const;

const RESERVED_LLM_REQUEST_CONFIG_KEYS = Object.keys(
  LLM_REQUEST_CONFIG_KEY_ALIASES,
) as Array<keyof typeof LLM_REQUEST_CONFIG_KEY_ALIASES>;

export function profileToForm(
  profile: LlmProfileConfig | null,
  name?: string,
): Record<string, {} | undefined> {
  if (!profile) {
    return {
      profileName: name,
      provider: 'openai',
      modelType: 'chat',
      retries: 2,
    };
  }
  return {
    profileName: name,
    provider: profile.provider,
    modelName: profile.modelName,
    apiKey: profile.apiKey,
    apiKeyEnv: profile.apiKeyEnv,
    endpoint: profile.endpoint,
    qps: profile.qps,
    maxParallelRequests: profile.maxParallelRequests,
    modelType: profile.modelType,
    retries: profile.retries,
    defaultRequestConfigYaml: formatLlmRequestConfigYaml(
      profile.defaultRequestConfig,
    ),
  };
}

export function auxToForm(
  config:
    | GlossaryExtractorConfig
    | GlossaryUpdaterConfig
    | PlotSummaryConfig
    | AlignmentRepairConfig
    | null,
): Record<string, {} | undefined> {
  if (!config) {
    return {};
  }
  return {
    ...config,
    modelNames: [...config.modelNames],
    requestOptionsYaml: stringifyYaml(config.requestOptions),
  };
}

export function normalizeModelChain(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: string[] = [];
  for (const item of value) {
    const normalized = optionalString(item);
    if (normalized && !result.includes(normalized)) {
      result.push(normalized);
    }
  }
  return result;
}

export function formatModelChain(modelNames: ReadonlyArray<string> | undefined): string {
  if (!modelNames || modelNames.length === 0) {
    return '-';
  }
  return modelNames.join(' -> ');
}

export function splitLines(value?: string): string[] {
  return (value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function optionalString(value: unknown): string | undefined {
  const next = String(value ?? '').trim();
  return next ? next : undefined;
}

export function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseYamlObject(
  value: unknown,
): Record<string, unknown> | undefined {
  const text = String(value ?? '').trim();
  if (!text) {
    return undefined;
  }
  const parsed = YAML.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('必须提供 YAML 对象');
  }
  return parsed as Record<string, unknown>;
}

export function parseLlmRequestConfigYaml(
  value: unknown,
): Record<string, unknown> | undefined {
  const parsed = parseYamlObject(value);
  if (!parsed) {
    return undefined;
  }

  const normalized: Record<string, unknown> = {};
  for (const key of RESERVED_LLM_REQUEST_CONFIG_KEYS) {
    const aliasMatch = getAliasedRequestConfigValue(parsed, key);
    if (key !== 'extraBody' && aliasMatch.value !== undefined) {
      normalized[key] = aliasMatch.value;
    }
  }

  const explicitExtraBody = getAliasedRequestConfigValue(
    parsed,
    'extraBody',
  ).value;
  if (explicitExtraBody !== undefined && !isRecord(explicitExtraBody)) {
    throw new Error('extraBody 必须是 YAML 对象');
  }

  const liftedExtraBodyEntries = Object.fromEntries(
    Object.entries(parsed).filter(
      ([key]) =>
        !Object.values(LLM_REQUEST_CONFIG_KEY_ALIASES).some((aliases) => {
          const knownAliases = aliases as readonly string[];
          return knownAliases.includes(key);
        }),
    ),
  );

  if (
    explicitExtraBody &&
    Object.keys(liftedExtraBodyEntries).some((key) => key in explicitExtraBody)
  ) {
    throw new Error('同一个请求参数不能同时出现在顶层和 extraBody 中');
  }

  const mergedExtraBody = {
    ...(explicitExtraBody ?? {}),
    ...liftedExtraBodyEntries,
  };
  if (Object.keys(mergedExtraBody).length > 0) {
    normalized.extraBody = mergedExtraBody;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function parseYamlStringMap(
  value: unknown,
): Record<string, string> | undefined {
  const parsed = parseYamlObject(value);
  if (!parsed) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item !== 'string') {
      throw new Error('步骤模型覆盖必须是 string map');
    }
    result[key] = item;
  }
  return result;
}

export function stringifyYaml(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
    return undefined;
  }
  return YAML.stringify(value).trimEnd();
}

export function formatLlmRequestConfigYaml(
  value: Record<string, unknown> | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }

  const flattened: Record<string, unknown> = {};
  for (const key of RESERVED_LLM_REQUEST_CONFIG_KEYS) {
    if (key !== 'extraBody' && value[key] !== undefined) {
      flattened[key] = value[key];
    }
  }

  const legacyTopLevelEntries = Object.fromEntries(
    Object.entries(value).filter(
      ([key]) =>
        !RESERVED_LLM_REQUEST_CONFIG_KEYS.includes(
          key as (typeof RESERVED_LLM_REQUEST_CONFIG_KEYS)[number],
        ),
    ),
  );
  Object.assign(flattened, legacyTopLevelEntries);

  const extraBody = value.extraBody;
  if (extraBody !== undefined) {
    flattened.extra_body = extraBody;
  }

  return stringifyYaml(flattened);
}

function getAliasedRequestConfigValue(
  source: Record<string, unknown>,
  canonicalKey: keyof typeof LLM_REQUEST_CONFIG_KEY_ALIASES,
): {
  value: unknown;
} {
  const aliases = LLM_REQUEST_CONFIG_KEY_ALIASES[canonicalKey];
  const matchedAliases = aliases.filter((alias) => source[alias] !== undefined);
  if (matchedAliases.length > 1) {
    throw new Error(`${matchedAliases.join(' / ')} 只能填写一个`);
  }
  const matchedAlias = matchedAliases[0];
  return {
    value: matchedAlias ? source[matchedAlias] : undefined,
  };
}

export function translatorFieldName(key: string): string {
  return `translatorField__${key.replaceAll('.', '__')}`;
}

export function translatorToForm(
  translator: TranslatorEntry | null,
  translatorName: string | undefined,
  workflow: TranslationProcessorWorkflowMetadata | undefined,
): Record<string, string | string[] | number | undefined> {
  if (!translator) {
    return {
      translatorName,
      type: workflow?.workflow ?? 'default',
    };
  }

  const values: Record<string, string | string[] | number | undefined> = {
    translatorName,
    type: translator.type ?? workflow?.workflow ?? 'default',
    metadataTitle: translator.metadata?.title,
    metadataDescription: translator.metadata?.description,
  };

  for (const field of workflow?.fields ?? []) {
    values[translatorFieldName(field.key)] = serializeWorkflowFieldValue(
      field,
      getNestedValue(translator, field.key),
    );
  }

  return values;
}

export function buildTranslatorPayload(
  values: Record<string, unknown>,
  workflow: TranslationProcessorWorkflowMetadata,
): TranslatorEntry {
  const payload: TranslatorEntry = {
    type: workflow.workflow === 'default' ? undefined : workflow.workflow,
    modelNames: [],
  };

  const metadataTitle = optionalString(values.metadataTitle);
  const metadataDescription = optionalString(values.metadataDescription);
  if (metadataTitle || metadataDescription) {
    payload.metadata = {
      title: metadataTitle,
      description: metadataDescription,
    };
  }

  for (const field of workflow.fields) {
    const parsed = parseWorkflowFieldValue(values[translatorFieldName(field.key)], field);
    if (parsed !== undefined) {
      setNestedValue(payload, field.key, parsed);
    }
  }

  return payload;
}

function serializeWorkflowFieldValue(
  field: TranslationProcessorWorkflowFieldMetadata,
  value: unknown,
): string | string[] | number | undefined {
  switch (field.input) {
    case 'llm-profile':
      return normalizeModelChain(value);
    case 'yaml':
      return stringifyYaml(value);
    default:
      return typeof value === 'number' ? value : optionalString(value);
  }
}

function parseWorkflowFieldValue(
  value: unknown,
  field: TranslationProcessorWorkflowFieldMetadata,
): unknown {
  switch (field.input) {
    case 'llm-profile':
      return normalizeModelChain(value);
    case 'number':
      return optionalNumber(value);
    case 'yaml':
      return field.yamlShape === 'string-map' ? parseYamlStringMap(value) : parseYamlObject(value);
    default:
      return optionalString(value);
  }
}

function getNestedValue(source: object, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, source);
}

function setNestedValue(target: object, path: string, value: unknown): void {
  const keys = path.split('.');
  let current = target as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    const nextValue = current[key];
    if (!nextValue || typeof nextValue !== 'object' || Array.isArray(nextValue)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const finalKey = keys.at(-1);
  if (!finalKey) {
    return;
  }
  current[finalKey] = value;
}

export function statusColor(status: string): string {
  switch (status) {
    case 'running':
      return 'processing';
    case 'completed':
      return 'success';
    case 'aborted':
      return 'error';
    case 'stopped':
    case 'stopping':
      return 'warning';
    default:
      return 'default';
  }
}

export function logColor(level: string): string {
  switch (level) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'success':
      return 'success';
    default:
      return 'processing';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
