import { describe, expect, test } from "bun:test";
import { Glossary } from "../../glossary/glossary.ts";
import { matchGlossaryTermsWithCascadeForInjection } from "./glossary-cascade-matcher.ts";

describe("matchGlossaryTermsWithCascadeForInjection", () => {
  test("includes secondary terms discovered from first-pass descriptions", () => {
    const glossary = new Glossary([
      { term: "勇者", translation: "Hero", description: "身份：陛下" },
      { term: "陛下", translation: "Your Majesty" },
    ]);

    const matched = matchGlossaryTermsWithCascadeForInjection(glossary, "勇者出发了");
    const directMatched = glossary.filterTerms("勇者出发了");

    expect(matched.map((term) => term.term)).toEqual(["勇者", "陛下"]);
    expect(directMatched.map((term) => term.term)).toEqual(["勇者"]);
  });

  test("matches source text and descriptions after punctuation normalization", () => {
    const glossary = new Glossary([
      { term: "王都", translation: "Royal Capital", description: "情绪：すごーい！" },
      { term: "すごい", translation: "Amazing" },
    ]);

    const matched = matchGlossaryTermsWithCascadeForInjection(glossary, "王～都だ！！！");

    expect(matched.map((term) => term.term)).toEqual(["王都", "すごい"]);
  });

  test("includes reverse cascade matches from descriptions that mention first-pass terms", () => {
    const glossary = new Glossary([
      { term: "勇者", translation: "Hero" },
      { term: "公会登记员", translation: "Guild Clerk", description: "专门接待勇～者！" },
      { term: "圣剑", translation: "Holy Sword", description: "常与公会登记员一起被提及" },
    ]);

    const matched = matchGlossaryTermsWithCascadeForInjection(glossary, "勇者来了");

    expect(matched.map((term) => term.term)).toEqual(["勇者", "公会登记员"]);
  });

  test("does not recurse beyond the second pass", () => {
    const glossary = new Glossary([
      { term: "勇者", translation: "Hero", description: "提到：陛下" },
      { term: "陛下", translation: "Your Majesty", description: "又提到：圣剑" },
      { term: "圣剑", translation: "Holy Sword" },
    ]);

    const matched = matchGlossaryTermsWithCascadeForInjection(glossary, "勇者出发了");

    expect(matched.map((term) => term.term)).toEqual(["勇者", "陛下"]);
  });

  test("prefers longest matches and avoids shorter overlapping terms in the same pass", () => {
    const glossary = new Glossary([
      { term: "王", translation: "King" },
      { term: "王都", translation: "Royal Capital" },
    ]);

    const matched = matchGlossaryTermsWithCascadeForInjection(glossary, "王都风景");

    expect(matched.map((term) => term.term)).toEqual(["王都"]);
  });

  test("returns empty when source text has no first-pass matches", () => {
    const glossary = new Glossary([
      { term: "勇者", translation: "Hero", description: "身份：陛下" },
      { term: "陛下", translation: "Your Majesty" },
    ]);

    const matched = matchGlossaryTermsWithCascadeForInjection(glossary, "无关文本");

    expect(matched).toEqual([]);
  });
});
