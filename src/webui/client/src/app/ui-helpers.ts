import type {
  AlignmentRepairConfig,
  GlossaryExtractorConfig,
  GlossaryUpdaterConfig,
  LlmProfileConfig,
  PlotSummaryConfig,
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
    defaultRequestConfigJson: stringifyJson(profile.defaultRequestConfig),
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
    requestOptionsJson: stringifyJson(config.requestOptions),
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

export function parseJsonObject(
  value: unknown,
): Record<string, unknown> | undefined {
  const text = String(value ?? '').trim();
  if (!text) {
    return undefined;
  }
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('必须提供 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

export function parseJsonStringMap(
  value: unknown,
): Record<string, string> | undefined {
  const parsed = parseJsonObject(value);
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

export function stringifyJson(value: unknown): string | undefined {
  return value ? JSON.stringify(value, null, 2) : undefined;
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
