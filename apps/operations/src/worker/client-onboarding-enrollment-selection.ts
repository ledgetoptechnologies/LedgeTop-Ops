const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_SOURCES = 16;

/**
 * Validates the only caller-owned portion of a future onboarding enrollment.
 * It returns a new canonical list; destination identity remains server-owned.
 */
export function parseClientOnboardingEnrollmentSourceIds(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_SOURCES
    || value.some(sourceId => typeof sourceId !== "string" || !SOURCE_ID.test(sourceId))) return null;
  const canonical = [...value].sort() as string[];
  return new Set(canonical).size === canonical.length ? Object.freeze(canonical) : null;
}
