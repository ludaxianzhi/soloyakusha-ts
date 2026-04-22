/**
 * 定义 LLM 子系统共享的配置、请求结果与错误类型。
 *
 * 类型分类：
 * - 配置类：LlmClientConfig、LlmRequestConfig
 * - 响应类：CompletionResponseStatistics
 * - 日志类：CompletionLogEntry、ErrorLogEntry
 * - 钩子类：RequestObserver、ClientHooks
 */

export type LlmProvider = "openai" | "anthropic";

export type LlmModelType = "chat" | "embedding";

export type PcaEmbeddingConfig = {
  enabled: boolean;
  weightsFilePath?: string;
};

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type LlmRequestConfig = {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  extraBody?: JsonObject;
};

export type LlmRequestConfigInput = Partial<LlmRequestConfig>;

export type LlmRequestMetadata = {
  label: string;
  feature: string;
  operation: string;
  component?: string;
  workflow?: string;
  stage?: string;
  context?: JsonObject;
};

export type LlmClientConfig = {
  provider: LlmProvider;
  modelName: string;
  apiKey: string;
  endpoint: string;
  qps?: number;
  maxParallelRequests?: number;
  modelType: LlmModelType;
  retries: number;
  defaultRequestConfig?: LlmRequestConfig;
  supportsStructuredOutput?: boolean;
  pca?: PcaEmbeddingConfig;
};

export type LlmClientConfigInput = {
  provider?: LlmProvider;
  modelName: string;
  apiKey?: string;
  apiKeyEnv?: string;
  endpoint: string;
  qps?: number;
  maxParallelRequests?: number;
  modelType?: LlmModelType;
  retries?: number;
  defaultRequestConfig?: LlmRequestConfigInput;
  supportsStructuredOutput?: boolean;
  pca?: PcaEmbeddingConfig;
};

export type CompletionResponseStatistics = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type LlmOutputValidationContext = {
  stageLabel?: string;
  sourceLineCount?: number;
  minLineRatio?: number;
  modelName?: string;
};

/**
 * 输出校验错误，用于 LLM 返回结果不符合预期时报错。
 */
export class LlmOutputValidationError extends Error {
  readonly stageLabel?: string;
  readonly sourceLineCount?: number;
  readonly outputLineCount?: number;
  readonly minLineRatio?: number;
  readonly modelName?: string;

  constructor(
    message: string,
    options: {
      stageLabel?: string;
      sourceLineCount?: number;
      outputLineCount?: number;
      minLineRatio?: number;
      modelName?: string;
    } = {},
  ) {
    super(message);
    this.name = "LlmOutputValidationError";
    this.stageLabel = options.stageLabel;
    this.sourceLineCount = options.sourceLineCount;
    this.outputLineCount = options.outputLineCount;
    this.minLineRatio = options.minLineRatio;
    this.modelName = options.modelName;
  }
}

/**
 * 模型思考流检测到死循环时抛出的错误。
 */
export class ThinkingLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThinkingLoopError";
  }
}

export type LlmOutputValidator = (
  responseText: string,
  context?: LlmOutputValidationContext,
) => void | Promise<void>;

export type ChatRequestOptions = {
  requestConfig?: LlmRequestConfigInput;
  outputValidator?: LlmOutputValidator;
  outputValidationContext?: LlmOutputValidationContext;
  meta?: LlmRequestMetadata;
};

export type CompletionLogEntry = {
  prompt: string;
  response: string;
  requestId: string;
  requestConfig?: LlmRequestConfig;
  meta?: LlmRequestMetadata;
  statistics?: CompletionResponseStatistics;
  modelName?: string;
  durationSeconds?: number;
  reasoning?: string;
};

export type ErrorLogEntry = {
  prompt: string;
  errorMessage: string;
  requestId: string;
  requestConfig?: LlmRequestConfig;
  meta?: LlmRequestMetadata;
  modelName?: string;
  durationSeconds?: number;
  responseBody?: string;
};

