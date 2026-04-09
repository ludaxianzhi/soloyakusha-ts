import { deflateSync } from "node:zlib";
import { ThinkingLoopError } from "./types.ts";

export type ThinkingLoopDetectorOptions = {
  windowSize?: number;
  checkIntervalChars?: number;
  ratioThreshold?: number;
  minChars?: number;
  consecutiveHits?: number;
  tailCheckChars?: number;
  tailRepeatMin?: number;
};

const DEFAULT_OPTIONS: Required<ThinkingLoopDetectorOptions> = {
  windowSize: 8_000,
  checkIntervalChars: 2_000,
  ratioThreshold: 0.22,
  minChars: 6_000,
  consecutiveHits: 3,
  tailCheckChars: 180,
  tailRepeatMin: 3,
};

/**
 * 检测模型 reasoning/thinking 流是否进入重复死循环。
 */
export class ThinkingLoopDetector {
  private readonly options: Required<ThinkingLoopDetectorOptions>;
  private thinkingChars = 0;
  private charsSinceCheck = 0;
  private consecutiveHits = 0;
  private thinkingBuffer = "";

  constructor(options: ThinkingLoopDetectorOptions = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
  }

  addThinkingText(text: string): void {
    if (!text) {
      return;
    }

    const deltaChars = text.length;
    this.thinkingChars += deltaChars;
    this.thinkingBuffer = (this.thinkingBuffer + text).slice(-this.options.windowSize);
    this.charsSinceCheck += deltaChars;

    if (this.thinkingChars < this.options.minChars) {
      return;
    }

    if (this.charsSinceCheck < this.options.checkIntervalChars) {
      return;
    }

    this.charsSinceCheck = 0;

    const bufferBytes = Buffer.from(this.thinkingBuffer, "utf8");
    if (bufferBytes.length < 100) {
      return;
    }

    const compressed = deflateSync(bufferBytes);
    const ratio = compressed.length / bufferBytes.length;
    const tailRepeated = this.hasRepeatedTail();

    if (ratio < this.options.ratioThreshold && tailRepeated) {
      this.consecutiveHits += 1;
      if (this.consecutiveHits >= this.options.consecutiveHits) {
        throw new ThinkingLoopError(
          `检测到思考死循环：压缩比 ${ratio.toFixed(3)} 连续 ${this.consecutiveHits} 次低于阈值 ${this.options.ratioThreshold}，已接收 ${this.thinkingChars} 字符`,
        );
      }
      return;
    }

    this.consecutiveHits = 0;
  }

  private hasRepeatedTail(): boolean {
    if (this.thinkingBuffer.length < this.options.tailCheckChars * 2) {
      return false;
    }

    const tail = this.thinkingBuffer.slice(-this.options.tailCheckChars);
    if (!tail) {
      return false;
    }

    return countSubstringOccurrences(this.thinkingBuffer, tail) >= this.options.tailRepeatMin;
  }
}

function countSubstringOccurrences(content: string, target: string): number {
  if (!target) {
    return 0;
  }

  let index = 0;
  let count = 0;
  while (index <= content.length - target.length) {
    const foundAt = content.indexOf(target, index);
    if (foundAt === -1) {
      break;
    }
    count += 1;
    index = foundAt + target.length;
  }

  return count;
}
