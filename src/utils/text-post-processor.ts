export interface TextPostProcessorContext {
  originalText: string;
}

export interface ProcessorParamDef {
  type: 'string' | 'number' | 'boolean';
  title: string;
  description?: string;
  default?: string | number | boolean;
  required?: boolean;
  placeholder?: string;
  minimum?: number;
  maximum?: number;
}

export interface ProcessorParamSchema {
  type: 'object';
  properties: Record<string, ProcessorParamDef>;
  required?: string[];
}

export interface TextPostProcessorDescriptor {
  id: string;
  name: string;
  description: string;
  paramsSchema?: ProcessorParamSchema;
}

export interface TextPostProcessor extends TextPostProcessorDescriptor {
  process(translatedText: string, context: TextPostProcessorContext): string;
}

export class TextPostProcessingPipeline {
  private processors: TextPostProcessor[] = [];

  constructor(processors: TextPostProcessor[] = []) {
    this.processors = processors;
  }

  addProcessor(processor: TextPostProcessor): this {
    this.processors.push(processor);
    return this;
  }

  process(translatedText: string, originalText: string): string {
    let result = translatedText;
    const context: TextPostProcessorContext = { originalText };
    for (const processor of this.processors) {
      result = processor.process(result, context);
    }
    return result;
  }

  processBatch(inputs: { original: string; translated: string }[]): string[] {
    return inputs.map(input => this.process(input.translated, input.original));
  }
}

export class QuoteConverterProcessor implements TextPostProcessor {
  id = "quote-converter";
  name = "引号转换";
  description = "将单引号转换为『』，双引号转换为「」";

  process(translatedText: string): string {
    let result = translatedText;
    result = result.replace(/["“](.*?)["”]/g, "「$1」");
    result = result.replace(/['‘](.*?)['’]/g, "『$1』");
    return result;
  }
}

export class PeriodInsideQuoteRemoverProcessor implements TextPostProcessor {
  id = "period-inside-quote-remover";
  name = "句号位置修正";
  description = "移除位于方引号结尾（」或』）前的句号";

  process(translatedText: string): string {
    return translatedText.replace(/。[」』]/g, (match) => match.slice(1));
  }
}

export class SpeakerBracketAlignerProcessor implements TextPostProcessor {
  id = "speaker-bracket-aligner";
  name = "对话括号对齐";
  description = "根据原文是否存在【人名】标识，自动补全或移除译文中的对应标识；并镜像原文消息部分的引号包裹状态";

  private static readonly QUOTE_PAIRS: [string, string][] = [
    ['「', '」'],
    ['『', '』'],
    ['"', '"'],
    ['\u201C', '\u201D'], // “ ”
    ["'", "'"],
    ['\u2018', '\u2019'], // ‘ ’
  ];

  private bracketRegex = /^【(.*?)】/;

  process(translatedText: string, context: TextPostProcessorContext): string {
    return this.mirrorQuotes(
      context.originalText,
      this.alignSpeakerBracket(translatedText, context.originalText),
    );
  }

  private alignSpeakerBracket(translatedText: string, originalText: string): string {
    const originalMatch = originalText.match(this.bracketRegex);
    const translationMatch = translatedText.match(this.bracketRegex);

    if (originalMatch && !translationMatch) {
      return originalMatch[0] + translatedText;
    }

    if (!originalMatch && translationMatch) {
      return translatedText.replace(this.bracketRegex, "");
    }

    return translatedText;
  }

  private mirrorQuotes(originalText: string, translatedText: string): string {
    const speakerMatch = translatedText.match(this.bracketRegex);

    const translatedHeader = speakerMatch ? speakerMatch[0] : '';
    const translatedMessage = speakerMatch ? translatedText.slice(speakerMatch[0].length) : translatedText;

    const origMatch = originalText.match(this.bracketRegex);
    const origMessage = origMatch ? originalText.slice(origMatch[0].length) : originalText;

    const origTrimmed = origMessage.trim();
    const transTrimmed = translatedMessage.trim();

    const origPair = this.findOuterQuotePair(origTrimmed);
    const transPair = this.findOuterQuotePair(transTrimmed);

    if (origPair !== null && transPair === null) {
      const leadingWS = translatedMessage.slice(0, translatedMessage.length - translatedMessage.trimStart().length);
      const trailingWS = translatedMessage.slice(translatedMessage.trimEnd().length);
      const [open, close] = origPair;
      return translatedHeader + leadingWS + open + transTrimmed + close + trailingWS;
    }

    if (origPair === null && transPair !== null) {
      const [open, close] = transPair;
      const inner = transTrimmed.slice(open.length, transTrimmed.length - close.length);
      const leadingWS = translatedMessage.slice(0, translatedMessage.length - translatedMessage.trimStart().length);
      const trailingWS = translatedMessage.slice(translatedMessage.trimEnd().length);
      return translatedHeader + leadingWS + inner + trailingWS;
    }

    return translatedText;
  }

