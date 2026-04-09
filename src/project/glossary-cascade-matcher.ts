import type { Glossary, ResolvedGlossaryTerm } from "../glossary/glossary.ts";

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
    .getAllTerms()
    .sort((left, right) => right.term.length - left.term.length);
  const foundByTerm = new Map<string, ResolvedGlossaryTerm>();

  const firstPass = scanTextWithMask(sourceText, sortedTerms);
  for (const term of firstPass) {
    foundByTerm.set(term.term, term);
  }

  const descriptions = firstPass
    .map((term) => term.description?.trim())
    .filter((description): description is string => Boolean(description));
  if (descriptions.length === 0) {
    return [...foundByTerm.values()];
  }

  const secondPass = scanTextWithMask(descriptions.join("\n"), sortedTerms);
  for (const term of secondPass) {
    if (!foundByTerm.has(term.term)) {
      foundByTerm.set(term.term, term);
    }
  }

  return [...foundByTerm.values()];
}

function scanTextWithMask(
  text: string,
  sortedTerms: ReadonlyArray<ResolvedGlossaryTerm>,
): ResolvedGlossaryTerm[] {
  if (!text) {
    return [];
  }

  const mask = new Array<boolean>(text.length).fill(false);
  const found: ResolvedGlossaryTerm[] = [];

  for (const term of sortedTerms) {
    const termText = term.term;
    const termLength = termText.length;
    if (termLength === 0) {
      continue;
    }

    let searchStart = 0;
    while (searchStart < text.length) {
      const index = text.indexOf(termText, searchStart);
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
