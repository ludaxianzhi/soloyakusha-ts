export type GlossaryTerm = {
  term: string;
  translation: string;
  description?: string;
};

export class Glossary {
  private readonly terms = new Map<string, GlossaryTerm>();

  constructor(terms: GlossaryTerm[] = []) {
    for (const term of terms) {
      this.terms.set(term.term, term);
    }
  }

  getAllTerms(): GlossaryTerm[] {
    return [...this.terms.values()];
  }

  addTerm(term: GlossaryTerm): void {
    this.terms.set(term.term, term);
  }

  removeTerm(termText: string): void {
    this.terms.delete(termText);
  }

  updateTerm(termText: string, newTerm: GlossaryTerm): void {
    if (termText !== newTerm.term) {
      this.terms.delete(termText);
    }
    this.terms.set(newTerm.term, newTerm);
  }

  filterTerms(text: string): GlossaryTerm[] {
    return this.getAllTerms().filter((term) => text.includes(term.term));
  }

  renderAsCsv(terms: GlossaryTerm[] = this.getAllTerms()): string {
    const lines = ["Term, Translation, Description"];
    for (const term of terms) {
      lines.push(
        `${term.term}, ${term.translation}, ${term.description ?? ""}`,
      );
    }
    return lines.join("\n");
  }

  filterAndRenderAsCsv(text: string): string {
    return this.renderAsCsv(this.filterTerms(text));
  }
}