  private findOuterQuotePair(text: string): [string, string] | null {
    if (text.length === 0) return null;
    for (const [open, close] of SpeakerBracketAlignerProcessor.QUOTE_PAIRS) {
      if (
        text.startsWith(open)
        && text.endsWith(close)
        && text.length > open.length + close.length
      ) {
        return [open, close];
      }
    }
    return null;
  }
}

export class CharacterReplaceProcessor implements TextPostProcessor {
  id = "character-replace";
  name = "字符替换";
  description = "根据正则表达式替换译文中的字符";

  private sourceRegex?: string;
  private translationRegex: string;
  private replacement: string;

  constructor(params?: Record<string, unknown>) {
    this.sourceRegex = params?.sourceRegex as string | undefined;
    this.translationRegex = (params?.translationRegex as string) ?? '';
    this.replacement = (params?.replacement as string) ?? '';
  }

  process(translatedText: string, context: TextPostProcessorContext): string {
    if (!this.translationRegex) return translatedText;

    if (this.sourceRegex) {
      try {
        if (!new RegExp(this.sourceRegex).test(context.originalText)) {
          return translatedText;
        }
      } catch {
        return translatedText;
      }
    }

    try {
      const regex = new RegExp(this.translationRegex, 'g');
      return translatedText.replace(regex, this.replacement);
    } catch {
      return translatedText;
    }
  }
}

export const characterReplaceParamsSchema: ProcessorParamSchema = {
  type: 'object',
  properties: {
    sourceRegex: {
      type: 'string',
      title: '原文 Regex',
      description: '可选。仅修改原文命中的译文。',
      default: '',
      placeholder: '例如：登场|退场',
    },
    translationRegex: {
      type: 'string',
      title: '译文 Regex',
      description: '用于匹配译文的表达式。',
      placeholder: '例如：勇者(\\d+)',
    },
    replacement: {
      type: 'string',
      title: '替换',
      description: '支持 $1、$2 等捕获组引用。',
      placeholder: '例如：Hero-$1',
    },
  },
  required: ['translationRegex', 'replacement'],
};

const RIGHT_SKIP_CHARS = new Set([
  '。', '．', '.', '，', ',', '、', '：', ':', '；', ';',
  '’', '\'', '”', '"',
  '」', '』', '】', '〕', '〗', '〉', '》',
  '）', ')', '］', ']', '｝', '}',
]);

const LEFT_SKIP_CHARS = new Set([
  '‘', '\'', '“', '"',
  '「', '『', '【', '〔', '〖', '〈', '《',
  '（', '(', '［', '[', '｛', '{',
]);

function isRightSkipChar(c: string): boolean {
  return RIGHT_SKIP_CHARS.has(c);
}

function isLeftSkipChar(c: string): boolean {
  return LEFT_SKIP_CHARS.has(c);
}

function isHalfWidthChar(c: string): boolean {
  const code = c.charCodeAt(0);
  return (code >= 0x20 && code <= 0x7E) || (code >= 0xFF61 && code <= 0xFF9F);
}

function getCharWidth(c: string): number {
  if (isRightSkipChar(c) || isLeftSkipChar(c)) return 0;
  if (isHalfWidthChar(c)) return 0.5;
  return 1;
}

function getStringWidth(s: string): number {
  let w = 0;
  for (const c of s) {
    w += getCharWidth(c);
  }
  return w;
}

function findSpaceWordBreak(line: string): number {
  let end = line.length - 1;
  while (end >= 0 && line[end] === ' ') end--;
  if (end < 0) return -1;
  const lastSpace = line.lastIndexOf(' ', end);
  if (lastSpace < 0) return -1;
  const rest = line.substring(lastSpace + 1, end + 1);
  if (rest.length === 0) return -1;
  for (const ch of rest) {
    if (!isHalfWidthChar(ch)) return -1;
  }
  return lastSpace + 1;
}

export class NewlineAddProcessor implements TextPostProcessor {
  id = "newline-add";
  name = "换行添加";
  description = "在指定长度处自动换行";

  private lineLength: number;
  private lineBreak: string;
  private trailingSpecialChar: string;

  constructor(params?: Record<string, unknown>) {
    this.lineLength = (params?.lineLength as number) ?? 40;
    this.lineBreak = (params?.lineBreak as string) ?? '\n';
    this.trailingSpecialChar = (params?.trailingSpecialChar as string) ?? '';
  }

