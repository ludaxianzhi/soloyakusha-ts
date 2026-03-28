import type {
  GlossaryExtractorConfig,
  GlossaryUpdaterConfig,
  PlotSummaryConfig,
  TranslationProcessorConfig,
} from '../../project/config.ts';
import type { FormFieldDef, SelectItem } from '../types.ts';

export function buildLlmOptions(
  profileNames: string[],
  defaultProfileName: string,
): SelectItem[] {
  return profileNames.length > 0
    ? profileNames.map((name) => ({
        label: name === defaultProfileName ? `${name} (默认)` : name,
        value: name,
      }))
    : [{ label: '(暂无可用 LLM 配置)', value: '' }];
}

export function buildTranslatorFields(
  config: TranslationProcessorConfig | undefined,
  llmOptions: SelectItem[],
): FormFieldDef[] {
  return [
    {
      key: 'modelName',
      label: 'LLM 配置',
      type: 'select',
      options: llmOptions,
      defaultValue: config?.modelName ?? llmOptions[0]?.value ?? '',
    },
    {
      key: 'workflow',
      label: '工作流',
      type: 'select',
      options: [{ label: 'default', value: 'default' }],
      defaultValue: config?.workflow ?? 'default',
    },
    {
      key: 'overlapChars',
      label: '滑窗重叠',
      type: 'text',
      placeholder: '留空使用默认，例如 64',
      defaultValue: config?.slidingWindow?.overlapChars
        ? String(config.slidingWindow.overlapChars)
        : '',
    },
  ];
}

export function buildGlossaryExtractorFields(
  config: GlossaryExtractorConfig | undefined,
  llmOptions: SelectItem[],
): FormFieldDef[] {
  return [
    {
      key: 'modelName',
      label: 'LLM 配置',
      type: 'select',
      options: llmOptions,
      defaultValue: config?.modelName ?? llmOptions[0]?.value ?? '',
    },
    {
      key: 'maxCharsPerBatch',
      label: '批次字符数',
      type: 'text',
      placeholder: '留空使用默认，例如 32768',
      defaultValue: config?.maxCharsPerBatch ? String(config.maxCharsPerBatch) : '',
    },
    {
      key: 'occurrenceTopK',
      label: '频次 Top K',
      type: 'text',
      placeholder: '例如 100',
      defaultValue: config?.occurrenceTopK ? String(config.occurrenceTopK) : '',
    },
    {
      key: 'occurrenceTopP',
      label: '频次 Top P',
      type: 'text',
      placeholder: '例如 0.2（前 20%）',
      defaultValue: config?.occurrenceTopP ? String(config.occurrenceTopP) : '',
    },
  ];
}

export function buildGlossaryUpdaterFields(
  config: GlossaryUpdaterConfig | undefined,
  llmOptions: SelectItem[],
): FormFieldDef[] {
  return [
    {
      key: 'modelName',
      label: 'LLM 配置',
      type: 'select',
      options: llmOptions,
      defaultValue: config?.modelName ?? llmOptions[0]?.value ?? '',
    },
    {
      key: 'workflow',
      label: '工作流',
      type: 'select',
      options: [{ label: 'default', value: 'default' }],
      defaultValue: config?.workflow ?? 'default',
    },
  ];
}

export function buildPlotSummaryFields(
  config: PlotSummaryConfig | undefined,
  llmOptions: SelectItem[],
): FormFieldDef[] {
  return [
    {
      key: 'modelName',
      label: 'LLM 配置',
      type: 'select',
      options: llmOptions,
      defaultValue: config?.modelName ?? llmOptions[0]?.value ?? '',
    },
    {
      key: 'fragmentsPerBatch',
      label: '每批片段数',
      type: 'text',
      placeholder: '留空使用默认，例如 12',
      defaultValue: config?.fragmentsPerBatch ? String(config.fragmentsPerBatch) : '',
    },
    {
      key: 'maxContextSummaries',
      label: '上下文总结数',
      type: 'text',
      placeholder: '留空使用默认，例如 50',
      defaultValue: config?.maxContextSummaries ? String(config.maxContextSummaries) : '',
    },
  ];
}

export function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseOptionalPositiveIntegerField(
  value: string | undefined,
  label: string,
): { ok: true; value: number | undefined } | { ok: false; message: string } {
  if (!value?.trim()) {
    return { ok: true, value: undefined };
  }

  const normalized = value.trim();
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== normalized || parsed <= 0) {
    return { ok: false, message: `${label} 必须是正整数` };
  }

  return { ok: true, value: parsed };
}

export function parseOptionalUnitIntervalField(
  value: string | undefined,
  label: string,
): { ok: true; value: number | undefined } | { ok: false; message: string } {
  if (!value?.trim()) {
    return { ok: true, value: undefined };
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    return { ok: false, message: `${label} 必须大于 0 且不超过 1` };
  }

  return { ok: true, value: parsed };
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
