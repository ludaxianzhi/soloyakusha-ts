export const DEFAULT_EDITOR_REQUIREMENTS_TEXT = [
  "作为翻译而来的非本土作品，应该尽量避免过于“书面化”和“古风化”的表达。比如“若是”（应改为“如果是”），“本无此意”（太过于书面化），“虽说”，“倘若”，“吾”，“妾身”等等（除非另有说明）。",
  "修辞和成语方面，避免使用生僻或过于高雅的词汇，尽量贴近现实。适当地采用口语化的表达风格，避免阅读的割裂感。",
].join("\n");

export function resolveEditorRequirementsText(
  editorRequirementsText: string | undefined,
): string {
  const normalized = editorRequirementsText?.trim();
  return normalized && normalized.length > 0
    ? normalized
    : DEFAULT_EDITOR_REQUIREMENTS_TEXT;
}