  process(text: string): string {
    const maxLen = this.lineLength;
    if (maxLen <= 0) return text;
    const brk = this.lineBreak;
    const trail = this.trailingSpecialChar;

    const lines: string[] = [];
    let curLine = '';
    let curWidth = 0;
    let rightBreak = -1;
    let leftBreak = -1;

    const emit = (content: string) => {
      lines.push(content);
    };

    for (const c of text) {
      if (isRightSkipChar(c)) {
        curLine += c;
        rightBreak = curLine.length;
        leftBreak = -1;
        continue;
      }

      if (isLeftSkipChar(c)) {
        curLine += c;
        if (curWidth > 0 && leftBreak < 0) {
          leftBreak = curLine.length - 1;
        }
        continue;
      }

      const w = getCharWidth(c);

      if (curWidth + w > maxLen && curLine.length > 0) {
        let bp = -1;

        if (rightBreak >= 0) {
          bp = rightBreak;
        } else if (w === 0.5) {
          bp = findSpaceWordBreak(curLine);
        } else if (leftBreak >= 0) {
          bp = leftBreak;
        }

        if (bp >= 0) {
          const prefix = curLine.substring(0, bp);
          const suffix = curLine.substring(bp);
          if (prefix.trim().length > 0) {
            emit(prefix);
          }
          curLine = suffix + c;
          curWidth = getStringWidth(suffix) + w;
        } else {
          emit(curLine);
          curLine = c === ' ' ? '' : c;
          curWidth = c === ' ' ? 0 : w;
        }

        rightBreak = -1;
        leftBreak = -1;
        continue;
      }

      curLine += c;
      curWidth += w;
      leftBreak = -1;
    }

    if (curLine.length > 0) {
      lines.push(trail ? curLine + trail : curLine);
    }

    return lines.join(brk);
  }
}

export const newlineAddParamsSchema: ProcessorParamSchema = {
  type: 'object',
  properties: {
    lineLength: {
      type: 'number',
      title: '换行长度',
      description: '超过此长度（半角字符记 0.5）后自动换行。',
      default: 40,
      minimum: 1,
    },
    lineBreak: {
      type: 'string',
      title: '换行符',
      description: '换行时插入的字符，如 \\n。',
      default: '\n',
    },
    trailingSpecialChar: {
      type: 'string',
      title: '尾部特殊字符',
      description: '在文本末尾额外追加的标记字符，留空则不追加。',
      default: '',
      placeholder: '例如：↵',
    },
  },
  required: ['lineLength', 'lineBreak'],
};

export interface TextPostProcessorRegistration {
  id: string;
  name: string;
  description: string;
  paramsSchema?: ProcessorParamSchema;
  factory: (params?: Record<string, unknown>) => TextPostProcessor;
}

export class TextPostProcessorRegistry {
  private static registrations: TextPostProcessorRegistration[] = [
    {
      id: 'quote-converter',
      name: '引号转换',
      description: '将单引号转换为『』，双引号转换为「」',
      factory: () => new QuoteConverterProcessor(),
    },
    {
      id: 'period-inside-quote-remover',
      name: '句号位置修正',
      description: '移除位于方引号结尾（」或』）前的句号',
      factory: () => new PeriodInsideQuoteRemoverProcessor(),
    },
    {
      id: 'speaker-bracket-aligner',
      name: '对话括号对齐',
      description: '根据原文是否存在【人名】标识，自动补全或移除译文中的对应标识；并镜像原文消息部分的引号包裹状态',
      factory: () => new SpeakerBracketAlignerProcessor(),
    },
    {
      id: 'character-replace',
      name: '字符替换',
      description: '根据正则表达式替换译文中的字符',
      paramsSchema: characterReplaceParamsSchema,
      factory: (params) => new CharacterReplaceProcessor(params),
    },
    {
      id: 'newline-add',
      name: '换行添加',
      description: '在指定长度处自动换行',
      paramsSchema: newlineAddParamsSchema,
      factory: (params) => new NewlineAddProcessor(params),
    },
  ];

  static getAllDescriptors(): TextPostProcessorDescriptor[] {
    return this.registrations.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      paramsSchema: r.paramsSchema,
    }));
  }

  static getProcessor(id: string): TextPostProcessor | undefined {
    const reg = this.registrations.find(r => r.id === id);
    return reg ? reg.factory() : undefined;
  }

  static createPipeline(steps: { id: string; params?: Record<string, unknown> }[]): TextPostProcessingPipeline {
    const pipeline = new TextPostProcessingPipeline();
    for (const step of steps) {
      const reg = this.registrations.find(r => r.id === step.id);
      if (reg) {
        pipeline.addProcessor(reg.factory(step.params));
      }
    }
    return pipeline;
  }
}