export type LlmRequestHistoryEntry = {
  version: 1;
  requestId: string;
  timestamp: string;
  type: "completion" | "error";
  source?: string;
  prompt: string;
  response?: string;
  errorMessage?: string;
  responseBody?: string;
  requestConfig?: LlmRequestConfig;
  meta?: LlmRequestMetadata;
  statistics?: CompletionResponseStatistics;
  modelName?: string;
  durationSeconds?: number;
  reasoning?: string;
};

export type RequestHistoryLogger = {
  logCompletion(entry: CompletionLogEntry): void | Promise<void>;
  logError(entry: ErrorLogEntry): void | Promise<void>;
};

export type RequestObserver = {
  onRequestStart?(event: {
    requestId: string;
    provider: LlmProvider;
    modelName: string;
  }): void;
  onRequestProgress?(event: {
    requestId: string;
    completionTextDelta?: string;
    completionTokens?: number;
    outputTokens?: number;
    thinkingTokens?: number;
  }): void;
  onRequestFinish?(event: {
    requestId: string;
    completionTokens?: number;
    outputTokens?: number;
    thinkingTokens?: number;
  }): void;
  onRequestError?(event: { requestId: string; errorMessage: string }): void;
};

export type ClientHooks = {
  historyLogger?: RequestHistoryLogger;
  requestObserver?: RequestObserver;
};

const DEFAULT_REQUEST_CONFIG: Required<
  Pick<LlmRequestConfig, "temperature" | "topP">
> = {
  temperature: 0.7,
  topP: 1,
};

export function resolveRequestConfig(
  override?: LlmRequestConfigInput,
  defaultConfig?: LlmRequestConfigInput,
): LlmRequestConfig {
  const merged: LlmRequestConfig = {
    ...DEFAULT_REQUEST_CONFIG,
    ...(defaultConfig ?? {}),
    ...(override ?? {}),
  };

  const defaultExtraBody = defaultConfig?.extraBody;
  const overrideExtraBody = override?.extraBody;
  if (defaultExtraBody && overrideExtraBody) {
    merged.extraBody = {
      ...defaultExtraBody,
      ...overrideExtraBody,
    };
  }

  return merged;
}

export function createLlmClientConfig(
  input: LlmClientConfigInput,
): LlmClientConfig {
  if (input.apiKey && input.apiKeyEnv) {
    throw new Error("apiKey 和 apiKeyEnv 只能配置其中一个");
  }

  const apiKey = input.apiKey ?? readEnvApiKey(input.apiKeyEnv);
  if (!apiKey) {
    throw new Error("必须配置 apiKey 或 apiKeyEnv 其中一个");
  }

  const normalizedPca =
    input.pca && input.pca.enabled
      ? {
          enabled: true,
          weightsFilePath: input.pca.weightsFilePath?.trim(),
        }
      : undefined;

  return {
    provider: input.provider ?? "openai",
    modelName: input.modelName,
    apiKey,
    endpoint: input.endpoint,
    qps: input.qps,
    maxParallelRequests: input.maxParallelRequests,
    modelType: input.modelType ?? "chat",
    retries: input.retries ?? 3,
    defaultRequestConfig: input.defaultRequestConfig
      ? resolveRequestConfig(input.defaultRequestConfig)
      : undefined,
    supportsStructuredOutput: input.supportsStructuredOutput === true,
    ...(normalizedPca ? { pca: normalizedPca } : {}),
  };
}

export function mergeLlmRequestMetadata(
  base: LlmRequestMetadata | undefined,
  override: LlmRequestMetadata | undefined,
): LlmRequestMetadata | undefined {
  if (!base) {
    return override;
  }

  if (!override) {
    return base;
  }

  const mergedContext =
    base.context || override.context
      ? {
          ...(base.context ?? {}),
          ...(override.context ?? {}),
        }
      : undefined;

  return {
    label: override.label,
    feature: override.feature,
    operation: override.operation,
    component: override.component ?? base.component,
    workflow: override.workflow ?? base.workflow,
    stage: override.stage ?? base.stage,
    context: mergedContext,
  };
}

function readEnvApiKey(apiKeyEnv?: string): string | undefined {
  if (!apiKeyEnv) {
    return undefined;
  }

  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(`环境变量 ${apiKeyEnv} 未设置`);
  }

  return apiKey;
}
