import type {
  GlossaryExtractorConfig,
  GlossaryUpdaterConfig,
  PlotSummaryConfig,
  TranslationProcessorConfig,
} from '../../project/config.ts';
import type { FormFieldDef, SelectItem } from '../types.ts';

export type TranslatorWorkflowType = 'default' | 'multi-stage';

export const TRANSLATOR_WORKFLOW_OPTIONS: SelectItem<TranslatorWorkflowType>[] = [
  { label: 'default', value: 'default', description: '单步翻译（默认）' },
  {
    label: 'multi-stage',
    value: 'multi-stage',
    description: '多步骤文学翻译：分析→翻译→润色→[编辑+校对→修改]×N',
  },
];

export const MULTI_STAGE_STEP_LABELS: { key: string; label: string; description: string }[] = [
  { key: 'analyzer', label: 'LLM1 · 分析器', description: '分析场景、视角、风格和翻译难点' },
  { key: 'translator', label: 'LLM2 · 翻译器', description: '初步翻译' },
  { key: 'polisher', label: 'LLM3 · 润色师', description: '润色译文使其更自然' },
  { key: 'editor', label: 'LLM4 · 中文编辑', description: '指出表达问题并提供改进建议' },
  { key: 'proofreader', label: 'LLM5 · 校对专家', description: '校对理解错误（尊重文学性）' },
  { key: 'reviser', label: 'LLM6 · 修改器', description: '综合编辑和校对意见修改译文' },
];

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
  workflow: TranslatorWorkflowType = normalizeTranslatorWorkflow(config?.workflow),
): FormFieldDef[] {
  const baseFields: FormFieldDef[] = [
    {
      key: 'modelName',
      label: workflow === 'multi-stage' ? 'LLM 配置（默认，各步骤未指定时使用）' : 'LLM 配置',
      type: 'select',
      options: llmOptions,
      defaultValue: config?.modelName ?? llmOptions[0]?.value ?? '',
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

  if (workflow !== 'multi-stage') {
    return baseFields;
  }

  const multiStageFields: FormFieldDef[] = MULTI_STAGE_STEP_LABELS.map((step) => ({
    key: `model_${step.key}`,
    label: step.label,
    type: 'select',
    options: [
      { label: '(使用默认 LLM)', value: '' },
      ...llmOptions,
    ],
    defaultValue: config?.models?.[step.key] ?? '',
    description: step.description,
  }));

  return [
    ...baseFields,
    ...multiStageFields,
    {
      key: 'reviewIterations',
      label: '评审迭代次数',
      type: 'select',
      options: [
        { label: '(默认 2 次)', value: '' },
        { label: '1 次', value: '1' },
        { label: '2 次', value: '2' },
        { label: '3 次', value: '3' },
        { label: '4 次', value: '4' },
      ],
      defaultValue: config?.reviewIterations !== undefined
        ? String(config.reviewIterations)
        : '',
      description: '大步骤二（编辑+校对→修改）的重复次数。',
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

function normalizeTranslatorWorkflow(workflow: string | undefined): TranslatorWorkflowType {
  return workflow === 'multi-stage' ? 'multi-stage' : 'default';
}
