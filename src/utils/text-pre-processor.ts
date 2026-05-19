/**
 * 文本预处理器模块。
 *
 * 工作区可配置有序的预处理步骤，在翻译、校对等操作前对原文进行变换。
 * 结构仿照 text-post-processor.ts，但目前只定义一种预处理器类型：
 *
 * - TextReplacePreProcessor: 文本替换。支持 filterRegex 按行筛选、matchRegex 查找、replacement 替换。
 */
export interface TextPreProcessorDescriptor {
  id: string;
  name: string;
  description: string;
  paramsSchema?: ProcessorParamSchema;
}

import type {
  ProcessorParamDef,
  ProcessorParamSchema,
} from "./text-post-processor.ts";

export interface TextPreProcessor extends TextPreProcessorDescriptor {
  process(originalText: string): string;
}

export class TextPreProcessingPipeline {
  private processors: TextPreProcessor[] = [];

  constructor(processors: TextPreProcessor[] = []) {
    this.processors = processors;
  }

  addProcessor(processor: TextPreProcessor): this {
    this.processors.push(processor);
    return this;
  }

  process(originalText: string): string {
    let result = originalText;
    for (const processor of this.processors) {
      result = processor.process(result);
    }
    return result;
  }
}

export class TextReplacePreProcessor implements TextPreProcessor {
  id = "text-replace";
  name = "文本替换";
  description = "按行筛选并替换原文中的文本";

  private filterRegex?: string;
  private matchRegex: string;
  private replacement: string;

  constructor(params?: Record<string, unknown>) {
    this.filterRegex = params?.filterRegex as string | undefined;
    this.matchRegex = (params?.matchRegex as string) ?? '';
    this.replacement = (params?.replacement as string) ?? '';
  }

  process(originalText: string): string {
    if (!this.matchRegex) {
      console.log(`[PreProcess] TextReplacePreProcessor: matchRegex 为空，跳过处理`);
      return originalText;
    }

    const hasFilter = this.filterRegex && this.filterRegex.length > 0;
    let filterRe: RegExp | undefined;
    if (hasFilter) {
      try {
        filterRe = new RegExp(this.filterRegex!);
      } catch {
        console.log(`[PreProcess] TextReplacePreProcessor: filterRegex 无效，已跳过`);
        return originalText;
      }
    }

    let matchRe: RegExp;
    try {
      matchRe = new RegExp(this.matchRegex, 'g');
    } catch {
      console.log(`[PreProcess] TextReplacePreProcessor: matchRegex 无效，已跳过`);
      return originalText;
    }

    const inputLineCount = originalText.split('\n').length;
    const result = originalText
      .split('\n')
      .map((line) => {
        if (hasFilter && filterRe && !filterRe.test(line)) {
          return line;
        }
        return line.replace(matchRe, this.replacement);
      })
      .join('\n');
    const outputLineCount = result.split('\n').length;
    console.log(
      `[PreProcess] TextReplacePreProcessor: match=/${this.matchRegex}/g filter=/${this.filterRegex ?? ''}/ repl="${this.replacement}" ` +
      `lines=${inputLineCount}→${outputLineCount} chars=${originalText.length}→${result.length}`,
    );
    return result;
  }
}

export const textReplaceParamsSchema: ProcessorParamSchema = {
  type: 'object',
  properties: {
    filterRegex: {
      type: 'string',
      title: '筛选 Regex',
      description: '可选。只对匹配的原文行执行替换。',
      default: '',
      placeholder: '例如：登场|退场',
    },
    matchRegex: {
      type: 'string',
      title: '匹配 Regex',
      description: '原文中需要替换的文本。',
      placeholder: '例如：勇者(\\d+)',
    },
    replacement: {
      type: 'string',
      title: '替换目标值',
      description: '支持 $1、$2 等捕获组引用。留空时替换为空串。',
      default: '',
      placeholder: '例如：Hero-$1',
    },
  },
  required: ['matchRegex'],
};

export interface TextPreProcessorRegistration {
  id: string;
  name: string;
  description: string;
  paramsSchema?: ProcessorParamSchema;
  factory: (params?: Record<string, unknown>) => TextPreProcessor;
}

export class TextPreProcessorRegistry {
  private static registrations: TextPreProcessorRegistration[] = [
    {
      id: 'text-replace',
      name: '文本替换',
      description: '按行筛选并替换原文中的文本',
      paramsSchema: textReplaceParamsSchema,
      factory: (params) => new TextReplacePreProcessor(params),
    },
  ];

  static getAllDescriptors(): TextPreProcessorDescriptor[] {
    return this.registrations.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      paramsSchema: r.paramsSchema,
    }));
  }

  static getProcessor(id: string): TextPreProcessor | undefined {
    const reg = this.registrations.find((r) => r.id === id);
    return reg ? reg.factory() : undefined;
  }

  static createPipeline(
    steps: { id: string; params?: Record<string, unknown> }[],
  ): TextPreProcessingPipeline {
    console.log(`[PreProcess] createPipeline: steps=${steps.length}`, JSON.stringify(steps));
    const pipeline = new TextPreProcessingPipeline();
    for (const step of steps) {
      const reg = this.registrations.find((r) => r.id === step.id);
      if (reg) {
        console.log(`[PreProcess] createPipeline: 添加处理器 id=${step.id} params=${JSON.stringify(step.params)}`);
        pipeline.addProcessor(reg.factory(step.params));
      } else {
        console.log(`[PreProcess] createPipeline: 未找到注册 id=${step.id}`);
      }
    }
    return pipeline;
  }
}
