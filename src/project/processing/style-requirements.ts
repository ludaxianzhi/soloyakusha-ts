export function resolveStyleRequirementsText(
  styleRequirementsText: string | undefined,
): string | undefined {
  const normalized = styleRequirementsText?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}