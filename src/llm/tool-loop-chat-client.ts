import { ChatClient } from "./base.ts";
import type {
  ChatRequestOptions,
  ChatResponse,
  ClientHooks,
  JsonValue,
  LlmConversationMessage,
  LlmToolCall,
  LlmToolChoice,
  LlmToolDefinition,
} from "./types.ts";

const DEFAULT_MAX_TOOL_ITERATIONS = 8;

export type ToolLoopExecutionContext = {
  iteration: number;
  toolCall: LlmToolCall;
  messages: ReadonlyArray<LlmConversationMessage>;
};

export type ToolExecutionResult =
  | string
  | JsonValue
  | {
      content: string;
      isError?: boolean;
    };

export type CallableLlmTool = LlmToolDefinition & {
  execute(
    argumentsValue: JsonValue | undefined,
    context: ToolLoopExecutionContext,
  ): ToolExecutionResult | Promise<ToolExecutionResult>;
};

export type ToolLoopChatClientOptions = {
  tools: ReadonlyArray<CallableLlmTool>;
  maxIterations?: number;
  toolChoice?: LlmToolChoice;
};

export type ToolLoopRunResult = {
  response: ChatResponse;
  messages: ReadonlyArray<LlmConversationMessage>;
  iterations: number;
};

export class ToolLoopChatClient extends ChatClient {
  private readonly tools: ReadonlyArray<CallableLlmTool>;
  private readonly toolChoice?: LlmToolChoice;
  private readonly maxIterations: number;
  private readonly toolMap: ReadonlyMap<string, CallableLlmTool>;

  constructor(
    private readonly inner: ChatClient,
    options: ToolLoopChatClientOptions,
  ) {
    super(inner.config);
    this.tools = [...options.tools];
    this.toolChoice = options.toolChoice;
    this.maxIterations = options.maxIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
    this.toolMap = new Map(this.tools.map((tool) => [tool.name, tool] as const));
  }

  override setHistoryLogger(historyLogger?: ClientHooks["historyLogger"]): void {
    super.setHistoryLogger(historyLogger);
    this.syncHooksToInner();
  }

  override setRequestObserver(requestObserver?: ClientHooks["requestObserver"]): void {
    super.setRequestObserver(requestObserver);
    this.syncHooksToInner();
  }

  override async singleTurnRequest(
    prompt: string,
    options: ChatRequestOptions = {},
  ): Promise<string> {
    const result = await this.singleTurnResponse(prompt, options);
    return result.content;
  }

  override async singleTurnResponse(
    prompt: string,
    options: ChatRequestOptions = {},
  ): Promise<ChatResponse> {
    const result = await this.runConversation(
      [{ role: "user", content: prompt }],
      options,
    );
    return result.response;
  }

  override async conversationResponse(
    messages: ReadonlyArray<LlmConversationMessage>,
    options: ChatRequestOptions = {},
  ): Promise<ChatResponse> {
    const result = await this.runConversation(messages, options);
    return result.response;
  }

  override async close(): Promise<void> {
    await this.inner.close();
  }

  async runConversation(
    messages: ReadonlyArray<LlmConversationMessage>,
    options: ChatRequestOptions = {},
  ): Promise<ToolLoopRunResult> {
    const conversation = cloneConversation(messages);
    const advertisedTools = this.tools.map(toToolDefinition);

    for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
      const response = await this.inner.conversationResponse(conversation, {
        ...options,
        tools: advertisedTools,
        toolChoice: options.toolChoice ?? this.toolChoice,
      });

      if (response.toolCalls.length === 0) {
        return {
          response,
          messages: conversation,
          iterations: iteration,
        };
      }

      const normalizedToolCalls = response.toolCalls.map((toolCall, index) => ({
        ...toolCall,
        id: toolCall.id ?? `tool_call_${iteration}_${index + 1}_${toolCall.name}`,
      }));

      conversation.push({
        role: "assistant",
        content: response.content,
        toolCalls: normalizedToolCalls,
      });

      for (const toolCall of normalizedToolCalls) {
        const tool = this.toolMap.get(toolCall.name);
        if (!tool) {
          throw new Error(`未注册名为 '${toolCall.name}' 的 Tool 处理器`);
        }

        const context: ToolLoopExecutionContext = {
          iteration,
          toolCall,
          messages: conversation,
        };

        try {
          const output = await tool.execute(toolCall.arguments, context);
          const normalizedOutput = normalizeToolExecutionResult(output);
          conversation.push({
            role: "tool",
            content: normalizedOutput.content,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            isError: normalizedOutput.isError,
          });
        } catch (error) {
          conversation.push({
            role: "tool",
            content: formatToolExecutionError(error),
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            isError: true,
          });
        }
      }
    }

    throw new Error(`Tool 调用循环超过最大轮数限制 (${this.maxIterations})`);
  }

  private syncHooksToInner(): void {
    this.inner.setHistoryLogger(this.historyLogger);
    this.inner.setRequestObserver(this.requestObserver);
  }
}

export function createToolLoopChatClient(
  client: ChatClient,
  options: ToolLoopChatClientOptions,
): ToolLoopChatClient {
  return new ToolLoopChatClient(client, options);
}

function cloneConversation(
  messages: ReadonlyArray<LlmConversationMessage>,
): LlmConversationMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || !message.toolCalls) {
      return { ...message };
    }

    return {
      ...message,
      toolCalls: message.toolCalls.map((toolCall) => ({ ...toolCall })),
    };
  });
}

function normalizeToolExecutionResult(
  result: ToolExecutionResult,
): {
  content: string;
  isError?: boolean;
} {
  if (typeof result === "string") {
    return {
      content: result,
    };
  }

  if (
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    "content" in result &&
    typeof result.content === "string"
  ) {
    return {
      content: result.content,
      isError: result.isError === true,
    };
  }

  return {
    content: JSON.stringify(result, null, 2),
  };
}

function formatToolExecutionError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function toToolDefinition(tool: CallableLlmTool): LlmToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}
