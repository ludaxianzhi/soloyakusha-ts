import type {
  AlignmentRepairConfig,
  GlossaryExtractorConfig,
  GlossaryUpdaterConfig,
  PlotSummaryConfig,
  TranslationProcessorConfig,
} from '../../project/config.ts';
import type { FormFieldDef, SelectItem } from '../types.ts';
import type { ChatRequestOptions, JsonObject, JsonValue } from '../../llm/types.ts';
import YAML from 'yaml';

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
    return [
      ...baseFields,
      ...buildChatRequestOptionFields(config?.requestOptions),
    ];
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
    ...buildChatRequestOptionFields(config?.requestOptions),
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

export function buildAlignmentRepairFields(
  config: AlignmentRepairConfig | undefined,
  llmOptions: SelectItem[],
): FormFieldDef[] {
  return [
    {
      key: 'modelName',
      label: 'LLM 配置',
      type: 'select',
      options: llmOptions,
      defaultValue: config?.modelName ?? llmOptions[0]?.value ?? '',
      description: '用于对齐补翻的 Chat LLM（补全行数不一致时漏翻的原文行）。',
    },
  ];
}

export function buildChatRequestOptionFields(
  requestOptions: ChatRequestOptions | undefined,
): FormFieldDef[] {
  return [
    {
      key: 'requestSystemPrompt',
      label: '请求系统提示词',
      type: 'textarea',
      placeholder: '可选，留空则不设置',
      defaultValue: requestOptions?.requestConfig?.systemPrompt ?? '',
    },
    {
      key: 'requestTemperature',
      label: '请求 Temperature',
      type: 'text',
      placeholder: '可选，例如 0.7',
      defaultValue: formatOptionalNumber(requestOptions?.requestConfig?.temperature),
    },
    {
      key: 'requestTopP',
      label: '请求 Top P',
      type: 'text',
      placeholder: '可选，例如 1',
      defaultValue: formatOptionalNumber(requestOptions?.requestConfig?.topP),
    },
    {
      key: 'requestMaxTokens',
      label: '请求 Max Tokens',
      type: 'text',
      placeholder: '可选，留空则请求中不带该字段',
      defaultValue: formatOptionalNumber(requestOptions?.requestConfig?.maxTokens),
    },
    {
      key: 'requestExtraBody',
      label: '请求 Extra Body (YAML)',
      type: 'textarea',
      placeholder: '例如:\nchat_template_kwargs:\n  enable_thinking: false',
      defaultValue: formatExtraBodyYaml(requestOptions?.requestConfig?.extraBody),
    },
    {
      key: 'validationStageLabel',
      label: '校验阶段标签',
      type: 'text',
      placeholder: '可选，例如 translator',
      defaultValue: requestOptions?.outputValidationContext?.stageLabel ?? '',
    },
    {
      key: 'validationSourceLineCount',
      label: '校验原文行数',
      type: 'text',
      placeholder: '可选，例如 120',
      defaultValue: formatOptionalNumber(requestOptions?.outputValidationContext?.sourceLineCount),
    },
    {
      key: 'validationMinLineRatio',
      label: '校验最小行数比例',
      type: 'text',
      placeholder: '可选，例如 0.9',
      defaultValue: formatOptionalNumber(requestOptions?.outputValidationContext?.minLineRatio),
    },
    {
      key: 'validationModelName',
      label: '校验模型名',
      type: 'text',
      placeholder: '可选，覆盖日志上下文中的模型名',
      defaultValue: requestOptions?.outputValidationContext?.modelName ?? '',
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

export function parseOptionalFiniteNumberField(
  value: string | undefined,
  label: string,
): { ok: true; value: number | undefined } | { ok: false; message: string } {
  if (!value?.trim()) {
    return { ok: true, value: undefined };
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return { ok: false, message: `${label} 必须是合法数字` };
  }

  return { ok: true, value: parsed };
}

export function parseChatRequestOptionsFromValues(
  values: Record<string, string>,
): { ok: true; value: ChatRequestOptions | undefined } | { ok: false; message: string } {
  const temperature = parseOptionalFiniteNumberField(values.requestTemperature, '请求 Temperature');
  if (!temperature.ok) {
    return temperature;
  }

  const topP = parseOptionalFiniteNumberField(values.requestTopP, '请求 Top P');
  if (!topP.ok) {
    return topP;
  }

  const maxTokens = parseOptionalIntegerField(values.requestMaxTokens);
  if (maxTokens === undefined && values.requestMaxTokens?.trim()) {
    return { ok: false, message: '请求 Max Tokens 必须是整数' };
  }

  const extraBody = parseOptionalYamlJsonObject(values.requestExtraBody, '请求 Extra Body');
  if (!extraBody.ok) {
    return extraBody;
  }

  const sourceLineCount = parseOptionalFiniteNumberField(
    values.validationSourceLineCount,
    '校验原文行数',
  );
  if (!sourceLineCount.ok) {
    return sourceLineCount;
  }

  const minLineRatio = parseOptionalFiniteNumberField(
    values.validationMinLineRatio,
    '校验最小行数比例',
  );
  if (!minLineRatio.ok) {
    return minLineRatio;
  }

  const systemPrompt = values.requestSystemPrompt ?? '';
  const stageLabel = values.validationStageLabel?.trim() ?? '';
  const modelName = values.validationModelName?.trim() ?? '';

  const requestConfig = {
    ...(systemPrompt.trim() ? { systemPrompt } : {}),
    ...(temperature.value !== undefined ? { temperature: temperature.value } : {}),
    ...(topP.value !== undefined ? { topP: topP.value } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(extraBody.value !== undefined ? { extraBody: extraBody.value } : {}),
  };

  const outputValidationContext = {
    ...(stageLabel ? { stageLabel } : {}),
    ...(sourceLineCount.value !== undefined ? { sourceLineCount: sourceLineCount.value } : {}),
    ...(minLineRatio.value !== undefined ? { minLineRatio: minLineRatio.value } : {}),
    ...(modelName ? { modelName } : {}),
  };

  if (
    Object.keys(requestConfig).length === 0 &&
    Object.keys(outputValidationContext).length === 0
  ) {
    return { ok: true, value: undefined };
  }

  return {
    ok: true,
    value: {
      ...(Object.keys(requestConfig).length > 0 ? { requestConfig } : {}),
      ...(Object.keys(outputValidationContext).length > 0
        ? { outputValidationContext }
        : {}),
    },
  };
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseOptionalIntegerField(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const normalized = value.trim();
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== normalized) {
    return undefined;
  }

  return parsed;
}

function parseOptionalYamlJsonObject(
  value: string | undefined,
  label: string,
): { ok: true; value: JsonObject | undefined } | { ok: false; message: string } {
  if (!value?.trim()) {
    return { ok: true, value: undefined };
  }

  try {
    const parsed = YAML.parse(normalizeYamlIndentation(value));
    if (!isPlainObject(parsed)) {
      return { ok: false, message: `${label} 必须是 YAML 对象` };
    }

    return {
      ok: true,
      value: normalizeJsonObject(parsed, label),
    };
  } catch (error) {
    return {
      ok: false,
      message: `${label} YAML 解析失败：${toErrorMessage(error)}`,
    };
  }
}

function normalizeYamlIndentation(value: string): string {
  return value.replace(/(^|\n)(\t+)/g, (_match, prefix: string, tabs: string) => {
    return `${prefix}${'  '.repeat(tabs.length)}`;
  });
}

function normalizeJsonObject(value: Record<string, unknown>, source: string): JsonObject {
  const result: JsonObject = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    result[key] = normalizeJsonValue(nestedValue, `${source}.${key}`);
  }
  return result;
}

function normalizeJsonValue(
  value: unknown,
  source: string,
): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeJsonValue(item, `${source}[${index}]`));
  }

  if (isPlainObject(value)) {
    return normalizeJsonObject(value, source);
  }

  throw new Error(`${source} 必须符合 JSON 嵌套结构`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatOptionalNumber(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

function formatExtraBodyYaml(value: JsonObject | undefined): string {
  return value ? YAML.stringify(value).trimEnd() : '';
}

function normalizeTranslatorWorkflow(workflow: string | undefined): TranslatorWorkflowType {
  return workflow === 'multi-stage' ? 'multi-stage' : 'default';
}
