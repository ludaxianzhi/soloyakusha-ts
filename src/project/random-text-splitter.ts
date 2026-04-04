import type { TranslationUnit, TranslationUnitSplitter } from "./types.ts";

type RandomTextSplitterOptions = {
  standardDeviation?: number;
  random?: () => number;
};

export class RandomTextSplitter implements TranslationUnitSplitter {
  private readonly standardDeviation: number;
  private readonly random: () => number;

  constructor(
    private readonly maxChars = 2000,
    options: RandomTextSplitterOptions = {},
  ) {
    if (!Number.isInteger(maxChars) || maxChars <= 0) {
      throw new Error(`maxChars 必须是正整数: ${maxChars}`);
    }

    const standardDeviation = options.standardDeviation ?? Math.max(1, maxChars / 3);
    if (!Number.isFinite(standardDeviation) || standardDeviation < 0) {
      throw new Error(`standardDeviation 必须是非负数: ${standardDeviation}`);
    }

    this.standardDeviation = standardDeviation;
    this.random = options.random ?? Math.random;
  }

  split(units: TranslationUnit[]): TranslationUnit[][] {
    if (units.length === 0) {
      return [];
    }

    const fragments: TranslationUnit[][] = [];
    let currentFragment: TranslationUnit[] = [];
    let currentLength = 0;
    let targetLength = this.sampleChunkLength();

    for (const unit of units) {
      const unitLength = unit.source.length;
      if (currentFragment.length > 0 && currentLength + unitLength > targetLength) {
        fragments.push(currentFragment);
        currentFragment = [];
        currentLength = 0;
        targetLength = this.sampleChunkLength();
      }

      currentFragment.push(unit);
      currentLength += unitLength;
    }

    if (currentFragment.length > 0) {
      fragments.push(currentFragment);
    }

    return fragments;
  }

  private sampleChunkLength(): number {
    if (this.standardDeviation === 0) {
      return this.maxChars;
    }

    const sampled = Math.round(
      this.maxChars - Math.abs(sampleStandardNormal(this.random)) * this.standardDeviation,
    );
    return Math.min(this.maxChars, Math.max(1, sampled));
  }
}

function sampleStandardNormal(random: () => number): number {
  const u1 = Math.max(random(), Number.EPSILON);
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
