/**
 * 提供“全局关联模式扫描”能力：在原文全文中查找重复出现的长模式。
 *
 * 设计原则：
 * - 只处理原文全文，不关注译文
 * - 扫描器只负责发现重复模式，不直接依赖 glossary
 * - 使用后缀自动机（Suffix Automaton）以较高效率统计重复子串
 *
 * @module project/global-pattern-scanner
 */

export const DEFAULT_GLOBAL_PATTERN_MIN_OCCURRENCES = 3;
export const DEFAULT_GLOBAL_PATTERN_MIN_LENGTH = 8;

export type GlobalAssociationPattern = {
  text: string;
  length: number;
  occurrenceCount: number;
  firstIndex: number;
};

export type GlobalAssociationPatternScanOptions = {
  minOccurrences?: number;
  minLength?: number;
  maxResults?: number;
};

export type GlobalAssociationPatternScanResult = {
  fullTextLength: number;
  patterns: GlobalAssociationPattern[];
};

type SuffixAutomatonState = {
  next: Map<string, number>;
  link: number;
  maxLength: number;
  occurrenceCount: number;
  firstPosition: number;
};

export class GlobalAssociationPatternScanner {
  scanText(
    sourceText: string,
    options: GlobalAssociationPatternScanOptions = {},
  ): GlobalAssociationPatternScanResult {
    const minOccurrences = normalizePositiveInteger(
      options.minOccurrences,
      DEFAULT_GLOBAL_PATTERN_MIN_OCCURRENCES,
      "minOccurrences",
    );
    const minLength = normalizePositiveInteger(
      options.minLength,
      DEFAULT_GLOBAL_PATTERN_MIN_LENGTH,
      "minLength",
    );
    const maxResults =
      typeof options.maxResults === "number"
        ? normalizePositiveInteger(options.maxResults, options.maxResults, "maxResults")
        : undefined;

    const characters = Array.from(sourceText);
    if (characters.length === 0) {
      return {
        fullTextLength: 0,
        patterns: [],
      };
    }

    const states = buildSuffixAutomaton(characters);
    propagateOccurrenceCounts(states, characters.length);
    const candidates = collectCandidatePatterns(states, characters, {
      minOccurrences,
      minLength,
    });

    return {
      fullTextLength: characters.length,
      patterns: filterRedundantPatterns(candidates, maxResults),
    };
  }
}

function buildSuffixAutomaton(characters: string[]): SuffixAutomatonState[] {
  const states: SuffixAutomatonState[] = [createState()];
  let lastStateIndex = 0;

  for (const [position, character] of characters.entries()) {
    lastStateIndex = extendSuffixAutomaton(states, lastStateIndex, character, position);
  }

  return states;
}

function createState(): SuffixAutomatonState {
  return {
    next: new Map<string, number>(),
    link: -1,
    maxLength: 0,
    occurrenceCount: 0,
    firstPosition: -1,
  };
}

function extendSuffixAutomaton(
  states: SuffixAutomatonState[],
  lastStateIndex: number,
  character: string,
  position: number,
): number {
  const currentStateIndex = states.length;
  states.push({
    next: new Map<string, number>(),
    link: 0,
    maxLength: states[lastStateIndex]!.maxLength + 1,
    occurrenceCount: 1,
    firstPosition: position,
  });

  let previousStateIndex = lastStateIndex;
  while (
    previousStateIndex !== -1 &&
    !states[previousStateIndex]!.next.has(character)
  ) {
    states[previousStateIndex]!.next.set(character, currentStateIndex);
    previousStateIndex = states[previousStateIndex]!.link;
  }

  if (previousStateIndex === -1) {
    states[currentStateIndex]!.link = 0;
    return currentStateIndex;
  }

  const nextStateIndex = states[previousStateIndex]!.next.get(character)!;
  if (
    states[previousStateIndex]!.maxLength + 1 ===
    states[nextStateIndex]!.maxLength
  ) {
    states[currentStateIndex]!.link = nextStateIndex;
    return currentStateIndex;
  }

  const cloneStateIndex = states.length;
  states.push({
    next: new Map(states[nextStateIndex]!.next),
    link: states[nextStateIndex]!.link,
    maxLength: states[previousStateIndex]!.maxLength + 1,
    occurrenceCount: 0,
    firstPosition: states[nextStateIndex]!.firstPosition,
  });

  while (
    previousStateIndex !== -1 &&
    states[previousStateIndex]!.next.get(character) === nextStateIndex
  ) {
    states[previousStateIndex]!.next.set(character, cloneStateIndex);
    previousStateIndex = states[previousStateIndex]!.link;
  }

  states[nextStateIndex]!.link = cloneStateIndex;
  states[currentStateIndex]!.link = cloneStateIndex;
  return currentStateIndex;
}

