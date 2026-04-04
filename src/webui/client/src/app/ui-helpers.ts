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
      defaultRequestConfigYaml: stringifyYaml(profile.defaultRequestConfig),
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
    requestOptionsYaml: stringifyYaml(config.requestOptions),
  };
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

export function translatorFieldName(key: string): string {
  return `translatorField__${key.replaceAll('.', '__')}`;
}

export function translatorToForm(
  translator: TranslatorEntry | null,
  translatorName: string | undefined,
  workflow: TranslationProcessorWorkflowMetadata | undefined,
): Record<string, string | number | undefined> {
  if (!translator) {
    return {
      translatorName,
      type: workflow?.workflow ?? 'default',
    };
  }

  const values: Record<string, string | number | undefined> = {
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
    modelName: '',
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
): string | number | undefined {
  switch (field.input) {
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

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
