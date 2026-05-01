import {
  normalizeTextForGlossaryMatching,
  type GlossaryMatchEntry,
  type Glossary,
  type ResolvedGlossaryTerm,
} from "../../glossary/glossary.ts";

/**
 * 仅用于 prompt 注入路径的术语匹配：
 * 1) 第一轮扫描源文本
 * 2) 第二轮扫描第一轮命中术语的 description
 *
 * 与 Python 侧保持一致：最长匹配优先、第二轮不递归。
 */
export function matchGlossaryTermsWithCascadeForInjection(
  glossary: Glossary,
  sourceText: string,
): ResolvedGlossaryTerm[] {
  const sortedTerms = glossary
    .getTermsForMatching()
    .filter(({ normalizedTerm }) => normalizedTerm.length > 0)
    .sort(
      (left, right) =>
        right.normalizedTerm.length - left.normalizedTerm.length ||
        right.term.term.length - left.term.term.length,
    );
  const foundByTerm = new Map<string, ResolvedGlossaryTerm>();

  const firstPass = scanTextWithMask(sourceText, sortedTerms);
  for (const entry of firstPass) {
    foundByTerm.set(entry.term.term, entry.term);
  }

  const descriptions = firstPass
    .map((entry) => entry.normalizedDescription)
    .filter((description) => description.length > 0);
  if (descriptions.length > 0) {
    const secondPass = scanNormalizedTextWithMask(descriptions.join("\n"), sortedTerms);
    for (const entry of secondPass) {
      if (!foundByTerm.has(entry.term.term)) {
        foundByTerm.set(entry.term.term, entry.term);
      }
    }
  }

  for (const entry of collectReverseCascadeMatches(firstPass, sortedTerms)) {
    if (!foundByTerm.has(entry.term.term)) {
      foundByTerm.set(entry.term.term, entry.term);
    }
  }

  return [...foundByTerm.values()];
}

function scanTextWithMask(
  text: string,
  sortedTerms: ReadonlyArray<GlossaryMatchEntry>,
): GlossaryMatchEntry[] {
  return scanNormalizedTextWithMask(normalizeTextForGlossaryMatching(text), sortedTerms);
}

function scanNormalizedTextWithMask(
  normalizedText: string,
  sortedTerms: ReadonlyArray<GlossaryMatchEntry>,
): GlossaryMatchEntry[] {
  if (!normalizedText) {
    return [];
  }

  const mask = new Array<boolean>(normalizedText.length).fill(false);
  const found: GlossaryMatchEntry[] = [];

  for (const term of sortedTerms) {
    const termText = term.normalizedTerm;
    const termLength = termText.length;
    if (termLength === 0) {
      continue;
    }

    let searchStart = 0;
    while (searchStart < normalizedText.length) {
      const index = normalizedText.indexOf(termText, searchStart);
      if (index === -1) {
        break;
      }

      const end = index + termLength;
      if (!isMasked(mask, index, end)) {
        fillMask(mask, index, end);
        found.push(term);
      }

      searchStart = index + 1;
    }
  }

  return found;
}

function collectReverseCascadeMatches(
  firstPass: ReadonlyArray<GlossaryMatchEntry>,
  allTerms: ReadonlyArray<GlossaryMatchEntry>,
): GlossaryMatchEntry[] {
  if (firstPass.length === 0) {
    return [];
  }

  const matchedSeeds = new Set(firstPass.map((entry) => entry.term.term));
  const reverseMatches: GlossaryMatchEntry[] = [];
  for (const candidate of allTerms) {
    if (matchedSeeds.has(candidate.term.term) || candidate.normalizedDescription.length === 0) {
      continue;
    }

    for (const seed of firstPass) {
      if (
        seed.normalizedTerm.length > 0 &&
        candidate.normalizedDescription.includes(seed.normalizedTerm)
      ) {
        reverseMatches.push(candidate);
        break;
      }
    }
  }

  return reverseMatches;
}

function isMasked(mask: ReadonlyArray<boolean>, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (mask[index]) {
      return true;
    }
  }
  return false;
}

function fillMask(mask: boolean[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    mask[index] = true;
  }
}