function propagateOccurrenceCounts(
  states: SuffixAutomatonState[],
  maxLength: number,
): void {
  const buckets = Array.from({ length: maxLength + 1 }, () => [] as number[]);
  for (const [index, state] of states.entries()) {
    buckets[state.maxLength]!.push(index);
  }

  for (let length = buckets.length - 1; length >= 0; length -= 1) {
    for (const stateIndex of buckets[length]!) {
      const linkIndex = states[stateIndex]!.link;
      if (linkIndex >= 0) {
        states[linkIndex]!.occurrenceCount += states[stateIndex]!.occurrenceCount;
      }
    }
  }
}

function collectCandidatePatterns(
  states: SuffixAutomatonState[],
  characters: string[],
  options: Required<Pick<GlobalAssociationPatternScanOptions, "minOccurrences" | "minLength">>,
): GlobalAssociationPattern[] {
  const deduplicated = new Map<string, GlobalAssociationPattern>();

  for (let stateIndex = 1; stateIndex < states.length; stateIndex += 1) {
    const state = states[stateIndex]!;
    if (
      state.occurrenceCount < options.minOccurrences ||
      state.maxLength < options.minLength
    ) {
      continue;
    }

    const startIndex = state.firstPosition - state.maxLength + 1;
    if (startIndex < 0) {
      continue;
    }

    const text = characters.slice(startIndex, state.firstPosition + 1).join("");
    if (!isEligiblePattern(text, options.minLength)) {
      continue;
    }

    const candidate: GlobalAssociationPattern = {
      text,
      length: state.maxLength,
      occurrenceCount: state.occurrenceCount,
      firstIndex: startIndex,
    };

    const existing = deduplicated.get(candidate.text);
    if (!existing || isBetterCandidate(candidate, existing)) {
      deduplicated.set(candidate.text, candidate);
    }
  }

  return [...deduplicated.values()].sort(comparePatterns);
}

function filterRedundantPatterns(
  patterns: GlobalAssociationPattern[],
  maxResults?: number,
): GlobalAssociationPattern[] {
  const filtered: GlobalAssociationPattern[] = [];

  for (const pattern of patterns) {
    const coveredByLongerPattern = filtered.some(
      (existing) =>
        existing.occurrenceCount === pattern.occurrenceCount &&
        existing.text.includes(pattern.text),
    );
    if (coveredByLongerPattern) {
      continue;
    }

    filtered.push(pattern);
    if (typeof maxResults === "number" && filtered.length >= maxResults) {
      break;
    }
  }

  return filtered;
}

function isEligiblePattern(text: string, minLength: number): boolean {
  if (text.length < minLength) {
    return false;
  }

  if (/[\r\n]/.test(text)) {
    return false;
  }

  if (text.trim().length < minLength) {
    return false;
  }

  return text.trim() === text;
}

function isBetterCandidate(
  left: GlobalAssociationPattern,
  right: GlobalAssociationPattern,
): boolean {
  return comparePatterns(left, right) < 0;
}

function comparePatterns(
  left: GlobalAssociationPattern,
  right: GlobalAssociationPattern,
): number {
  return (
    right.length - left.length ||
    right.occurrenceCount - left.occurrenceCount ||
    left.firstIndex - right.firstIndex ||
    left.text.localeCompare(right.text)
  );
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} 必须为正整数`);
  }

  return resolved;
}
