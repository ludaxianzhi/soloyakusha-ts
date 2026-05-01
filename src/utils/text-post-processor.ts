/**
 * 文本后处理工具接口及基础类型定义。
 */

export interface TextPostProcessorContext {
  originalText: string;
}

export interface TextPostProcessor {
  name: string;
  process(translatedText: string, context: TextPostProcessorContext): string;
}

/**
 * 文本后处理管理器，支持组合多个处理器。
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
 * 引号处理：将''和‘’替换成『』，将""和“”替换成「」（引号中间内容保留）
 */
export class QuoteConverterProcessor implements TextPostProcessor {
  name = "quote-converter";

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
  name = "period-inside-quote-remover";

  process(translatedText: string): string {
    // 匹配 。」 或 。』 并将其替换为 」 或 』
    return translatedText.replace(/。[」』]/g, (match) => match.slice(1));
  }
}

/**
 * 对话格式对齐：原文为 【{人名}】内容 ，翻译时保持一致
 */
export class SpeakerBracketAlignerProcessor implements TextPostProcessor {
  name = "speaker-bracket-aligner";

  private bracketRegex = /^【(.*?)】/;

  process(translatedText: string, context: TextPostProcessorContext): string {
    const originalMatch = context.originalText.match(this.bracketRegex);
    const translationMatch = translatedText.match(this.bracketRegex);

    // 情况 1：原文有【】，译文没有 -> 加上
    if (originalMatch && !translationMatch) {
      return `${originalMatch[0]}${translatedText}`;
    }

    // 情况 2：原文没有【】，译文有 -> 移除（除非译文内容本身就以【】开头，这种判断较模糊，通常认为是以原文为准）
    if (!originalMatch && translationMatch) {
      return translatedText.replace(this.bracketRegex, "");
    }

    // 情况 3：都有但人名不一致的情况（可选，暂不处理人名翻译，仅处理括号结构存在性）
    return translatedText;
  }
}
