/**
 * 提供内存中的术语表模型，负责术语增删查改、筛选与渲染。
 *
 * 本模块实现 {@link Glossary} 类，用于：
 * - 维护术语（原文）与译文的映射关系
 * - 根据原文内容筛选相关术语
 * - 渲染术语表为 CSV 格式供 LLM 参考
 *
 * 术语条目包含：term（原文）、translation（译文）、description（可选说明）。
 *
 * @module glossary/glossary
 */

export type GlossaryTerm = {
  term: string;
  translation: string;
  description?: string;
};

/**
 * 术语表模型，负责维护术语集合并按上下文筛选、渲染可用条目。
 *
 * 核心功能：
 * - getAllTerms: 获取全部术语
 * - addTerm / removeTerm / updateTerm: 术语增删改
 * - filterTerms: 按文本内容筛选相关术语
 * - renderAsCsv / filterAndRenderAsCsv: 渲染为 CSV 格式
 *
 * 筛选逻辑：检查文本是否包含术语原文，用于在翻译上下文中提供相关术语参考。
 */
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
