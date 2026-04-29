/**
 * 定义翻译 Pipeline 与步骤工作队列。
 *
 * - `TranslationPipeline`：描述步骤顺序
 * - `TranslationStepWorkQueue`：步骤级调度队列门面
 *
 * Pipeline 语义：
 * - 同一文本块的步骤只依赖上一步
 * - 一个步骤中的文本块还可以依赖其他文本块在该步骤的当前状态
 * - 不同文本块、不同步骤可以并发调度
 *
 * @module project/pipeline
 */

import type { TranslationContextView } from "../context/context-view.ts";
import type { Glossary } from "../../glossary/glossary.ts";
import type {
  FragmentAuxDataPatch,
  FragmentEntry,
  PipelineStepStatus,
  ProjectCursor,
  TextFragment,
  WorkItemMetadata,
} from "../types.ts";

export type OrderedFragmentSnapshot = {
  chapterId: number;
  fragmentIndex: number;
};

export type TranslationPipelineRuntime = {
  getSourceText(chapterId: number, fragmentIndex: number): string;
  getTranslatedText(chapterId: number, fragmentIndex: number): string;
  getFragment(chapterId: number, fragmentIndex: number): FragmentEntry | undefined;
  getOrderedFragments(): OrderedFragmentSnapshot[];
  getGlossary(): Glossary | undefined;
  getRequirements(): string[];
  getCurrentCursor(): ProjectCursor;
};

export type PipelineDependencyResolution = {
  ready: boolean;
  metadata?: WorkItemMetadata;
  reason?: string;
};

export type TranslationPipelineStepDefinition = {
  id: string;
  description: string;
  buildInput(args: {
    chapterId: number;
    fragmentIndex: number;
    runtime: TranslationPipelineRuntime;
    previousStepOutput?: TextFragment;
  }): string;
  resolveDependencies?(args: {
    chapterId: number;
    fragmentIndex: number;
    stepId: string;
    runtime: TranslationPipelineRuntime;
    previousStepId?: string;
  }): PipelineDependencyResolution;
  buildContextView?(args: {
    chapterId: number;
    fragmentIndex: number;
    runtime: TranslationPipelineRuntime;
    metadata: WorkItemMetadata;
  }): TranslationContextView | undefined;
  requirements?: string[];
};

export type TranslationPipelineDefinition = {
  steps: TranslationPipelineStepDefinition[];
  finalStepId?: string;
};

export type TranslationStepQueueEntry = {
  stepId: string;
  chapterId: number;
  fragmentIndex: number;
  queueSequence: number;
  status: PipelineStepStatus;
  errorMessage?: string;
};

export type TranslationWorkItem = TranslationStepQueueEntry & {
  runId: string;
  inputText: string;
  contextView?: TranslationContextView;
  requirements: string[];
  metadata: WorkItemMetadata;
};

export type TranslationWorkResult = {
  runId: string;
  stepId: string;
  chapterId: number;
  fragmentIndex: number;
  outputText?: string;
  success?: boolean;
  errorMessage?: string;
  /** 处理器返回的辅助数据补丁，将合并到文本块的 aux_data_json。 */
  fragmentAuxDataPatch?: FragmentAuxDataPatch;
};

export type TranslationWorkQueueRuntime = {
  listStepQueueEntries(stepId: string): TranslationStepQueueEntry[];
  listReadyWorkItems(stepId: string): TranslationWorkItem[];
  dispatchReadyWorkItems(stepId: string): Promise<TranslationWorkItem[]>;
};

export class TranslationPipeline {
  readonly steps: TranslationPipelineStepDefinition[];
  readonly finalStepId: string;
  private readonly stepIndex = new Map<string, number>();

  constructor(definition: TranslationPipelineDefinition) {
    if (definition.steps.length === 0) {
      throw new Error("Pipeline 至少需要一个步骤");
    }

    this.steps = [...definition.steps];
    for (const [index, step] of this.steps.entries()) {
      if (this.stepIndex.has(step.id)) {
        throw new Error(`重复的 Pipeline 步骤 ID: ${step.id}`);
      }
      this.stepIndex.set(step.id, index);
    }

    this.finalStepId = definition.finalStepId ?? this.steps.at(-1)!.id;
    if (!this.stepIndex.has(this.finalStepId)) {
      throw new Error(`finalStepId 不存在于 Pipeline 中: ${this.finalStepId}`);
    }
  }

  getStep(stepId: string): TranslationPipelineStepDefinition {
    const step = this.steps[this.getStepIndex(stepId)];
    if (!step) {
      throw new Error(`未找到 Pipeline 步骤: ${stepId}`);
    }

    return step;
  }

  getStepIndex(stepId: string): number {
    const stepIndex = this.stepIndex.get(stepId);
    if (typeof stepIndex !== "number") {
      throw new Error(`未找到 Pipeline 步骤: ${stepId}`);
    }

    return stepIndex;
  }

  getPreviousStepId(stepId: string): string | undefined {
    const stepIndex = this.getStepIndex(stepId);
    return stepIndex > 0 ? this.steps[stepIndex - 1]?.id : undefined;
  }

  getNextStepId(stepId: string): string | undefined {
    const stepIndex = this.getStepIndex(stepId);
    return this.steps[stepIndex + 1]?.id;
  }
}

export class TranslationStepWorkQueue {
  constructor(
    readonly stepId: string,
    private readonly runtime: TranslationWorkQueueRuntime,
  ) {}

  getEntries(): TranslationStepQueueEntry[] {
    return this.runtime.listStepQueueEntries(this.stepId);
  }

  getReadyItems(): TranslationWorkItem[] {
    return this.runtime.listReadyWorkItems(this.stepId);
  }

  async dispatchReadyItems(): Promise<TranslationWorkItem[]> {
    return this.runtime.dispatchReadyWorkItems(this.stepId);
  }
}
