/**
 * 文本后处理工具接口及基础类型定义。
 */

export interface TextPostProcessorContext {
  originalText: string;
}

export interface TextPostProcessorDescriptor {
  id: string;
  name: string;
  description: string;
}

export interface TextPostProcessor extends TextPostProcessorDescriptor {
  process(translatedText: string, context: TextPostProcessorContext): string;
}

/**
 * 文本后处理管理器，支持组合多个处理。
 */
export class TextPostProcessingPipeline {
  private processors: TextPostProcessor[] = [];

  constructor(processors: TextPostProcessor[] = []) {
    this.processors = processors;
  }

  addProcessor(processor: TextPostProcessor): this {
    this.processors.push(processor);
    return this;
  }

  /**
   * 处理单条文本
   */
  process(translatedText: string, originalText: string): string {
    let result = translatedText;
    const context: TextPostProcessorContext = { originalText };
    for (const processor of this.processors) {
      result = processor.process(result, context);
    }
    return result;
  }

  /**
   * 批量处理文本
   */
  processBatch(inputs: { original: string; translated: string }[]): string[] {
    return inputs.map(input => this.process(input.translated, input.original));
  }
}

/**
 * 后处理器工厂注册中心
 */
/**
 * 引号处理：将''和‘’替换成『』，将""和“”替换成「」（引号中间内容保留）
 */
export class QuoteConverterProcessor implements TextPostProcessor {
  id = "quote-converter";
  name = "引号转换";
  description = "将单引号转换为『』，双引号转换为「」";

  process(translatedText: string): string {
    let result = translatedText;
    // 双引号替换为 「」
    result = result.replace(/["“](.*?)["”]/g, "「$1」");
    // 单引号替换为 『』
    result = result.replace(/['‘](.*?)['’]/g, "『$1』");
    return result;
  }
}

/**
 * 引号前句号处理：将 "。』" 或 "。」" 形式中位于结尾符号前的句号移除
 */
export class PeriodInsideQuoteRemoverProcessor implements TextPostProcessor {
  id = "period-inside-quote-remover";
  name = "句号位置修正";
  description = "移除位于方引号结尾（」或』）前的句号";

  process(translatedText: string): string {
    // 匹配 。」 或 。』 并将其替换为 」 或 』
    return translatedText.replace(/。[」』]/g, (match) => match.slice(1));
  }
}

/**
 * 对话格式对齐：原文为 【{人名}】内容 ，翻译时保持一致
 */
export class SpeakerBracketAlignerProcessor implements TextPostProcessor {
  id = "speaker-bracket-aligner";
  name = "对话括号对齐";
  description = "根据原文是否存在【人名】标识，自动补全或移除译文中的对应标识";

  private bracketRegex = /^【(.*?)】/;

  process(translatedText: string, context: TextPostProcessorContext): string {
    const originalMatch = context.originalText.match(this.bracketRegex);
    const translationMatch = translatedText.match(this.bracketRegex);

    // 情况 1：原文有【】，译文没有 -> 加上
    if (originalMatch && !translationMatch) {
      return originalMatch[0] + translatedText;
    }

    // 情况 2：原文没有【】，译文有 -> 移除
    if (!originalMatch && translationMatch) {
      return translatedText.replace(this.bracketRegex, "");
    }

    return translatedText;
  }
}

export class TextPostProcessorRegistry {
  private static processors: TextPostProcessor[] = [
    new QuoteConverterProcessor(),
    new PeriodInsideQuoteRemoverProcessor(),
    new SpeakerBracketAlignerProcessor(),
  ];

  static getAllDescriptors(): TextPostProcessorDescriptor[] {
    return this.processors.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description
    }));
  }

  static getProcessor(id: string): TextPostProcessor | undefined {
    return this.processors.find(p => p.id === id);
  }

  static createPipeline(ids: string[]): TextPostProcessingPipeline {
    const pipeline = new TextPostProcessingPipeline();
    for (const id of ids) {
      const processor = this.getProcessor(id);
      if (processor) {
        pipeline.addProcessor(processor);
      }
    }
    return pipeline;
  }
}


